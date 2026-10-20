import {
  type ProviderBillingEvent,
  ProviderNotFoundError,
  type UnresolvedProviderEvent,
} from "../provider-port";
import type { WooviClient } from "./client";
import { isWooviGlobalId, wooviLogId } from "./ids";
import {
  mapWooviInstallmentEvent,
  mapWooviSubscriptionEvent,
  pickWooviInstallment,
  pickWooviSubscription,
  wooviEventId,
  type WooviStateNotShown,
  wooviEventKind,
  wooviStateNotShown,
} from "./mapper";

/**
 * The inbound side of Woovi (ADR 0101, emenda Woovi). The adapter checks the
 * RSA signature over the raw bytes first (`signature.ts`); only then is the
 * body parsed, and of it only the event's name and the `globalID` of the
 * resource are read. The resource is read back from the API with Polaris's
 * AppID and the fact comes from what it shows: a delivery signed by Woovi for
 * another Woovi account names a resource this account does not have (404).
 */

/** What is read of a webhook body: the event name and the resource's ID. Nothing else. */
export interface WooviWebhookEnvelope {
  eventType: string;
  /** The resource's ID as it goes to a log (decoded, see `wooviLogId`); null with no resource. */
  logId: string | null;
  /** The `globalID` the event is about, checked against its kind; null for an event that needs none. */
  resourceId: string | null;
}

const eventTypePattern = /^[A-Z][A-Z_:]{0,63}$/;

/**
 * What one pass over an authentic body gives: its envelope, or null when it is
 * not one Woovi documents; and, then, the name of the event when it would give
 * a fact (its `globalID` missing or of another shape), so the log says which
 * kind of event may have been lost. Only the name, already checked against its
 * pattern.
 */
export interface WooviWebhookReading {
  envelope: WooviWebhookEnvelope | null;
  refusedFactEvent: string | null;
}

export function inspectWooviWebhook(rawBody: string): WooviWebhookReading {
  const refused = (refusedFactEvent: string | null): WooviWebhookReading => ({
    envelope: null,
    refusedFactEvent,
  });
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return refused(null);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return refused(null);
  }
  const { event, globalID } = body as Record<string, unknown>;
  if (typeof event !== "string" || !eventTypePattern.test(event)) {
    return refused(null);
  }
  const kind = wooviEventKind(event);
  if (kind === "ignored") {
    return {
      envelope: { eventType: event, logId: null, resourceId: null },
      refusedFactEvent: null,
    };
  }
  // an event that needs a resource must name one of that kind
  return isWooviGlobalId(kind, globalID)
    ? {
        envelope: {
          eventType: event,
          logId: wooviLogId(kind, globalID),
          resourceId: globalID,
        },
        refusedFactEvent: null,
      }
    : refused(event);
}

/** The envelope of a body already proven to come from Woovi, or null when it is not one Woovi documents. */
export function readWooviWebhook(rawBody: string): WooviWebhookEnvelope | null {
  return inspectWooviWebhook(rawBody).envelope;
}

function unresolved(
  envelope: WooviWebhookEnvelope,
  missing: { id: string; kind: "installment" | "subscription" },
  now: Date
): UnresolvedProviderEvent {
  return {
    eventType: envelope.eventType,
    kind: "unresolved",
    // Woovi's body has no time of the event, so it never counts as recent: a
    // resource this account does not have is acknowledged and logged as an
    // error for the reconciliation, never refused in a loop (the read back was
    // consistent at once in the sandbox, spike t092)
    occurredAt: now,
    occurredAtClamped: true,
    providerEventId: wooviEventId(
      envelope.eventType,
      envelope.resourceId ?? ""
    ),
    // only logged: decoded, or the log's redaction would mask it as a token
    resourceId: wooviLogId(missing.kind, missing.id),
  };
}

/**
 * An event that should have given a fact and did not (see
 * `wooviStateNotShown`): the codes of what the read back shows, and the
 * decoded ID of the subscription it ties to when there is one. Never a body or
 * a person's data.
 */
export type WooviStateNotShownReport = Partial<WooviStateNotShown> & {
  subscriptionLogId?: string;
};

/**
 * Reads back the resource the event names and maps it. A resource the API does
 * not find (404) is an `unresolved` event, never a dropped one (AC-48); an API
 * that is down or refuses the AppID throws, so the delivery is answered with a
 * 503 and Woovi sends it again. The time of the fact is `now`: Woovi's body
 * says when the installment or the subscription was created, not when the
 * event happened. An event that maps to no fact although the resource should
 * show one is still answered with no events, and reported to `onStateNotShown`
 * so the caller leaves a trace of a payment that may be lost.
 */
export async function resolveWooviWebhook(
  client: WooviClient,
  envelope: WooviWebhookEnvelope,
  now = new Date(),
  onStateNotShown: (report: WooviStateNotShownReport) => void = () => undefined
): Promise<ProviderBillingEvent[] | UnresolvedProviderEvent> {
  const kind = wooviEventKind(envelope.eventType);
  if (kind === "ignored" || envelope.resourceId === null) {
    return [];
  }
  let missing: { id: string; kind: "installment" | "subscription" } = {
    id: envelope.resourceId,
    kind,
  };
  try {
    if (kind === "subscription") {
      const subscription = pickWooviSubscription(
        await client.getSubscription(missing.id)
      );
      if (subscription.id !== envelope.resourceId) {
        onStateNotShown({});
        return [];
      }
      const events = mapWooviSubscriptionEvent({
        eventType: envelope.eventType,
        occurredAt: now,
        subscription,
      });
      const notShown =
        events.length === 0
          ? wooviStateNotShown({ eventType: envelope.eventType, subscription })
          : null;
      if (notShown) {
        onStateNotShown(notShown);
      }
      return events;
    }
    const installment = pickWooviInstallment(
      await client.getInstallment(missing.id)
    );
    if (installment.id !== envelope.resourceId) {
      onStateNotShown({});
      return [];
    }
    // the subscription comes from the installment read back, never from the body
    missing = { id: installment.subscriptionId, kind: "subscription" };
    const subscription = pickWooviSubscription(
      await client.getSubscription(missing.id)
    );
    const events = mapWooviInstallmentEvent({
      eventType: envelope.eventType,
      installment,
      occurredAt: now,
      subscription,
    });
    const notShown =
      events.length === 0
        ? wooviStateNotShown({
            eventType: envelope.eventType,
            installment,
            subscription,
          })
        : null;
    if (notShown) {
      onStateNotShown({
        ...notShown,
        subscriptionLogId: wooviLogId("subscription", subscription.id),
      });
    }
    return events;
  } catch (error: unknown) {
    if (error instanceof ProviderNotFoundError) {
      return unresolved(envelope, missing, now);
    }
    throw error;
  }
}
