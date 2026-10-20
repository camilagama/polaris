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
 * The status the panel of a closed organization shows. `handles` says whether Polaris cancels through
 * that provider (it has its adapter); without one the renewal is the person's to cancel, whatever the
 * record says. A checkout opened and not paid yet (`trial_setup`) is still `pending`: it can still become
 * a subscription, and the hourly run cancels it once it does.
 */
export function renewalCancellationStatus(
  record: RenewalRecord | null,
  link: RenewalProviderLink | null,
  handles: (provider: string) => boolean
): RenewalCancellationStatus {
  if (!(record && link && handles(link.provider))) {
    return "not_handled";
  }
  return renewalAlive(record, link) || record.state === "trial_setup"
    ? "pending"
    : "cancelled";
}
