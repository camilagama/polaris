import {
  type ProviderBillingEvent,
  ProviderNotFoundError,
  type UnresolvedProviderEvent,
} from "../provider-port";
import type { AsaasClient } from "./client";
import { isAsaasEventId, isAsaasId, isPolarisReference } from "./ids";
import {
  asaasEventKind,
  mapAsaasCheckoutPaid,
  mapAsaasPaymentEvent,
  mapAsaasSubscriptionEvent,
  pickAsaasPayment,
  pickAsaasSubscription,
} from "./mapper";

/**
 * The inbound side of Asaas (ADR 0101). Asaas proves a webhook with a static
 * token (`asaas-access-token`) and does not sign the body, so the body is never
 * trusted for a fact: it gives the event's ID, name and time and the ID of the
 * resource, and the resource is read back from the API with Polaris's key. A
 * forged body can then only point at real resources of Polaris's own account,
 * and what they show is what counts.
 */

/** What is read of a webhook body: IDs, the event name and its time. Nothing else. */
export interface AsaasWebhookEnvelope {
  /** The reference of a finished checkout (`CHECKOUT_PAID`), checked against the `pol_<uuid>` shape. */
  checkoutReference: string | null;
  /** True when the body's time was ahead of the clock and `occurredAt` was cut down to the present. */
  dateClamped: boolean;
  eventId: string;
  eventType: string;
  /** The time the body claims, never later than the present (a body dated in the future is cut down to it). */
  occurredAt: Date;
  paymentId: string | null;
  subscriptionId: string | null;
}

const encoder = new TextEncoder();

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(value))
  );
}

/**
 * Compares the received token with each accepted one (the current and, during a
 * rotation, the next) in constant time: both sides are hashed first, so the
 * comparison always reads 32 bytes, whatever the length and wherever they differ.
 */
export async function asaasTokenMatches(
  received: string | null,
  accepted: readonly string[]
): Promise<boolean> {
  if (received === null || received.length === 0) {
    return false;
  }
  const given = await digest(received);
  let matched = false;
  for (const candidate of accepted) {
    if (candidate.length === 0) {
      continue;
    }
    // biome-ignore lint/performance/noAwaitInLoops: At most two tokens, compared one after the other.
    const expected = await digest(candidate);
    let difference = 0;
    for (let index = 0; index < expected.length; index += 1) {
      // biome-ignore lint/suspicious/noBitwiseOperators: A constant-time comparison is bitwise by nature.
      difference |= (expected[index] ?? 0) ^ (given[index] ?? 0);
    }
    matched = matched || difference === 0;
  }
  return matched;
}

/** `AAAA-MM-DD hh:mm:ss`, in Brasília time (UTC−3, no daylight saving time since 2019). */
const asaasDateTimePattern = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
/** A body time this far ahead of the clock is clock skew; further than that it is cut down to the present. */
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const eventTypePattern = /^[A-Z][A-Z_]{0,63}$/;

function nestedId(body: Record<string, unknown>, key: string): unknown {
  const value = body[key];
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return (value as Record<string, unknown>).id;
  }
  return undefined;
}

/** The envelope of a webhook body, or null when it is not one Asaas documents. */
export function readAsaasWebhook(
  rawBody: string,
  now = new Date()
): AsaasWebhookEnvelope | null {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const fields = body as Record<string, unknown>;
  const { dateCreated, event, id } = fields;
  if (
    !isAsaasEventId(id) ||
    typeof event !== "string" ||
    !eventTypePattern.test(event) ||
    typeof dateCreated !== "string"
  ) {
    return null;
  }
  const time = asaasDateTimePattern.exec(dateCreated);
  const claimedAt = time
    ? new Date(`${time[1]}T${time[2]}.000-03:00`)
    : new Date(Number.NaN);
  if (Number.isNaN(claimedAt.getTime())) {
    return null;
  }
  // the token does not sign the body: its time is never a reason to refuse the
  // delivery (a 503 loop pauses the webhook), only to cut it down to now
  const dateClamped = claimedAt.getTime() - now.getTime() > MAX_FUTURE_SKEW_MS;
  const occurredAt = dateClamped ? now : claimedAt;
  const paymentId = nestedId(fields, "payment");
  const subscriptionId = nestedId(fields, "subscription");
  const { checkout } = fields;
  const checkoutReference =
    typeof checkout === "object" && checkout !== null
      ? (checkout as Record<string, unknown>).externalReference
      : undefined;
  const envelope: AsaasWebhookEnvelope = {
    checkoutReference: isPolarisReference(checkoutReference)
      ? checkoutReference
      : null,
    dateClamped,
    eventId: id,
    eventType: event,
    occurredAt,
    paymentId: isAsaasId("pay", paymentId) ? (paymentId as string) : null,
    subscriptionId: isAsaasId("sub", subscriptionId)
      ? (subscriptionId as string)
      : null,
  };
  // an event that needs a resource must name one in the expected shape
  const needed = {
    checkout: envelope.checkoutReference,
    ignored: "",
    payment: envelope.paymentId,
    subscription: envelope.subscriptionId,
  }[asaasEventKind(event)];
  return needed === null ? null : envelope;
}

function unresolved(
  envelope: AsaasWebhookEnvelope,
  resourceId: string
): UnresolvedProviderEvent {
  return {
    eventType: envelope.eventType,
    kind: "unresolved",
    // a cut-down date restarts at every delivery: it never counts as recent
    ...(envelope.dateClamped ? { occurredAtClamped: true as const } : {}),
    occurredAt: envelope.occurredAt,
    providerEventId: envelope.eventId,
    resourceId,
  };
}

/**
 * Reads back the resource the event names and maps it. A resource the API does
 * not find (404) is an `unresolved` event, never a dropped one (AC-48); an API
 * that is down or refuses the key throws, so the delivery is answered with a
 * 503 and Asaas sends it again.
 */
export async function resolveAsaasWebhook(
  client: AsaasClient,
  envelope: AsaasWebhookEnvelope,
  now = new Date()
): Promise<ProviderBillingEvent[] | UnresolvedProviderEvent> {
  const kind = asaasEventKind(envelope.eventType);
  const meta = {
    occurredAt: envelope.occurredAt,
    providerEventId: envelope.eventId,
  };
  let missing = "";
  try {
    if (kind === "payment") {
      missing = envelope.paymentId as string;
      const payment = pickAsaasPayment(await client.getPayment(missing));
      if (payment.subscriptionId === null || payment.deleted) {
        return [];
      }
      missing = payment.subscriptionId;
      const subscription = pickAsaasSubscription(
        await client.getSubscription(missing)
      );
      return mapAsaasPaymentEvent({
        ...meta,
        eventType: envelope.eventType,
        now,
        payment,
        subscription,
      });
    }
    if (kind === "subscription") {
      missing = envelope.subscriptionId as string;
      const subscription = pickAsaasSubscription(
        await client.getSubscription(missing)
      );
      return mapAsaasSubscriptionEvent({ ...meta, subscription });
    }
    if (kind === "checkout") {
      const reference = envelope.checkoutReference as string;
      const subscriptions = (
        await client.listSubscriptionsByReference(reference)
      ).map(pickAsaasSubscription);
      const subscription =
        subscriptions.find((entry) => !entry.deleted) ?? subscriptions[0];
      if (!subscription) {
        return unresolved(envelope, reference);
      }
      missing = subscription.id;
      const payments = (
        await client.listSubscriptionPayments(subscription.id)
      ).map(pickAsaasPayment);
      if (payments.length === 0) {
        // the subscription is created with its first charge: none yet is a read too early
        return unresolved(envelope, subscription.id);
      }
      return mapAsaasCheckoutPaid({ ...meta, payments, subscription });
    }
    return [];
  } catch (error: unknown) {
    if (error instanceof ProviderNotFoundError) {
      return unresolved(envelope, missing);
    }
    throw error;
  }
}
