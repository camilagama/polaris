import type { BillingState } from "../billing/entitlements";
import {
  type PlanMethod,
  type PlanViewRecord,
  refundRequestValidUntil,
  refundWindowClosesAt,
  refundWindowOf,
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
  firstChargeAmount: string | null;
  firstChargeAt: Date | null;
  method: PlanMethod | null;
  /** The database clock (`now()`): the only clock of the verdict. */
  now: Date;
  refundRequestedAt: Date | null;
  state: BillingState;
}

export interface RefundWindowView {
  firstChargeAmount: string | null;
  firstChargeAt: string | null;
  method: PlanMethod | null;
  now: string;
  /** True when the product would still offer or complete a refund now (`refundWindowOf` is not null). */
  refundable: boolean;
  refundRequestedAt: string | null;
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

export function buildRefundWindowView(raw: RawRefundWindow): RefundWindowView {
  const record: PlanViewRecord = {
    accessEndsAt: null,
    cancelAtPeriodEnd: false,
    firstChargeAmount: raw.firstChargeAmount,
    firstChargeAt: raw.firstChargeAt,
    firstChargeOn: null,
    priceAmount: null,
    provider: null,
    refundRequestedAt: raw.refundRequestedAt,
    // the function does not say whether a refund or a chargeback already revoked the payment; the state is shown instead
    revoked: null,
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
