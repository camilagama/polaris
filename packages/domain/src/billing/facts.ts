import {
  type BillingFacts,
  type BillingState,
  grantsPro,
} from "./entitlements";
import {
  applyBillingEvent,
  type BillingEvent,
  GRACE_DAYS,
  InvalidBillingTransitionError,
  MAX_PERIOD_DAYS,
  RejectedBillingEventError,
} from "./subscription-state";

/**
 * Provider facts reconciled into the billing record (plan PR79 and PR81). A
 * provider reports facts; it never decides what an organization may do: a fact
 * is checked against the record and, when it applies, moves the record through
 * the state machine of `subscription-state.ts`. Pure: no clock, no database,
 * no provider.
 *
 * Adapters turn each provider's payloads into these few facts. They carry no
 * personal data: only what the lifecycle needs.
 */

/** The billing cycles on sale, in months (the price table's intervals). */
export const BILLING_CYCLE_MONTHS = [1, 6, 12] as const;
export type BillingCycleMonths = (typeof BILLING_CYCLE_MONTHS)[number];

export function isBillingCycleMonths(
  value: number
): value is BillingCycleMonths {
  return (BILLING_CYCLE_MONTHS as readonly number[]).includes(value);
}

export type BillingFact =
  | {
      /** The renewal method (card, or Pix authorization) is confirmed: the trial may start. */
      cycleMonths: BillingCycleMonths;
      occurredAt: Date;
      type: "trial_method_ready";
    }
  | {
      /** A charge went through: the first one or a renewal. */
      cycleMonths: BillingCycleMonths;
      occurredAt: Date;
      /** The provider-confirmed end of the period that was just paid for. */
      periodEndsAt: Date;
      type: "charge_succeeded";
    }
  | { occurredAt: Date; type: "charge_failed" }
  | {
      /** The subscription was cancelled: access continues to the end of what was paid. */
      occurredAt: Date;
      type: "subscription_cancelled";
    }
  | {
      /** A different cycle takes effect at the next renewal. */
      cycleMonths: BillingCycleMonths;
      occurredAt: Date;
      type: "cycle_change_scheduled";
    }
  | {
      /**
       * The charge that paid the period ending at `periodEndsAt` was refunded in
       * full. A partial refund is a commercial gesture and is not a fact.
       */
      occurredAt: Date;
      periodEndsAt: Date;
      type: "charge_refunded";
    }
  | {
      /** The charge that paid the period ending at `periodEndsAt` was charged back. */
      occurredAt: Date;
      periodEndsAt: Date;
      type: "charge_disputed";
    }
  | {
      /** The chargeback on the period ending at `periodEndsAt` was decided in Polaris's favour. */
      occurredAt: Date;
      periodEndsAt: Date;
      type: "dispute_reversed";
    };

export type BillingFactType = BillingFact["type"];

export const BILLING_FACT_TYPES = [
  "trial_method_ready",
  "charge_succeeded",
  "charge_failed",
  "subscription_cancelled",
  "cycle_change_scheduled",
  "charge_refunded",
  "charge_disputed",
  "dispute_reversed",
] as const satisfies readonly BillingFactType[];

/**
 * What is remembered of a payment taken back (PR84): the period it paid for, why
 * it was taken back, and what the subscription was (to restore it). It keeps a
 * late confirmation of that same payment from reviving the access and lets a
 * chargeback decided in Polaris's favour restore it. `won` remembers a
 * chargeback that was reversed before it was ever applied (delivered out of
 * order), so that the chargeback, when it arrives, changes nothing.
 */
export interface RevokedPayment {
  /** The subscription was cancelled when the payment was taken back (kept through a restore). */
  cancelAtPeriodEnd: boolean;
  /** The cycle the subscription had, to restore a reversed chargeback. */
  cycleMonths: BillingCycleMonths | null;
  /** The end of the period that was paid for. */
  periodEndsAt: Date;
  reason: "chargeback" | "refund" | "won";
}

/**
 * Providers round the end of a period differently from one event to the next
 * (to midnight, to the day): two ends within a day of each other are the same
 * period.
 */
const PERIOD_MATCH_TOLERANCE_MS = 86_400_000;
const samePeriod = (left: Date, right: Date): boolean =>
  Math.abs(left.getTime() - right.getTime()) <= PERIOD_MATCH_TOLERANCE_MS;

/** The organization's whole billing record: the facts of the state machine and what the lifecycle adds. */
export interface BillingRecord extends BillingFacts {
  /** The subscription was cancelled; access ends with the period already paid for. */
  cancelAtPeriodEnd: boolean;
  /** The cycle being paid, while Pro. */
  cycleMonths: BillingCycleMonths | null;
  /** The moment of the newest fact applied (never later than the moment it was applied); an older fact is stale. */
  lastFactAt: Date | null;
  /** A cycle change that takes effect at the next renewal. */
  pendingCycleMonths: BillingCycleMonths | null;
  /** The newest payment taken back by a refund or a chargeback, while the record is not Pro. */
  revoked: RevokedPayment | null;
  /** The trial was used, or waived by subscribing without one: it is offered once. */
  trialConsumed: boolean;
}

export interface ReconcileContext {
  now: Date;
  /** True when the organization holds more than the free plan allows. */
  overFreeLimits: boolean;
}

export type IgnoredFactReason = "not_applicable" | "stale";

export type ReconcileResult =
  | {
      outcome: "applied";
      record: BillingRecord;
      /** The state machine event that moved the record, when one did. */
      transition: BillingEvent["type"] | null;
    }
  | { outcome: "ignored"; reason: IgnoredFactReason };

const ignored = (reason: IgnoredFactReason): ReconcileResult => ({
  outcome: "ignored",
  reason,
});

/** What leaving Pro clears: a free record has no cycle and nothing pending. */
function normalized(record: BillingRecord): BillingRecord {
  return grantsPro(record.state)
    ? record
    : {
        ...record,
        cancelAtPeriodEnd: false,
        cycleMonths: null,
        pendingCycleMonths: null,
      };
}

/** Runs one event through the state machine; null when the machine refuses it. */
function moved(
  record: BillingRecord,
  event: BillingEvent,
  context: ReconcileContext,
  /** The moment the event is taken to happen, when that is not the moment it is processed. */
  at: Date = context.now
): { facts: BillingFacts; transition: BillingEvent["type"] } | null {
  try {
    return {
      facts: applyBillingEvent(record, event, {
        now: at,
        overFreeLimits: context.overFreeLimits,
        trialConsumed: record.trialConsumed,
      }),
      transition: event.type,
    };
  } catch (error: unknown) {
    if (
      error instanceof InvalidBillingTransitionError ||
      error instanceof RejectedBillingEventError
    ) {
      return null;
    }
    throw error;
  }
}

/**
 * What is remembered of a payment taken back: nothing once the record is paid
 * again (a new payment is a new period), otherwise what the change says, or what
 * was. A trial is not a payment: it keeps what is remembered.
 */
function revokedAfter(
  before: BillingRecord,
  next: Partial<BillingRecord> & BillingFacts
): RevokedPayment | null {
  if (next.state === "active" || next.state === "grace") {
    return null;
  }
  return next.revoked === undefined ? before.revoked : next.revoked;
}

function applied(
  before: BillingRecord,
  next: Partial<BillingRecord> & BillingFacts,
  transition: BillingEvent["type"] | null,
  occurredAt: Date | null,
  now: Date
): ReconcileResult {
  const record = normalized({
    ...before,
    ...next,
    // new Pro access is a new payment: what was taken back before no longer matters
    revoked: revokedAfter(before, next),
    // an older fact never rewinds the clock of facts, and a fact dated in the
    // future (a skewed provider clock) never pushes it past the present, which
    // would make every later, legitimate fact look stale
    lastFactAt:
      occurredAt === null
        ? before.lastFactAt
        : new Date(
            Math.max(
              before.lastFactAt?.getTime() ?? 0,
              Math.min(occurredAt.getTime(), now.getTime())
            )
          ),
    // the trial is used by running it and waived by paying without it
    trialConsumed: before.trialConsumed || grantsPro(next.state),
  });
  return { outcome: "applied", record, transition };
}

const FREE_STATES: readonly BillingState[] = ["free", "free_over_limit"];

function chargeSucceeded(
  record: BillingRecord,
  fact: Extract<BillingFact, { type: "charge_succeeded" }>,
  context: ReconcileContext
): ReconcileResult {
  // the payment that was refunded or charged back is not the one that revives
  // access, however late its confirmation arrives; a later payment is a new one
  if (
    record.revoked &&
    record.revoked.reason !== "won" &&
    fact.periodEndsAt.getTime() <=
      record.revoked.periodEndsAt.getTime() + PERIOD_MATCH_TOLERANCE_MS
  ) {
    return ignored("not_applicable");
  }
  // a late confirmation after the record went back to free revives it: the
  // customer paid, so the payment is what matters
  const fromFree =
    FREE_STATES.includes(record.state) || record.state === "trial_setup";
  const event: BillingEvent = fromFree
    ? { periodEndsAt: fact.periodEndsAt, type: "subscribe" }
    : { periodEndsAt: fact.periodEndsAt, type: "payment_succeeded" };
  const result = moved(record, event, context);
  if (!result) {
    return ignored("not_applicable");
  }
  // a payment older than a fact already applied was overtaken by it (a delayed
  // confirmation): it extends the access, but must not undo what came after it
  const overtaken =
    record.lastFactAt !== null &&
    fact.occurredAt.getTime() < record.lastFactAt.getTime();
  return applied(
    record,
    {
      ...result.facts,
      // a charge that went through means the subscription goes on, unless a
      // cancellation came after it
      cancelAtPeriodEnd: overtaken ? record.cancelAtPeriodEnd : false,
      cycleMonths: fact.cycleMonths,
      // a scheduled cycle change that this charge carried out is done
      pendingCycleMonths:
        record.pendingCycleMonths === fact.cycleMonths
          ? null
          : record.pendingCycleMonths,
    },
    result.transition,
    fact.occurredAt,
    context.now
  );
}

function chargeFailed(
  record: BillingRecord,
  fact: Extract<BillingFact, { type: "charge_failed" }>,
  context: ReconcileContext
): ReconcileResult {
  const endsAt = record.accessEndsAt ?? context.now;
  let event: BillingEvent | null = null;
  // the first charge after the trial failed: no Pro without payment. The
  // provider says the trial is over, even if our own end of it is a few
  // minutes later than the provider's.
  let at = context.now;
  if (record.state === "trialing") {
    event = { type: "trial_ended_without_payment" };
    at = new Date(Math.max(context.now.getTime(), endsAt.getTime()));
  } else if (record.state === "active") {
    // grace counts from the end of the period that was paid for, however late
    // the failure is reported
    event = { type: "payment_failed" };
    at = endsAt;
  }
  if (!event) {
    return ignored("not_applicable");
  }
  const result = moved(record, event, context, at);
  if (!result) {
    return ignored("not_applicable");
  }
  return applied(
    record,
    result.facts,
    result.transition,
    fact.occurredAt,
    context.now
  );
}

function subscriptionCancelled(
  record: BillingRecord,
  fact: Extract<BillingFact, { type: "subscription_cancelled" }>,
  context: ReconcileContext
): ReconcileResult {
  if (record.state === "trial_setup") {
    const result = moved(record, { type: "abandon_trial_setup" }, context);
    return result
      ? applied(
          record,
          result.facts,
          result.transition,
          fact.occurredAt,
          context.now
        )
      : ignored("not_applicable");
  }
  if (!grantsPro(record.state) || record.cancelAtPeriodEnd) {
    return ignored("not_applicable");
  }
  return applied(
    record,
    { ...record, cancelAtPeriodEnd: true },
    null,
    fact.occurredAt,
    context.now
  );
}

function cycleChangeScheduled(
  record: BillingRecord,
  fact: Extract<BillingFact, { type: "cycle_change_scheduled" }>,
  context: ReconcileContext
): ReconcileResult {
  if (!grantsPro(record.state)) {
    return ignored("not_applicable");
  }
  // asking for the cycle already in force cancels a pending change
  const pending =
    fact.cycleMonths === record.cycleMonths ? null : fact.cycleMonths;
  if (pending === record.pendingCycleMonths) {
    return ignored("not_applicable");
  }
  return applied(
    record,
    { ...record, pendingCycleMonths: pending },
    null,
    fact.occurredAt,
    context.now
  );
}

const DAY = 86_400_000;

/**
 * The end of the paid period the record is standing on: the access end while
 * active, and the end of the period that ran out while in grace (grace is
 * counted from it). Null where no paid period is in force.
 */
function paidPeriodEnd(record: BillingRecord): Date | null {
  if (record.accessEndsAt === null) {
    return null;
  }
  if (record.state === "active") {
    return record.accessEndsAt;
  }
  if (record.state === "grace") {
    return new Date(record.accessEndsAt.getTime() - GRACE_DAYS * DAY);
  }
  return null;
}

/** A period end a provider could really report: still ahead, and no further than a paid period can run. */
function reasonableFutureEnd(end: Date, now: Date): boolean {
  const time = end.getTime();
  return (
    Number.isFinite(time) &&
    time > now.getTime() &&
    time <= now.getTime() + MAX_PERIOD_DAYS * DAY
  );
}

/** Records a payment taken back without changing the state (the access is not there to take). */
function remember(
  record: BillingRecord,
  fact: Extract<BillingFact, { type: "charge_disputed" | "charge_refunded" }>,
  context: ReconcileContext
): ReconcileResult {
  const reason = fact.type === "charge_disputed" ? "chargeback" : "refund";
  return applied(
    record,
    {
      ...record,
      revoked: {
        cancelAtPeriodEnd: record.cancelAtPeriodEnd,
        cycleMonths: record.cycleMonths,
        periodEndsAt: fact.periodEndsAt,
        reason,
      },
    },
    null,
    fact.occurredAt,
    context.now
  );
}

/**
 * A refund in full, or a chargeback, of the payment behind the current paid
 * period takes the access back at once (a chargeback is just as immediate: there
 * is no grace). The period the fact names must be the one in force (within the
 * provider's rounding): a payment of an earlier period changes nothing, and
 * neither does a refund of a period that is not paid yet, which only has its
 * payment remembered so that when the charge's confirmation arrives later it
 * cannot grant what was already given back. The period is remembered when the
 * access is taken, for the same reason.
 */
function revokePayment(
  record: BillingRecord,
  fact: Extract<BillingFact, { type: "charge_disputed" | "charge_refunded" }>,
  context: ReconcileContext
): ReconcileResult {
  const existing = record.revoked;
  if (existing && samePeriod(existing.periodEndsAt, fact.periodEndsAt)) {
    // the same payment again: a refund overrides what a chargeback could restore
    // (the customer has the money), and nothing else adds anything
    if (fact.type === "charge_refunded" && existing.reason !== "refund") {
      return applied(
        record,
        { ...record, revoked: { ...existing, reason: "refund" } },
        null,
        fact.occurredAt,
        context.now
      );
    }
    return ignored("not_applicable");
  }
  if (
    existing &&
    existing.periodEndsAt.getTime() > fact.periodEndsAt.getTime()
  ) {
    return ignored("not_applicable");
  }
  const paidEnd = paidPeriodEnd(record);
  if (paidEnd !== null && samePeriod(paidEnd, fact.periodEndsAt)) {
    const result = moved(record, { type: "access_revoked" }, context);
    if (!result) {
      return ignored("not_applicable");
    }
    return applied(
      record,
      {
        ...result.facts,
        revoked: {
          cancelAtPeriodEnd: record.cancelAtPeriodEnd,
          cycleMonths: record.cycleMonths,
          periodEndsAt: fact.periodEndsAt,
          reason: fact.type === "charge_disputed" ? "chargeback" : "refund",
        },
      },
      result.transition,
      fact.occurredAt,
      context.now
    );
  }
  const earlier =
    paidEnd !== null &&
    fact.periodEndsAt.getTime() < paidEnd.getTime() - PERIOD_MATCH_TOLERANCE_MS;
  if (
    earlier ||
    grantsPaid(record) ||
    !reasonableFutureEnd(fact.periodEndsAt, context.now)
  ) {
    return ignored("not_applicable");
  }
  // a payment that is not on the record yet: its confirmation is on its way
  return remember(record, fact, context);
}

/** A record standing on a paid period cannot hold a remembered payment: it is the period that counts. */
function grantsPaid(record: BillingRecord): boolean {
  return record.state === "active" || record.state === "grace";
}

/**
 * A chargeback decided in Polaris's favour restores the access for what is left
 * of the period that was charged back, with its cycle and whether it was
 * cancelled, as a payment (the ledger shows the transition). If the period is
 * over by then there is nothing to restore and the record only forgets the
 * chargeback. A reversal that has no chargeback on record is remembered when the
 * period is still ahead (it may have overtaken its chargeback), so that the
 * chargeback, arriving later, changes nothing; otherwise, or for a refund or
 * another period, it is ignored.
 */
function disputeReversed(
  record: BillingRecord,
  fact: Extract<BillingFact, { type: "dispute_reversed" }>,
  context: ReconcileContext
): ReconcileResult {
  const { revoked } = record;
  if (
    revoked?.reason === "chargeback" &&
    samePeriod(revoked.periodEndsAt, fact.periodEndsAt)
  ) {
    const forget = (): ReconcileResult =>
      applied(
        record,
        { ...record, revoked: null },
        null,
        fact.occurredAt,
        context.now
      );
    if (revoked.periodEndsAt.getTime() <= context.now.getTime()) {
      return forget();
    }
    const event: BillingEvent = {
      periodEndsAt: revoked.periodEndsAt,
      type: record.state === "trialing" ? "payment_succeeded" : "subscribe",
    };
    const result = moved(record, event, context);
    if (!result) {
      return forget();
    }
    return applied(
      record,
      {
        ...result.facts,
        cancelAtPeriodEnd: revoked.cancelAtPeriodEnd,
        cycleMonths: revoked.cycleMonths ?? 1,
        pendingCycleMonths: null,
      },
      result.transition,
      fact.occurredAt,
      context.now
    );
  }
  if (
    revoked === null &&
    !grantsPaid(record) &&
    reasonableFutureEnd(fact.periodEndsAt, context.now)
  ) {
    return applied(
      record,
      {
        ...record,
        revoked: {
          cancelAtPeriodEnd: false,
          cycleMonths: null,
          periodEndsAt: fact.periodEndsAt,
          reason: "won",
        },
      },
      null,
      fact.occurredAt,
      context.now
    );
  }
  return ignored("not_applicable");
}

function trialMethodReady(
  record: BillingRecord,
  fact: Extract<BillingFact, { type: "trial_method_ready" }>,
  context: ReconcileContext
): ReconcileResult {
  let current = record;
  // the method being ready means the person opted in: if this fact overtook the
  // command that records the opt-in, the opt-in is implied (a trial offered once)
  if (FREE_STATES.includes(record.state)) {
    const start = moved(record, { type: "start_trial" }, context);
    if (!start) {
      return ignored("not_applicable");
    }
    current = { ...record, ...start.facts };
  }
  const result = moved(current, { type: "renewal_ready" }, context);
  if (!result) {
    return ignored("not_applicable");
  }
  return applied(
    record,
    { ...result.facts, cycleMonths: fact.cycleMonths },
    result.transition,
    fact.occurredAt,
    context.now
  );
}

/** The facts about money that already moved: never dropped as stale. */
const MONEY_FACTS: readonly BillingFactType[] = [
  "charge_succeeded",
  "charge_refunded",
  "charge_disputed",
  "dispute_reversed",
];

/**
 * Applies a provider fact to the record. A fact older than the newest one
 * already applied is stale and changes nothing (a delayed or reordered
 * delivery never rewinds the record); a fact that does not fit the state (a
 * repeat, a failure while already in grace) is not applicable. Neither is an
 * error: both are recorded as ignored. Only an applied fact moves the clock of
 * facts, so an ignored one can never make a later, valid fact look stale.
 *
 * A confirmed payment is the exception to staleness: the customer paid, so a
 * delayed confirmation behind a later cancellation or cycle change must still
 * extend the access. It is protected differently, by the state machine: a
 * payment never moves the end of access backwards and its period must end in
 * the future. A refund, a chargeback and the reversal of one are exceptions for
 * the same reason (money moved): each names the period it concerns, which is
 * what protects it (a refund of an earlier period changes nothing).
 */
export function reconcileFact(
  record: BillingRecord,
  fact: BillingFact,
  context: ReconcileContext
): ReconcileResult {
  if (
    !MONEY_FACTS.includes(fact.type) &&
    record.lastFactAt !== null &&
    fact.occurredAt.getTime() < record.lastFactAt.getTime()
  ) {
    return ignored("stale");
  }
  switch (fact.type) {
    case "trial_method_ready":
      return trialMethodReady(record, fact, context);
    case "charge_succeeded":
      return chargeSucceeded(record, fact, context);
    case "charge_failed":
      return chargeFailed(record, fact, context);
    case "subscription_cancelled":
      return subscriptionCancelled(record, fact, context);
    case "cycle_change_scheduled":
      return cycleChangeScheduled(record, fact, context);
    case "charge_refunded":
    case "charge_disputed":
      return revokePayment(record, fact, context);
    case "dispute_reversed":
      return disputeReversed(record, fact, context);
    default:
      return ignored("not_applicable");
  }
}

/**
 * The transition that time itself causes, once the access of the record has
 * run out (null before that, and for the free states). The provider reports a
 * charge around the end of the period, so silence at that moment is read
 * conservatively: a paid period that nobody renewed or cancelled goes into the
 * seven days of grace, counted from the end of that period (not from when the
 * sweep happened to run), a cancelled one ends, and a trial without a first
 * charge ends. A late confirmation still revives the record
 * (`charge_succeeded` from free).
 */
export function dueTransition(
  record: BillingRecord,
  context: ReconcileContext
): { record: BillingRecord; transition: BillingEvent["type"] } | null {
  if (
    !grantsPro(record.state) ||
    record.accessEndsAt === null ||
    context.now.getTime() < record.accessEndsAt.getTime()
  ) {
    return null;
  }
  let event: BillingEvent;
  let at = context.now;
  if (record.state === "trialing") {
    event = { type: "trial_ended_without_payment" };
  } else if (record.state === "active") {
    if (record.cancelAtPeriodEnd) {
      event = { type: "period_ended" };
    } else {
      event = { type: "payment_failed" };
      // a late sweep must not give back access that already ran out
      at = record.accessEndsAt;
    }
  } else {
    event = { type: "grace_expired" };
  }
  const result = moved(record, event, context, at);
  if (!result) {
    return null;
  }
  const next = applied(
    record,
    result.facts,
    result.transition,
    null,
    context.now
  );
  return next.outcome === "applied"
    ? { record: next.record, transition: result.transition }
    : null;
}

/** The structural invariants every reachable billing record keeps. */
export function isCoherentBillingRecord(record: BillingRecord): boolean {
  const pro = grantsPro(record.state);
  const accessOk = pro
    ? record.accessEndsAt !== null &&
      Number.isFinite(record.accessEndsAt.getTime())
    : record.accessEndsAt === null;
  const flagsOk = pro
    ? record.cycleMonths !== null
    : !record.cancelAtPeriodEnd &&
      record.cycleMonths === null &&
      record.pendingCycleMonths === null;
  // a record that was Pro has used or waived the trial
  const trialOk = !pro || record.trialConsumed;
  // a payment taken back is remembered only while there is no Pro access
  const revokedOk = !(grantsPaid(record) && record.revoked);
  return accessOk && flagsOk && trialOk && revokedOk;
}

/** A fact as the inbox stores it: plain JSON, dates as ISO text, no personal data. */
export function serializeBillingFact(
  fact: BillingFact
): Record<string, number | string> {
  const base = { occurredAt: fact.occurredAt.toISOString(), type: fact.type };
  switch (fact.type) {
    case "trial_method_ready":
    case "cycle_change_scheduled":
      return { ...base, cycleMonths: fact.cycleMonths };
    case "charge_succeeded":
      return {
        ...base,
        cycleMonths: fact.cycleMonths,
        periodEndsAt: fact.periodEndsAt.toISOString(),
      };
    case "charge_refunded":
    case "charge_disputed":
    case "dispute_reversed":
      return { ...base, periodEndsAt: fact.periodEndsAt.toISOString() };
    default:
      return base;
  }
}

function dateField(value: unknown): Date | null {
  if (typeof value !== "string") {
    return null;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function cycleField(value: unknown): BillingCycleMonths | null {
  return typeof value === "number" && isBillingCycleMonths(value)
    ? value
    : null;
}

/**
 * Reads a stored fact back, refusing anything that is not exactly one of the
 * known facts (a malformed row is a failed event, never a guess).
 */
export function parseBillingFact(value: unknown): BillingFact | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const occurredAt = dateField(record.occurredAt);
  if (!occurredAt) {
    return null;
  }
  const cycleMonths = cycleField(record.cycleMonths);
  switch (record.type) {
    case "trial_method_ready":
    case "cycle_change_scheduled":
      return cycleMonths
        ? { cycleMonths, occurredAt, type: record.type }
        : null;
    case "charge_succeeded": {
      const periodEndsAt = dateField(record.periodEndsAt);
      return cycleMonths && periodEndsAt
        ? { cycleMonths, occurredAt, periodEndsAt, type: "charge_succeeded" }
        : null;
    }
    case "charge_refunded":
    case "charge_disputed":
    case "dispute_reversed": {
      const periodEndsAt = dateField(record.periodEndsAt);
      return periodEndsAt
        ? { occurredAt, periodEndsAt, type: record.type }
        : null;
    }
    case "charge_failed":
    case "subscription_cancelled":
      return { occurredAt, type: record.type };
    default:
      return null;
  }
}
