import type { BillingFact } from "@polaris/domain/billing/facts";
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

export interface ParsedBillingEvent {
  fact: BillingFact;
  /** The provider's own ID of the event: the key that makes a redelivery a no-op. */
  providerEventId: string;
  /** The subscription reference at the provider that the event is about. */
  providerRef: string;
}

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
   * dropped.
   */
  parse: (
    request: WebhookRequest
  ) => Promise<ParsedBillingEvent[]> | ParsedBillingEvent[];
  /** The provider name stored with every event, as in the route (`/webhooks/billing/:provider`). */
  readonly provider: string;
}
