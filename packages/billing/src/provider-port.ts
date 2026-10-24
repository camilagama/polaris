import type {
  BillingCycleMonths,
  BillingFact,
} from "@polaris/domain/billing/facts";

/**
 * The outbound port to a payment provider (ADR 0101): what the billing
 * commands ask of Asaas and Woovi, the same for both. A provider is reached
 * only through it; its HTTP client, its payload formats and its quirks stay
 * behind it. Nothing here touches the database: the command that calls the
 * port decides the order (prepare, then `attachProvider`, then the handoff).
 */

export type BillingProviderName = "asaas" | "woovi";

/** One fact for the billing inbox, with the provider IDs that make it idempotent. */
export interface ProviderBillingEvent {
  fact: BillingFact;
  /** The provider's own ID of the event: the key that makes a redelivery a no-op. */
  providerEventId: string;
  /** The subscription reference at the provider, exactly as `attachProvider` stored it. */
  providerRef: string;
  /**
   * The provider's own ID of the subscription this fact came from (Asaas `sub_`),
   * when the provider has one. The inbox stores it with the event, and the first
   * fact that matches `providerRef` stores it on the organization's record
   * (`provider_subscription_id`): the commands then find the subscription by it.
   */
  providerSubscriptionId?: string;
}

/**
 * An event whose resource the provider did not find when it was read back
 * (AC-48). It is never dropped: it carries only IDs and waits to be read again.
 */
export interface UnresolvedProviderEvent {
  /** The provider's name of the event (`PAYMENT_CONFIRMED`). */
  eventType: string;
  kind: "unresolved";
  /** When the provider says the event happened: an old one stops being sent back for a retry. */
  occurredAt: Date;
  /** The provider's time was ahead of the clock and was cut down to now: it never counts as recent. */
  occurredAtClamped?: true;
  providerEventId: string;
  /** The ID of the resource that was not found, or that does not carry the checkout ID (a charge, a subscription or a checkout). */
  resourceId: string;
}

/** Where the provider's page sends the payer back: built on the server, never taken from the client. */
export interface CheckoutReturnUrls {
  cancelUrl: string;
  /** Where the payer lands when the checkout expires before it is finished. */
  returnUrl: string;
  successUrl: string;
}

export interface PrepareSubscriptionInput {
  /** The price of one cycle, as `money.md` writes it (`"24.90"`); it never passes through `number`. */
  amount: string;
  cycleMonths: BillingCycleMonths;
  /** The day of the first charge, `AAAA-MM-DD` in America/Sao_Paulo (the end of the trial, or today). */
  firstChargeOn: string;
  /**
   * The payer, never stored by Polaris. The card checkout takes none of it (the
   * payer types it on the provider's page) and refuses a tax ID; Pix
   * Automático needs the name, the CPF or CNPJ, the e-mail and the key of the
   * payer's customer at the provider (`customerKey`, an HMAC of the document
   * made by the server).
   */
  payer?: {
    customerKey?: string;
    email: string;
    name: string;
    taxId?: string;
  };
  /**
   * Whether the first charge comes after a trial. Pix Automático picks its
   * journey by it (2, `ONLY_RECURRENCY`, with; 3, `PAYMENT_ON_APPROVAL`,
   * paid on approval, without); the card checkout reads only the date.
   */
  trial?: boolean;
}

export type CheckoutHandoff =
  | { kind: "redirect"; url: string }
  | {
      /** The Pix "copia e cola" of the authorization; no QR is drawn by Polaris. */
      emv: string;
      kind: "pix_authorization";
      /** Woovi's page of the authorization, when it gave one over https (the sandbox gives none). */
      url: string | null;
    };

export interface PreparedSubscription {
  /** The provider's ID of what was created (the hosted checkout), kept to cancel it if the link fails. */
  checkoutId: string;
  /**
   * Pix Automático: whether the payer's customer was created at Woovi now or
   * was already there with the same data (`alignWooviCustomer`). For the
   * operator's audit log only, with no personal data; never returned to the
   * tenant, in any form.
   */
  customerAlignment?: "created" | "matches";
  /** What the client needs to finish at the provider. Never logged. */
  handoff: CheckoutHandoff;
  /**
   * The reference every later fact carries; `attachProvider` stores it before the
   * handoff is returned. For Asaas it is the checkout's own ID, which the
   * provider copies into the subscription and its first charge (`checkoutSession`).
   */
  providerRef: string;
}

/**
 * The commands that read the subscription take the `providerSubscriptionId` the
 * record stored (null before a fact matched): with it the provider is asked for
 * that subscription directly; without it (no webhook arrived yet), the
 * subscription is looked up by `providerRef`.
 */
export interface BillingProviderPort {
  /** Cancels the renewal; safe to repeat. Access already paid for is not touched. */
  cancelRenewal: (
    providerRef: string,
    providerSubscriptionId?: string | null
  ) => Promise<"already_cancelled" | "cancelled" | "nothing_to_cancel">;
  /**
   * Gives up a checkout so it can no longer be paid: one prepared that could not
   * be linked, or the one of an organization whose trial reservation moved to
   * another (best effort). Safe to repeat: a checkout already cancelled, or
   * one the provider does not know, is `already_closed`.
   */
  discardCheckout: (
    checkoutId: string
  ) => Promise<"already_closed" | "discarded">;
  /**
   * Whether the provider already made a subscription from this reference (a
   * checkout that was paid), live or not, whatever its charges show. A checkout
   * nobody paid is `false`; a failure to answer throws.
   */
  hasSubscription: (
    providerRef: string,
    providerSubscriptionId?: string | null
  ) => Promise<boolean>;
  /** Creates the subscription (or the checkout that creates it) at the provider. */
  prepareSubscription: (
    input: PrepareSubscriptionInput
  ) => Promise<PreparedSubscription>;
  readonly provider: BillingProviderName;
  /** The provider's state as facts, for the reconciliation; read again first, never guessed. */
  readState: (
    providerRef: string,
    now: Date,
    providerSubscriptionId?: string | null
  ) => Promise<ProviderBillingEvent[]>;
  /**
   * Refunds in full the charge of the period in force at `now`; never part of
   * it, never an earlier one. A provider whose refund sends no webhook tied to
   * the subscription (Woovi) answers the fact too, and the command writes it
   * through the inbox.
   */
  refundCurrentPeriod: (
    providerRef: string,
    now: Date,
    providerSubscriptionId?: string | null
  ) => Promise<RefundOutcome>;
  /**
   * Whether `refundCurrentPeriod` may call the provider here. The refund
   * command cancels the renewal first (ADR 0066, emenda de 23/10), so it asks
   * this before touching anything: a provider that cannot refund leaves the
   * renewal as it was.
   */
  readonly refundsEnabled: boolean;
}

export type RefundOutcome =
  | "nothing_to_refund"
  | "refund_requested"
  | { event: ProviderBillingEvent; kind: "refund_requested" };

/** The provider did not answer in time, could not be reached, or failed (5xx, 429). A retry may work. */
export class ProviderUnavailableError extends Error {
  readonly code = "provider_unavailable";

  constructor(options?: ErrorOptions) {
    super("provider_unavailable", options);
    this.name = "ProviderUnavailableError";
  }
}

/**
 * The provider refused the request (4xx). Neither error carries the provider's
 * answer: its body can hold personal data and never reaches a log or a client.
 */
export class ProviderRejectedError extends Error {
  readonly code: string = "provider_rejected";
  readonly status: number;

  constructor(status: number) {
    super("provider_rejected");
    this.name = "ProviderRejectedError";
    this.status = status;
  }
}

/** The resource asked for does not exist at the provider (404). */
export class ProviderNotFoundError extends ProviderRejectedError {
  override readonly code = "provider_not_found";

  constructor() {
    super(404);
    this.name = "ProviderNotFoundError";
  }
}

/** The provider answered with something that is not what it documents. */
export class ProviderResponseMalformedError extends Error {
  readonly code = "provider_response_malformed";

  constructor() {
    super("provider_response_malformed");
    this.name = "ProviderResponseMalformedError";
  }
}

/** A secret or a setting is missing, or the API key does not belong to the configured host. */
export class ProviderNotConfiguredError extends Error {
  readonly code = "billing_provider_not_configured";

  constructor() {
    super("billing_provider_not_configured");
    this.name = "ProviderNotConfiguredError";
  }
}
