import type {
  ProviderBillingEvent,
  UnresolvedProviderEvent,
} from "@polaris/billing/provider-port";
import type { WorkerBindings } from "../environment";

/**
 * What a payment provider has to implement to feed the billing lifecycle (plan
 * PR77 and PR78 write the real ones). An adapter knows its provider's webhook
 * format and nothing else: it checks that the request really comes from the
 * provider, then reduces the payload to the few facts the lifecycle reads
 * (`@polaris/domain/billing/facts`). It never touches the database, never
 * decides what an organization may do, and keeps no personal data: the facts
 * carry a subscription reference and times, not names, e-mails or card data.
 */

/** The request could not be proven to come from the provider (bad or missing signature or token). */
export class WebhookRejectedError extends Error {
  readonly code = "webhook_rejected";

  constructor(options?: ErrorOptions) {
    super("webhook_rejected", options);
    this.name = "WebhookRejectedError";
  }
}

/** The request is authentic but its payload cannot be read as the provider documents it. */
export class WebhookMalformedError extends Error {
  readonly code = "webhook_malformed";

  constructor(options?: ErrorOptions) {
    super("webhook_malformed", options);
    this.name = "WebhookMalformedError";
  }
}

/**
 * How long a delivery the adapter could not resolve (the resource was not found,
 * or came back in a shape the provider does not document) is refused with a 503
 * so the provider sends it again. A provider pauses a webhook that keeps
 * failing (Asaas after 15 failures in a row), so an older one is acknowledged
 * and logged as an error with its IDs, for the reconciliation to recover.
 */
const PROVIDER_RETRY_WINDOW_MS = 30 * 60_000;

/** True while an event is recent enough to be refused for a retry. */
export function withinRetryWindow(occurredAt: Date, now = new Date()): boolean {
  return now.getTime() - occurredAt.getTime() <= PROVIDER_RETRY_WINDOW_MS;
}

/** A fact with the provider's event ID and the subscription reference it is about. */
export type ParsedBillingEvent = ProviderBillingEvent;

/**
 * An event whose resource the provider did not find when the adapter read it
 * back (AC-48): only IDs. It is never acknowledged as handled.
 */
export type UnresolvedBillingEvent = UnresolvedProviderEvent;

interface WebhookRequest {
  bindings: WorkerBindings;
  headers: Headers;
  /** The body exactly as received: a signature is computed over these bytes. */
  rawBody: string;
}

export interface BillingProviderAdapter {
  /**
   * Verifies the request first (throwing `WebhookRejectedError`), then reads
   * the payload. A payload that carries nothing the lifecycle needs (a
   * notification of another kind) returns an empty list: it is acknowledged and
   * dropped. An event whose resource could not be found comes back as an
   * `UnresolvedBillingEvent`.
   */
  parse: (
    request: WebhookRequest
  ) =>
    | Promise<(ParsedBillingEvent | UnresolvedBillingEvent)[]>
    | (ParsedBillingEvent | UnresolvedBillingEvent)[];
  /** The provider name stored with every event, as in the route (`/webhooks/billing/:provider`). */
  readonly provider: string;
}
