import { localDate } from "../organization/closure-deadlines";
import type { BillingState } from "./entitlements";
import type { BillingFact, BillingRecord } from "./facts";
import { type BillingEvent, GRACE_DAYS } from "./subscription-state";

/**
 * The notices of the billing cycle and the welcome (ADR 0104, decision 7; design t268 v2, §9): which notice a change
 * of the billing record, or the hour that passes, records. A notice is a row of `billing_notices` (one per store, kind
 * and `dedupeKey`, so the same transition twice records one) and an outbox event `billing.notice` written in the same
 * transaction; whether it still goes out is decided when it is sent, by the consumer (`noticeStillTrue`, PR G). Pure:
 * no clock, no database, no provider.
 */
export const BILLING_NOTICE_KINDS = Object.freeze([
  "trial_started",
  "trial_charge_eve",
  "first_charge_failed",
  "renewal_failed",
  "access_ended",
  "charge_receipt",
  "renewal_cancelled",
  "refund_confirmed",
  // the notice 7 days before the renewal of the yearly cycle (Q-E1, decision of the user of 23/10/2026; named here)
  "annual_renewal_reminder",
  "welcome",
] as const);

export type BillingNoticeKind = (typeof BILLING_NOTICE_KINDS)[number];

export function isBillingNoticeKind(
  value: unknown
): value is BillingNoticeKind {
  return (BILLING_NOTICE_KINDS as readonly unknown[]).includes(value);
}

/** What one notice records: the store is the caller's, and so is the row's ID. */
export interface BillingNoticeMark {
  /** One notice per store, kind and key: an opaque reference, a date or an ID, never a person's data. */
  dedupeKey: string;
  /** Not to go out before this instant (the consumer waits for it). */
  dueAt: Date;
  kind: BillingNoticeKind;
}

/**
 * How long a receipt (E4) and a cancellation (E7) wait before they go out: the provider's `SUBSCRIPTION_DELETED` can
 * arrive before the fact of the owner's command, and the refund right after it; the wait lets the fact that suppresses
 * them land first.
 */
export const BILLING_NOTICE_SETTLE_MS = 10 * 60_000;
/** A cancellation that came with an owner's refund request waits a day: a refund completed suppresses it (AS-42). */
export const BILLING_NOTICE_REFUND_WAIT_MS = 24 * 3_600_000;
/** The yearly renewal is announced this many local days before its charge (Q-E1). */
export const ANNUAL_RENEWAL_REMINDER_LEAD_DAYS = 7;
/** The renewal that failed is told on the day of the failure, on the 3rd day and on the day before the end (EM-5). */
export const RENEWAL_FAILED_MILESTONES = Object.freeze([
  "d0",
  "d3",
  "dlast",
] as const);
export type RenewalFailedMilestone = (typeof RENEWAL_FAILED_MILESTONES)[number];
/** The local hours a notice of the hourly sweep is recorded in: from 08:00 to before 20:00, in the store's time zone. */
export const BILLING_NOTICE_SWEEP_HOURS = Object.freeze({ from: 8, until: 20 });
/** The welcome goes to the oldest owner of a store created in the last 24 hours (the hourly sweep, decision 6). */
export const WELCOME_NOTICE_WINDOW_HOURS = 24;

const DAY_MS = 86_400_000;
const FREE_STATES: readonly BillingState[] = ["free", "free_over_limit"];

/** What `noticesFor` reads of a change of the record. */
export interface BillingNoticeTransition {
  after: BillingRecord;
  before: BillingRecord;
  /** The row of the ledger the fact was applied from; null for what time caused (the sweep). */
  eventId: string | null;
  /** The provider's fact applied; null for what time caused (the sweep). */
  fact: BillingFact | null;
  now: Date;
  /** The reference of the current link to the provider (E-A and E-C1 are one per subscription). */
  providerRef: string | null;
  /** When the owner asked for the refund of the current link, if they did: E7 then waits a day. */
  refundRequestedAt: Date | null;
  /** The state machine event that moved the record, when one did. */
  transition: BillingEvent["type"] | null;
}

/**
 * The notices one applied change of the record records (EM-1 to EM-5, EM-7): one transition, one notice, from the
 * table of the design (§9). The caller calls it only for a fact that was applied, or for what time caused: a fact that
 * was ignored (duplicated, stale or out of order) records nothing (EM-3).
 */
export function noticesFor(
  input: BillingNoticeTransition
): BillingNoticeMark[] {
  const { after, before, eventId, fact, now, providerRef, transition } = input;
  const marks: BillingNoticeMark[] = [];
  const mark = (kind: BillingNoticeKind, dedupeKey: string, wait = 0) => {
    marks.push({ dedupeKey, dueAt: new Date(now.getTime() + wait), kind });
  };
  // E-A: the method is ready and the trial runs
  if (
    fact?.type === "trial_method_ready" &&
    before.state !== "trialing" &&
    after.state === "trialing" &&
    providerRef
  ) {
    mark("trial_started", providerRef);
  }
  // E-C1: the first charge after the trial failed, and the store is on Free
  if (
    fact?.type === "charge_failed" &&
    transition === "trial_ended_without_payment" &&
    providerRef
  ) {
    mark("first_charge_failed", providerRef);
  }
  // E-C2 on the day of the failure: the renewal failed and the grace began (by the provider's fact, or by the sweep)
  if (
    transition === "payment_failed" &&
    after.state === "grace" &&
    after.accessEndsAt
  ) {
    mark(
      "renewal_failed",
      renewalFailedKey(paidPeriodEndOf(after.accessEndsAt), "d0")
    );
  }
  // E-D: the grace or the cancelled period ended, and the store is on Free
  if (
    (transition === "grace_expired" || transition === "period_ended") &&
    FREE_STATES.includes(after.state) &&
    before.accessEndsAt
  ) {
    mark("access_ended", before.accessEndsAt.toISOString());
  }
  if (!eventId) {
    return marks;
  }
  // E4: a charge went through (the first one, a renewal, or a late one that revived the store)
  if (
    fact?.type === "charge_succeeded" &&
    (transition === "subscribe" || transition === "payment_succeeded")
  ) {
    mark("charge_receipt", eventId, BILLING_NOTICE_SETTLE_MS);
  }
  // E7: the renewal was cancelled, whoever cancelled it (the owner, the provider, the closure, the refund)
  if (
    fact?.type === "subscription_cancelled" &&
    !before.cancelAtPeriodEnd &&
    after.cancelAtPeriodEnd
  ) {
    mark(
      "renewal_cancelled",
      eventId,
      input.refundRequestedAt
        ? BILLING_NOTICE_REFUND_WAIT_MS
        : BILLING_NOTICE_SETTLE_MS
    );
  }
  // E-R: a refund took the paid access back
  if (fact?.type === "charge_refunded" && transition === "access_revoked") {
    mark("refund_confirmed", eventId);
  }
  return marks;
}

/** What the hourly sweep reads of one store. */
export interface BillingNoticeSweepInput {
  /** The day of the first charge set at the provider in the checkout (`first_charge_on`), YYYY-MM-DD. */
  firstChargeOn: string | null;
  now: Date;
  providerRef: string | null;
  record: BillingRecord;
  /** The store's time zone. */
  timeZone: string;
}

/**
 * The notices the hourly sweep records for one store: the eve of the first charge (E-B), the 3rd day and the day
 * before the end of the grace (E-C2) and the yearly renewal 7 days ahead. Each only on its local day and between
 * 08:00 and 20:00 local, so a milestone whose day passed is not recorded late (a failure reported on the 5th day
 * has no 3rd-day notice). That two notices fall on the same local day (a failure reported on the last day) is
 * settled when they are sent (`same_day`, PR G).
 */
export function sweepNoticesFor(
  input: BillingNoticeSweepInput
): BillingNoticeMark[] {
  const { firstChargeOn, now, providerRef, record, timeZone } = input;
  if (!withinSweepHours(now, timeZone)) {
    return [];
  }
  const today = localDate(now, timeZone);
  const marks: BillingNoticeMark[] = [];
  const mark = (kind: BillingNoticeKind, dedupeKey: string) => {
    marks.push({ dedupeKey, dueAt: now, kind });
  };
  if (
    record.state === "trialing" &&
    !record.cancelAtPeriodEnd &&
    providerRef &&
    firstChargeOn !== null &&
    firstChargeOn === addCalendarDays(today, 1)
  ) {
    mark("trial_charge_eve", providerRef);
  }
  if (
    record.state === "grace" &&
    !record.cancelAtPeriodEnd &&
    record.accessEndsAt
  ) {
    const paidEnd = paidPeriodEndOf(record.accessEndsAt);
    if (today === addCalendarDays(localDate(paidEnd, timeZone), 3)) {
      mark("renewal_failed", renewalFailedKey(paidEnd, "d3"));
    }
    if (
      today === addCalendarDays(localDate(record.accessEndsAt, timeZone), -1)
    ) {
      mark("renewal_failed", renewalFailedKey(paidEnd, "dlast"));
    }
  }
  if (
    record.state === "active" &&
    record.cycleMonths === 12 &&
    !record.cancelAtPeriodEnd &&
    record.revoked === null &&
    record.accessEndsAt &&
    today ===
      addCalendarDays(
        localDate(record.accessEndsAt, timeZone),
        -ANNUAL_RENEWAL_REMINDER_LEAD_DAYS
      )
  ) {
    mark("annual_renewal_reminder", record.accessEndsAt.toISOString());
  }
  return marks;
}

/** The welcome of a person (E1): one per person, whatever the store (the database holds it to that). */
export function welcomeNotice(userId: string, now: Date): BillingNoticeMark {
  return { dedupeKey: userId, dueAt: now, kind: "welcome" };
}

/** The end of the period already paid, from the end of the grace that followed it (RN:19). */
function paidPeriodEndOf(graceEndsAt: Date): Date {
  return new Date(graceEndsAt.getTime() - GRACE_DAYS * DAY_MS);
}

function renewalFailedKey(
  paidEnd: Date,
  milestone: RenewalFailedMilestone
): string {
  return `${paidEnd.toISOString()}:${milestone}`;
}

function addCalendarDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  return new Date(Date.UTC(year, month - 1, day) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

const hourFormatters = new Map<string, Intl.DateTimeFormat>();

function localHour(instant: Date, timeZone: string): number {
  let formatter = hourFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      hourCycle: "h23",
      timeZone,
    });
    hourFormatters.set(timeZone, formatter);
  }
  return Number(
    formatter.formatToParts(instant).find((part) => part.type === "hour")?.value
  );
}

function withinSweepHours(now: Date, timeZone: string): boolean {
  const hour = localHour(now, timeZone);
  return (
    hour >= BILLING_NOTICE_SWEEP_HOURS.from &&
    hour < BILLING_NOTICE_SWEEP_HOURS.until
  );
}
