import { type BillingState, grantsPro } from "../billing/entitlements";
import {
  nextChargeOf,
  type PlanMethod,
  type PlanViewRecord,
  refundRequestValidUntil,
  refundWindowClosesAt,
  refundWindowOf,
  resubscribeFromOf,
} from "../billing/plan-view";

/**
 * What the operator sees of a store's window of the right of withdrawal (ADR 0104, decisions 8 and 10): the database
 * function `admin_read_refund_window` gives the facts and the database clock, and no verdict; the verdict is made
 * here with the same `refundWindowOf` of the product, so the Admin and the owner's screen never disagree on a date.
 * Nothing here names a provider reference, a subscription, a price ID, a payer or an e-mail: the function does not
 * return them.
 */

/** The answer of the function, after the repository parsed it. */
export interface RawRefundWindow {
  /** When the Pro access already paid for ends; null in the free states. */
  accessEndsAt: Date | null;
  cancelAtPeriodEnd: boolean;
  firstChargeAmount: string | null;
  firstChargeAt: Date | null;
  method: PlanMethod | null;
  /** The database clock (`now()`): the only clock of the verdict. */
  now: Date;
  refundRequestedAt: Date | null;
  /** The payment taken back (a refund, a chargeback, a chargeback won): the columns the product's own read uses. */
  revokedReason: "chargeback" | "refund" | "won" | null;
  revokedThrough: Date | null;
  state: BillingState;
}

/**
 * Where the renewal stands, from the same record the owner's plan reads: `renewing` (the next charge is coming),
 * `cancelled` (the access already paid for runs to `accessUntil` and nothing renews) or `none` (Free, no record or the
 * period is over). The dates are the product's: `renewsOn` is `nextChargeOf`'s day (`AAAA-MM-DD`), `accessUntil` and
 * `resubscribeFrom` are instants whose São Paulo last day the screen shows, as the owner's screen does.
 */
export interface RefundWindowRenewal {
  /** The end of the access already paid for while the renewal is cancelled; null otherwise. */
  accessUntil: string | null;
  /** The day the renewal is charged; null when the product names none (a link recorded before its price). */
  renewsOn: string | null;
  /** When the owner may subscribe again (`resubscribeFromOf`); null while nothing waits and after a refund. */
  resubscribeFrom: string | null;
  status: "cancelled" | "none" | "renewing";
}

export interface RefundWindowView {
  firstChargeAmount: string | null;
  firstChargeAt: string | null;
  method: PlanMethod | null;
  now: string;
  /** True when the product would still offer or complete a refund now (`refundWindowOf` is not null). */
  refundable: boolean;
  refundRequestedAt: string | null;
  /**
   * True when the provider of the store refunds through the Admin (one rule with the command: `refundsEnabledFor`);
   * false without a provider or while Pix refunds are off. The provider itself is not in the answer.
   */
  refundsHere: boolean;
  renewal: RefundWindowRenewal;
  /** The owner's first refund request accepted under the current link, with the limit of the app's completion. */
  request: {
    at: string;
    /** True while the request is at most 72 hours old at `now` (72 hours exactly still is). */
    completable: boolean;
    completableUntil: string;
  } | null;
  state: BillingState;
  /** The window of the 7 calendar days; null without a first charge. */
  window: {
    /** True while `now` is before 00:00:00 in São Paulo of the 8th day, whatever a request says. */
    open: boolean;
    /** The last second of the window: 23:59:59 in São Paulo of the 7th calendar day after the first charge. */
    until: string;
  } | null;
}

/** The function refused: an inactive operator, a case that is not open, or a case of another store (one answer for all). */
export class RefundWindowReadRefusedError extends Error {
  readonly code = "refund_window_read_refused";

  constructor(options?: ErrorOptions) {
    super("refund_window_read_refused", options);
    this.name = "RefundWindowReadRefusedError";
  }
}

function renewalOf(record: PlanViewRecord, now: Date): RefundWindowRenewal {
  const live =
    record.accessEndsAt !== null &&
    record.accessEndsAt.getTime() > now.getTime();
  const resubscribeFrom = resubscribeFromOf(record);
  if (live && record.cancelAtPeriodEnd) {
    return {
      accessUntil: record.accessEndsAt?.toISOString() ?? null,
      renewsOn: null,
      resubscribeFrom: resubscribeFrom?.toISOString() ?? null,
      status: "cancelled",
    };
  }
  if (live && grantsPro(record.state)) {
    return {
      accessUntil: null,
      renewsOn: nextChargeOf(record, now)?.on ?? null,
      resubscribeFrom: null,
      status: "renewing",
    };
  }
  return {
    accessUntil: null,
    renewsOn: null,
    resubscribeFrom: null,
    status: "none",
  };
}

export function buildRefundWindowView(
  raw: RawRefundWindow,
  options: { refundsHere: boolean }
): RefundWindowView {
  const record: PlanViewRecord = {
    accessEndsAt: raw.accessEndsAt,
    cancelAtPeriodEnd: raw.cancelAtPeriodEnd,
    firstChargeAmount: raw.firstChargeAmount,
    firstChargeAt: raw.firstChargeAt,
    firstChargeOn: null,
    // stands for the price only so `nextChargeOf` names a day; it is the first charge's amount, not the one in force
    priceAmount: raw.firstChargeAmount,
    provider: null,
    refundRequestedAt: raw.refundRequestedAt,
    revoked:
      raw.revokedThrough !== null && raw.revokedReason !== null
        ? { reason: raw.revokedReason }
        : null,
    state: raw.state,
  };
  const closesAt =
    raw.firstChargeAt === null ? null : refundWindowClosesAt(raw.firstChargeAt);
  const completableUntil =
    raw.refundRequestedAt === null
      ? null
      : refundRequestValidUntil(raw.refundRequestedAt);
  return {
    firstChargeAmount: raw.firstChargeAmount,
    firstChargeAt: raw.firstChargeAt?.toISOString() ?? null,
    method: raw.method,
    now: raw.now.toISOString(),
    refundable: refundWindowOf(record, raw.now) !== null,
    refundRequestedAt: raw.refundRequestedAt?.toISOString() ?? null,
    refundsHere: options.refundsHere,
    renewal: renewalOf(record, raw.now),
    request:
      raw.refundRequestedAt === null || completableUntil === null
        ? null
        : {
            at: raw.refundRequestedAt.toISOString(),
            completable: raw.now.getTime() <= completableUntil.getTime(),
            completableUntil: completableUntil.toISOString(),
          },
    state: raw.state,
    window:
      closesAt === null
        ? null
        : {
            open: raw.now.getTime() < closesAt.getTime(),
            until: new Date(closesAt.getTime() - 1000).toISOString(),
          },
  };
}
