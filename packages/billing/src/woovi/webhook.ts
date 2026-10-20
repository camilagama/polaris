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
  wooviEventKind,
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

/** The envelope of a body already proven to come from Woovi, or null when it is not one Woovi documents. */
export function readWooviWebhook(rawBody: string): WooviWebhookEnvelope | null {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const { event, globalID } = body as Record<string, unknown>;
  if (typeof event !== "string" || !eventTypePattern.test(event)) {
    return null;
  }
  const kind = wooviEventKind(event);
  if (kind === "ignored") {
    return { eventType: event, logId: null, resourceId: null };
  }
  // an event that needs a resource must name one of that kind
  return isWooviGlobalId(kind, globalID)
    ? {
        eventType: event,
        logId: wooviLogId(kind, globalID),
        resourceId: globalID,
      }
    : null;
}

/**
 * The name of an event that would give a fact, read from a body that
 * `readWooviWebhook` refused (its `globalID` missing or of another shape), so
 * the log says which kind of event was lost. Only the name, already checked
 * against its pattern; null for anything else.
 */
export function wooviRefusedFactEvent(rawBody: string): string | null {
  try {
    const { event } = JSON.parse(rawBody) as Record<string, unknown>;
    return typeof event === "string" && wooviEventKind(event) !== "ignored"
      ? event
      : null;
  } catch {
    return null;
  }
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
 * Reads back the resource the event names and maps it. A resource the API does
 * not find (404) is an `unresolved` event, never a dropped one (AC-48); an API
 * that is down or refuses the AppID throws, so the delivery is answered with a
 * 503 and Woovi sends it again. The time of the fact is `now`: Woovi's body
 * says when the installment or the subscription was created, not when the
 * event happened.
 */
export async function resolveWooviWebhook(
  client: WooviClient,
  envelope: WooviWebhookEnvelope,
  now = new Date()
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
        return [];
      }
      return mapWooviSubscriptionEvent({
        eventType: envelope.eventType,
        occurredAt: now,
        subscription,
      });
    }
    const installment = pickWooviInstallment(
      await client.getInstallment(missing.id)
    );
    if (installment.id !== envelope.resourceId) {
      return [];
    }
    // the subscription comes from the installment read back, never from the body
    missing = { id: installment.subscriptionId, kind: "subscription" };
    const subscription = pickWooviSubscription(
      await client.getSubscription(missing.id)
    );
    return mapWooviInstallmentEvent({
      eventType: envelope.eventType,
      installment,
      occurredAt: now,
      subscription,
    });
  } catch (error: unknown) {
    if (error instanceof ProviderNotFoundError) {
      return unresolved(envelope, missing, now);
    }
    throw error;
  }
}
