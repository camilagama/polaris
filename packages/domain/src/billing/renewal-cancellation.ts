import { grantsPro } from "./entitlements";
import type { BillingRecord } from "./facts";

/**
 * Closing the organization cancels the renewal of its subscription (ADR 0074, L4). The closure only asks
 * (an outbox event in its own transaction); the queue consumer cancels at the provider and writes the
 * cancellation through the billing inbox, and the hourly billing run asks again for as long as the renewal
 * is still alive. Both read the same predicate, here, and the database function of the hourly run repeats
 * it (the gate compares them).
 */

/** What the owner of a closed organization reads about its renewal, derived by the server from the record. */
export const RENEWAL_CANCELLATION_STATUSES = Object.freeze([
  // no provider linked, or one Polaris cannot cancel through: the person cancels at the provider
  "not_handled",
  // a provider Polaris cancels through, and the renewal is not cancelled yet
  "pending",
  // the renewal is cancelled (paid access runs to its end), or there is nothing left to renew
  "cancelled",
] as const);

export type RenewalCancellationStatus =
  (typeof RENEWAL_CANCELLATION_STATUSES)[number];

export type RenewalRecord = Pick<BillingRecord, "cancelAtPeriodEnd" | "state">;

export interface RenewalProviderLink {
  provider: string;
  /** The provider's own ID of the subscription, once a fact matched it; null while only a checkout is linked. */
  providerSubscriptionId: string | null;
}

/**
 * The providers Polaris acts through (cancels, refunds, reconciles, gives a checkout up): the ones with an
 * outbound port: Asaas (cartão) and Woovi (Pix Automático, cobrança PR 6, ADR 0101). The hourly run passes
 * this list to the database, and the Admin's purge lock reads it.
 */
export const HANDLED_BILLING_PROVIDERS: readonly string[] = Object.freeze([
  "asaas",
  "woovi",
]);

/** Whether Polaris acts through this provider at all: without its port, the renewal is the person's to cancel. */
export function billingProviderHandled(provider: string): boolean {
  return HANDLED_BILLING_PROVIDERS.includes(provider);
}

/**
 * Whether the renewal is still alive at the provider and the closure still owes its cancellation: a
 * provider is linked, the state gives Pro (a trial, a paid period or grace: each charges again) and the
 * cancellation at the end of the period is not recorded.
 */
export function renewalAlive(
  record: RenewalRecord | null,
  link: RenewalProviderLink | null
): boolean {
  return Boolean(
    record && link && grantsPro(record.state) && !record.cancelAtPeriodEnd
  );
}

/**
 * Whether a checkout linked before the closure can still be paid: no subscription matched it yet (the link
 * has no `providerSubscriptionId`), the state gives no Pro (`free`, `free_over_limit` or `trial_setup`) and
 * the closure has not given it up at the provider yet (`discarded`, read from the billing ledger). Paid
 * after the closure, it would charge a whole period of a closed store, or start the trial there.
 */
export function checkoutOpen(
  record: RenewalRecord | null,
  link: RenewalProviderLink | null,
  discarded: boolean
): boolean {
  return Boolean(
    record &&
      link &&
      link.providerSubscriptionId === null &&
      !grantsPro(record.state) &&
      !discarded
  );
}

/**
 * Whether the Admin's purge must wait: the renewal is alive at a provider Polaris cancels through. After
 * the purge the hourly retry stops (the organization leaves the closure), and the charge would go on with
 * nothing left in Polaris to cancel it.
 */
export function renewalBlocksPurge(
  record: RenewalRecord | null,
  link: RenewalProviderLink | null
): boolean {
  return Boolean(
    link && billingProviderHandled(link.provider) && renewalAlive(record, link)
  );
}

/**
 * The status the panel of a closed organization shows. `handles` says whether Polaris cancels through
 * that provider (it has its adapter); without one the renewal is the person's to cancel, whatever the
 * record says. A checkout still open (`checkoutOpen`) is `pending` until the closure gives it up at the
 * provider (`checkoutDiscarded`): until then it can still become a subscription.
 */
export function renewalCancellationStatus(
  record: RenewalRecord | null,
  link: RenewalProviderLink | null,
  handles: (provider: string) => boolean,
  checkoutDiscarded = false
): RenewalCancellationStatus {
  if (!(record && link && handles(link.provider))) {
    return "not_handled";
  }
  return renewalAlive(record, link) ||
    checkoutOpen(record, link, checkoutDiscarded)
    ? "pending"
    : "cancelled";
}
