import { type BillingState, grantsPro } from "./entitlements";
import type { RevokedPayment } from "./facts";
import { saoPauloDateOf } from "./provider-period";

/**
 * What the owner reads of the plan (ADR 0104, decision 2; design t268 v2, §3): the next charge, the window of the
 * right of withdrawal and when a new subscription may start, derived from the billing record and a clock the caller
 * gives. Nothing here reads a clock, a database or a provider; the read of the plan (`billing.readPlan`) and the
 * owner's commands use these same functions, so the screen and the command never disagree on a date.
 */

/** São Paulo has had no daylight saving time since 2019 (as in `provider-period`). */
const SAO_PAULO_OFFSET = "-03:00";
const HOUR_MS = 3_600_000;

/** The right of withdrawal: 7 calendar days after the day of the first charge (T-5). */
export const REFUND_WINDOW_DAYS = 7;
/** A refund asked in time may still be completed this long after the request (ADR 0104, decision 3). */
export const REFUND_REQUEST_VALID_HOURS = 72;

/** The record as the plan's read needs it: the facts of the state machine and the columns of migration 0100. */
export interface PlanViewRecord {
  accessEndsAt: Date | null;
  cancelAtPeriodEnd: boolean;
  /** The moment and the amount of the first charge paid under the current link (`fact.occurredAt`). */
  firstChargeAmount: string | null;
  firstChargeAt: Date | null;
  /** The day of the first charge set at the provider by the checkout (`AAAA-MM-DD`). */
  firstChargeOn: string | null;
  /** The price the checkout sent to the provider: the amount of every charge of this subscription. */
  priceAmount: string | null;
  provider: string | null;
  /** The owner's first refund request accepted under the current link. */
  refundRequestedAt: Date | null;
  revoked: Pick<RevokedPayment, "reason"> | null;
  state: BillingState;
}

export type PlanMethod = "card" | "pix_automatic";

/** How a refund is asked: in the app (the provider refunds), or by writing to support (Pix until S3.2, R-1). */
export type RefundVia = "app" | "suporte";

export interface NextCharge {
  amount: string;
  /** The day, in São Paulo (`AAAA-MM-DD`). */
  on: string;
}

export interface RefundWindow {
  amount: string;
  /** The last second of the window: 23:59:59 in São Paulo of the 7th calendar day after the first charge. */
  until: Date;
}

/** The method the owner pays with, from the provider; nothing of the provider itself. */
export function planMethodOf(provider: string | null): PlanMethod | null {
  if (provider === "asaas") {
    return "card";
  }
  return provider === "woovi" ? "pix_automatic" : null;
}

function addCalendarDays(date: string, days: number): string {
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days))
    .toISOString()
    .slice(0, 10);
}

function saoPauloDayStart(date: string): Date {
  return new Date(`${date}T00:00:00.000${SAO_PAULO_OFFSET}`);
}

/**
 * The next charge (AS-3): in a trial, the day of the first charge set at the provider (never the end of the trial,
 * which for a Pix approved late falls after it); while paid and renewing, the last day of the paid period (the day
 * the renewal is charged). None with the renewal cancelled, in grace, on Free, once the access ran out, or without
 * the price the checkout recorded (a link older than migration 0100): nothing is invented.
 */
export function nextChargeOf(
  record: PlanViewRecord,
  now: Date
): NextCharge | null {
  if (
    record.cancelAtPeriodEnd ||
    record.priceAmount === null ||
    record.accessEndsAt === null ||
    record.accessEndsAt.getTime() <= now.getTime()
  ) {
    return null;
  }
  if (record.state === "trialing") {
    return record.firstChargeOn === null
      ? null
      : { amount: record.priceAmount, on: record.firstChargeOn };
  }
  if (record.state === "active") {
    // the period runs through the whole of its last day, and the renewal is charged on that day
    return {
      amount: record.priceAmount,
      on: saoPauloDateOf(new Date(record.accessEndsAt.getTime() - 1)),
    };
  }
  return null;
}

/**
 * The window of the right of withdrawal (AS-7, T-5): it ends at 23:59:59 in São Paulo of the 7th calendar day after
 * the day of the first charge, counted from the provider's moment of that charge (a webhook delivered late never
 * moves it). It is judged at the owner's first request when there is one, not at a retry, and a request still not
 * completed 72 hours later is the operator's (ADR 0104, decision 3). None without a first charge, after a refund or a
 * chargeback, and never for a renewal (only the first charge of the link is recorded).
 */
export function refundWindowOf(
  record: PlanViewRecord,
  now: Date
): RefundWindow | null {
  if (record.firstChargeAt === null || record.firstChargeAmount === null) {
    return null;
  }
  if (record.revoked !== null && record.revoked.reason !== "won") {
    return null;
  }
  const closesAt = saoPauloDayStart(
    addCalendarDays(
      saoPauloDateOf(record.firstChargeAt),
      REFUND_WINDOW_DAYS + 1
    )
  );
  const judgedAt = record.refundRequestedAt ?? now;
  if (judgedAt.getTime() >= closesAt.getTime()) {
    return null;
  }
  if (
    record.refundRequestedAt !== null &&
    now.getTime() - record.refundRequestedAt.getTime() >
      REFUND_REQUEST_VALID_HOURS * HOUR_MS
  ) {
    return null;
  }
  return {
    amount: record.firstChargeAmount,
    until: new Date(closesAt.getTime() - 1000),
  };
}

/**
 * The refund the owner may ask for now: the window of `refundWindowOf`, the same for both ways, asked in the app
 * when the provider's port refunds (`refundsEnabled`), by writing to support otherwise (R-1).
 */
export function refundOfferOf(
  record: PlanViewRecord,
  now: Date,
  refundsEnabled: boolean
): (RefundWindow & { via: RefundVia }) | null {
  const window = refundWindowOf(record, now);
  return window === null
    ? null
    : { ...window, via: refundsEnabled ? "app" : "suporte" };
}

/**
 * The renewal was cancelled by the owner's refund request and the refund is not completed (AS-42). The 72 hours
 * (ADR 0104, decision 3) only limit until when the app completes the request, and the offer of `refundWindowOf`
 * goes with them; the fact stays until the refund arrives or the owner links a provider again (the link clears the
 * anchor).
 */
export function refundPendingOf(record: PlanViewRecord): boolean {
  return (
    record.refundRequestedAt !== null && record.revoked?.reason !== "refund"
  );
}

/**
 * When a new subscription may start (AS-27, B8): the end of the access already paid for when the renewal was
 * cancelled, the same condition that refuses the checkout (`renewal_cancelled_until`). None while nothing waits,
 * and none after a refund: the Pro ended at once and the owner may subscribe again now.
 */
export function resubscribeFromOf(record: PlanViewRecord): Date | null {
  if (record.revoked?.reason === "refund") {
    return null;
  }
  return grantsPro(record.state) &&
    record.cancelAtPeriodEnd &&
    record.accessEndsAt !== null
    ? record.accessEndsAt
    : null;
}

/**
 * The way to pay the charge that failed (AS-43): the provider's page of the overdue charge, only in grace with the
 * card. Pix never gets a promise of a new try until the Gate 7 proves Woovi's calendar (`provider_retries` does not
 * exist in V1).
 */
export function recoveryOf(record: PlanViewRecord): "provider_page" | null {
  return record.state === "grace" && planMethodOf(record.provider) === "card"
    ? "provider_page"
    : null;
}
