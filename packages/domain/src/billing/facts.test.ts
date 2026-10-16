import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type BillingState, grantsPro } from "./entitlements";
import {
  BILLING_CYCLE_MONTHS,
  type BillingCycleMonths,
  type BillingFact,
  type BillingRecord,
  dueTransition,
  isCoherentBillingRecord,
  parseBillingFact,
  type ReconcileContext,
  reconcileFact,
  serializeBillingFact,
} from "./facts";
import { GRACE_DAYS, TRIAL_DAYS } from "./subscription-state";

const DAY = 86_400_000;
const base = new Date("2026-10-14T12:00:00.000Z");
const at = (days: number, from = base) => new Date(from.getTime() + days * DAY);
const ctx = (now = base, overFreeLimits = false): ReconcileContext => ({
  now,
  overFreeLimits,
});

const free = (overrides: Partial<BillingRecord> = {}): BillingRecord => ({
  accessEndsAt: null,
  cancelAtPeriodEnd: false,
  cycleMonths: null,
  lastFactAt: null,
  pendingCycleMonths: null,
  revoked: null,
  state: "free",
  trialConsumed: false,
  ...overrides,
});
const pro = (
  state: "active" | "grace" | "trialing",
  accessEndsAt: Date,
  overrides: Partial<BillingRecord> = {}
): BillingRecord => ({
  accessEndsAt,
  cancelAtPeriodEnd: false,
  cycleMonths: 1,
  lastFactAt: null,
  pendingCycleMonths: null,
  revoked: null,
  state,
  trialConsumed: state === "trialing" || overrides.trialConsumed === true,
  ...overrides,
});

const succeeded = (
  occurredAt: Date,
  periodEndsAt: Date,
  cycleMonths: BillingCycleMonths = 1
): BillingFact => ({
  cycleMonths,
  occurredAt,
  periodEndsAt,
  type: "charge_succeeded",
});
const failed = (occurredAt: Date): BillingFact => ({
  occurredAt,
  type: "charge_failed",
});

function applied(record: BillingRecord, fact: BillingFact, c = ctx()) {
  const result = reconcileFact(record, fact, c);
  if (result.outcome !== "applied") {
    throw new Error(`expected applied, got ${result.reason}`);
  }
  return result;
}

describe("the life of a subscription, fact by fact", () => {
  it("trial: the renewal method is ready, the trial runs, the first charge converts it", () => {
    const setup = free({ state: "trial_setup" });
    const ready = applied(setup, {
      cycleMonths: 1,
      occurredAt: base,
      type: "trial_method_ready",
    });
    expect(ready.transition).toBe("renewal_ready");
    expect(ready.record).toMatchObject({
      accessEndsAt: at(TRIAL_DAYS),
      cycleMonths: 1,
      state: "trialing",
      trialConsumed: true,
    });
    const paid = applied(ready.record, succeeded(at(7), at(37)), ctx(at(7)));
    expect(paid.transition).toBe("payment_succeeded");
    expect(paid.record).toMatchObject({
      accessEndsAt: at(37),
      state: "active",
    });
  });

  it("the first charge failing ends the trial without Pro", () => {
    const trialing = pro("trialing", at(7));
    const result = applied(trialing, failed(at(7)), ctx(at(7)));
    expect(result.transition).toBe("trial_ended_without_payment");
    expect(result.record).toMatchObject({
      accessEndsAt: null,
      cycleMonths: null,
      state: "free",
    });
    expect(isCoherentBillingRecord(result.record)).toBe(true);
  });

  it("a failed renewal gives seven days of grace after the paid period, and a payment in grace brings Pro back", () => {
    const active = pro("active", at(30));
    const result = applied(active, failed(at(30)), ctx(at(30)));
    expect(result.transition).toBe("payment_failed");
    expect(result.record).toMatchObject({
      accessEndsAt: at(30 + GRACE_DAYS),
      state: "grace",
    });
    const recovered = applied(
      result.record,
      succeeded(at(32), at(62)),
      ctx(at(32))
    );
    expect(recovered.record).toMatchObject({
      accessEndsAt: at(62),
      state: "active",
    });
  });

  it("a renewal moves the end of the period and applies a scheduled cycle change", () => {
    const active = pro("active", at(30), { pendingCycleMonths: 12 });
    const result = applied(active, succeeded(at(29), at(395), 12), ctx(at(29)));
    expect(result.record).toMatchObject({
      accessEndsAt: at(395),
      cycleMonths: 12,
      pendingCycleMonths: null,
    });
  });

  it("a cancellation keeps the access to the end of what was paid, and a later charge undoes it", () => {
    const active = pro("active", at(30));
    const cancelled = applied(active, {
      occurredAt: at(5),
      type: "subscription_cancelled",
    });
    expect(cancelled.transition).toBeNull();
    expect(cancelled.record).toMatchObject({
      accessEndsAt: at(30),
      cancelAtPeriodEnd: true,
      state: "active",
    });
    const charged = applied(
      cancelled.record,
      succeeded(at(29), at(60)),
      ctx(at(29))
    );
    expect(charged.record.cancelAtPeriodEnd).toBe(false);
  });

  it("cancelling while the trial is being set up abandons it", () => {
    const result = applied(free({ state: "trial_setup" }), {
      occurredAt: base,
      type: "subscription_cancelled",
    });
    expect(result.transition).toBe("abandon_trial_setup");
    expect(result.record.state).toBe("free");
  });

  it("a cycle change is pending until the next renewal, asking for the current cycle cancels it", () => {
    const active = pro("active", at(30));
    const scheduled = applied(active, {
      cycleMonths: 12,
      occurredAt: at(2),
      type: "cycle_change_scheduled",
    });
    expect(scheduled.record.pendingCycleMonths).toBe(12);
    const undone = applied(scheduled.record, {
      cycleMonths: 1,
      occurredAt: at(3),
      type: "cycle_change_scheduled",
    });
    expect(undone.record.pendingCycleMonths).toBeNull();
  });

  it("a late confirmation after the record went back to free revives it", () => {
    const lapsed = free({ lastFactAt: at(-1) });
    const result = applied(lapsed, succeeded(base, at(30)));
    expect(result.transition).toBe("subscribe");
    expect(result.record).toMatchObject({
      accessEndsAt: at(30),
      cycleMonths: 1,
      state: "active",
    });
  });

  it("leaving Pro lands on free_over_limit when the organization holds more than free allows", () => {
    const trialing = pro("trialing", at(7));
    const result = applied(trialing, failed(at(7)), ctx(at(7), true));
    expect(result.record.state).toBe("free_over_limit");
  });
});

describe("what a fact cannot do", () => {
  it("a stale fact changes nothing, and neither does one that does not fit the state", () => {
    const active = pro("active", at(30), { lastFactAt: at(10) });
    expect(reconcileFact(active, failed(at(9)), ctx())).toEqual({
      outcome: "ignored",
      reason: "stale",
    });
    // a failure while already in grace, a cancel in the free state
    const grace = pro("grace", at(37), { lastFactAt: at(10) });
    expect(reconcileFact(grace, failed(at(31)), ctx(at(31)))).toEqual({
      outcome: "ignored",
      reason: "not_applicable",
    });
    expect(
      reconcileFact(
        free(),
        { occurredAt: base, type: "subscription_cancelled" },
        ctx()
      )
    ).toEqual({ outcome: "ignored", reason: "not_applicable" });
  });

  it("a repeated charge confirmation is not applicable, and cancelling twice neither", () => {
    const first = applied(
      pro("active", at(30)),
      succeeded(at(29), at(60)),
      ctx(at(29))
    );
    const again = reconcileFact(
      first.record,
      succeeded(at(29), at(60)),
      ctx(at(29))
    );
    expect(again).toEqual({ outcome: "ignored", reason: "not_applicable" });
    const cancelled = applied(first.record, {
      occurredAt: at(30),
      type: "subscription_cancelled",
    });
    expect(
      reconcileFact(
        cancelled.record,
        { occurredAt: at(31), type: "subscription_cancelled" },
        ctx(at(31))
      )
    ).toEqual({ outcome: "ignored", reason: "not_applicable" });
  });

  it("an ignored fact does not move the clock of facts, so a later valid fact is never stale", () => {
    const grace = pro("grace", at(37), { lastFactAt: at(10) });
    // a failure while in grace is ignored at day 40 ...
    const ignoredFailure = reconcileFact(grace, failed(at(40)), ctx(at(40)));
    expect(ignoredFailure.outcome).toBe("ignored");
    // ... and the payment of day 35, delivered later, still applies
    const payment = reconcileFact(
      grace,
      succeeded(at(35), at(65)),
      ctx(at(36))
    );
    expect(payment.outcome).toBe("applied");
  });

  it("an invalid period end is not applicable, never a crash", () => {
    const active = pro("active", at(30));
    expect(reconcileFact(active, succeeded(base, at(-1)), ctx()).outcome).toBe(
      "ignored"
    );
    expect(
      reconcileFact(active, succeeded(base, new Date(Number.NaN)), ctx())
        .outcome
    ).toBe("ignored");
  });
});

describe("what time does by itself", () => {
  it("does nothing before the access ends, nor in a free state", () => {
    expect(dueTransition(pro("active", at(30)), ctx(at(29)))).toBeNull();
    expect(dueTransition(free(), ctx())).toBeNull();
  });

  it("ends a trial nobody charged, ends a cancelled period, and gives an unrenewed one its grace", () => {
    expect(dueTransition(pro("trialing", at(7)), ctx(at(7)))).toMatchObject({
      record: { state: "free" },
      transition: "trial_ended_without_payment",
    });
    expect(
      dueTransition(
        pro("active", at(30), { cancelAtPeriodEnd: true }),
        ctx(at(30))
      )
    ).toMatchObject({
      record: { cancelAtPeriodEnd: false, state: "free" },
      transition: "period_ended",
    });
    expect(dueTransition(pro("active", at(30)), ctx(at(30)))).toMatchObject({
      record: { accessEndsAt: at(30 + GRACE_DAYS), state: "grace" },
      transition: "payment_failed",
    });
  });

  it("ends the grace, into free_over_limit when the organization is over the free limits", () => {
    expect(
      dueTransition(pro("grace", at(37)), ctx(at(37), true))
    ).toMatchObject({
      record: { state: "free_over_limit" },
      transition: "grace_expired",
    });
  });
});

const states: BillingState[] = [
  "free",
  "trial_setup",
  "trialing",
  "active",
  "grace",
  "free_over_limit",
];

describe("properties of any sequence of facts", () => {
  const cycle = fc.constantFrom(...BILLING_CYCLE_MONTHS);
  const factArb = (clock: Date): fc.Arbitrary<BillingFact> =>
    fc
      .tuple(
        fc.integer({ max: 40, min: -3 }),
        cycle,
        // a small pool of period ends: a chargeback and its reversal name the same period
        fc.constantFrom(3, 10, 20, 35, 60, 200, 400)
      )
      .chain(([offset, cycleMonths, periodDays]) => {
        const occurredAt = at(offset, clock);
        return fc.constantFrom<BillingFact>(
          { cycleMonths, occurredAt, type: "trial_method_ready" },
          {
            cycleMonths,
            occurredAt,
            periodEndsAt: at(periodDays, clock),
            type: "charge_succeeded",
          },
          { occurredAt, type: "charge_failed" },
          { occurredAt, type: "subscription_cancelled" },
          { cycleMonths, occurredAt, type: "cycle_change_scheduled" },
          {
            occurredAt,
            periodEndsAt: at(periodDays, clock),
            type: "charge_refunded",
          },
          {
            occurredAt,
            periodEndsAt: at(periodDays, clock),
            type: "charge_disputed",
          },
          {
            occurredAt,
            periodEndsAt: at(periodDays, clock),
            type: "dispute_reversed",
          }
        );
      });
  const sequence = fc.array(
    fc.tuple(factArb(base), fc.integer({ max: 20, min: 0 }), fc.boolean()),
    { maxLength: 30 }
  );
  const marker = fc.constantFrom<BillingRecord["revoked"]>(
    null,
    {
      cancelAtPeriodEnd: false,
      cycleMonths: 6,
      periodEndsAt: at(20),
      reason: "chargeback",
    },
    {
      cancelAtPeriodEnd: true,
      cycleMonths: null,
      periodEndsAt: at(35),
      reason: "chargeback",
    },
    {
      cancelAtPeriodEnd: false,
      cycleMonths: 1,
      periodEndsAt: at(10),
      reason: "refund",
    },
    {
      cancelAtPeriodEnd: false,
      cycleMonths: null,
      periodEndsAt: at(20),
      reason: "won",
    }
  );
  const start = fc
    .tuple(fc.constantFrom(...states), marker)
    .map(([state, revoked]): BillingRecord => {
      if (grantsPro(state)) {
        const record = pro(state as "active" | "grace" | "trialing", at(10));
        // a paid period can only remember a won chargeback; a trial can remember any
        return revoked && (state === "trialing" || revoked.reason === "won")
          ? { ...record, revoked }
          : record;
      }
      return free({ revoked, state });
    });

  it("the record always stays coherent, and the clock of facts never goes back", () => {
    fc.assert(
      fc.property(start, sequence, (initial, steps) => {
        let record = initial;
        let clock = base;
        for (const [fact, advance, over] of steps) {
          clock = at(advance, clock);
          const result = reconcileFact(record, fact, ctx(clock, over));
          if (result.outcome === "ignored") {
            continue;
          }
          expect(isCoherentBillingRecord(result.record)).toBe(true);
          expect(
            result.record.lastFactAt?.getTime() ?? 0
          ).toBeGreaterThanOrEqual(record.lastFactAt?.getTime() ?? 0);
          ({ record } = result);
          // time passing also keeps it coherent
          const due = dueTransition(record, ctx(clock, over));
          if (due) {
            expect(isCoherentBillingRecord(due.record)).toBe(true);
            ({ record } = due);
          }
        }
      })
    );
  });

  it("applying the same fact twice never applies it twice", () => {
    fc.assert(
      fc.property(start, factArb(base), fc.boolean(), (initial, fact, over) => {
        const first = reconcileFact(initial, fact, ctx(base, over));
        if (first.outcome === "ignored") {
          return;
        }
        const second = reconcileFact(first.record, fact, ctx(base, over));
        // the repeat is either refused, or leaves the record as the first left it
        // (a reversal delivered again after a restore is remembered, harmlessly)
        if (second.outcome === "applied" && fact.type !== "dispute_reversed") {
          expect(second.record).toEqual(first.record);
        }
      })
    );
  });

  it("a payment fact never ends access earlier than it was before", () => {
    fc.assert(
      fc.property(start, factArb(base), (initial, fact) => {
        if (fact.type !== "charge_succeeded") {
          return;
        }
        const result = reconcileFact(initial, fact, ctx(base));
        if (result.outcome === "ignored") {
          return;
        }
        expect(result.record.accessEndsAt?.getTime()).toBeGreaterThan(
          base.getTime()
        );
        if (initial.state === "active") {
          expect(result.record.accessEndsAt?.getTime()).toBeGreaterThan(
            initial.accessEndsAt?.getTime() ?? 0
          );
        }
      })
    );
  });
});

describe("facts in the inbox", () => {
  const sample: BillingFact[] = [
    { cycleMonths: 6, occurredAt: base, type: "trial_method_ready" },
    {
      cycleMonths: 12,
      occurredAt: base,
      periodEndsAt: at(365),
      type: "charge_succeeded",
    },
    { occurredAt: base, type: "charge_failed" },
    { occurredAt: base, type: "subscription_cancelled" },
    { cycleMonths: 1, occurredAt: base, type: "cycle_change_scheduled" },
    { occurredAt: base, periodEndsAt: at(30), type: "charge_refunded" },
    { occurredAt: base, periodEndsAt: at(30), type: "charge_disputed" },
    { occurredAt: base, periodEndsAt: at(30), type: "dispute_reversed" },
  ];

  it("round-trips every fact through plain JSON", () => {
    for (const fact of sample) {
      const stored = JSON.parse(JSON.stringify(serializeBillingFact(fact)));
      expect(parseBillingFact(stored)).toEqual(fact);
    }
  });

  it("refuses anything that is not exactly a known fact", () => {
    for (const value of [
      null,
      "x",
      [],
      {},
      { occurredAt: base.toISOString(), type: "payment_received" },
      { occurredAt: "yesterday", type: "charge_failed" },
      { occurredAt: base.toISOString(), type: "trial_method_ready" },
      {
        cycleMonths: 3,
        occurredAt: base.toISOString(),
        type: "trial_method_ready",
      },
      {
        cycleMonths: 1,
        occurredAt: base.toISOString(),
        type: "charge_succeeded",
      },
      {
        cycleMonths: 1,
        occurredAt: base.toISOString(),
        periodEndsAt: "never",
        type: "charge_succeeded",
      },
      // a refund, a chargeback and its reversal each name the period they concern
      { occurredAt: base.toISOString(), type: "charge_refunded" },
      { occurredAt: base.toISOString(), type: "charge_disputed" },
      {
        occurredAt: base.toISOString(),
        periodEndsAt: "never",
        type: "dispute_reversed",
      },
    ]) {
      expect(parseBillingFact(value)).toBeNull();
    }
  });

  it("keeps no personal data in what it stores", () => {
    for (const fact of sample) {
      expect(Object.keys(serializeBillingFact(fact)).sort()).toEqual(
        [
          "occurredAt",
          "type",
          ...("cycleMonths" in fact ? ["cycleMonths"] : []),
          ...("periodEndsAt" in fact ? ["periodEndsAt"] : []),
        ].sort()
      );
    }
  });
});

describe("what the review of the lifecycle found", () => {
  it("a delayed payment behind a later cancellation or cycle change still extends the access", () => {
    // renewal confirmed at day 29 reaches us after facts of day 30 were applied
    const active = pro("active", at(30), {
      cancelAtPeriodEnd: true,
      lastFactAt: at(30),
    });
    const result = applied(active, succeeded(at(29), at(60)), ctx(at(31)));
    expect(result.record).toMatchObject({
      accessEndsAt: at(60),
      // the cancellation came after that payment: it is not undone by it
      cancelAtPeriodEnd: true,
      state: "active",
    });
    // a payment newer than the cancellation does undo it
    const newer = applied(
      pro("active", at(30), { cancelAtPeriodEnd: true, lastFactAt: at(20) }),
      succeeded(at(29), at(60)),
      ctx(at(31))
    );
    expect(newer.record.cancelAtPeriodEnd).toBe(false);
    // the same delay does not rescue a failure, which the payment overtook
    expect(reconcileFact(active, failed(at(29)), ctx(at(31)))).toEqual({
      outcome: "ignored",
      reason: "stale",
    });
  });

  it("a fact dated in the future never pushes the clock of facts past the present", () => {
    const active = pro("active", at(30));
    const skewed = applied(
      active,
      { occurredAt: at(5), type: "subscription_cancelled" },
      ctx(at(1))
    );
    expect(skewed.record.lastFactAt?.getTime()).toBe(at(1).getTime());
    // a legitimate fact of day 2 is not stale because of it
    const next = reconcileFact(
      skewed.record,
      { cycleMonths: 6, occurredAt: at(2), type: "cycle_change_scheduled" },
      ctx(at(2))
    );
    expect(next.outcome).toBe("applied");
  });

  it("grace counts from the end of the paid period, however late the failure or the sweep is", () => {
    const active = pro("active", at(30));
    // a failure reported three days late
    const lateFailure = applied(active, failed(at(30)), ctx(at(33)));
    expect(lateFailure.record).toMatchObject({
      accessEndsAt: at(30 + GRACE_DAYS),
      state: "grace",
    });
    // a sweep that runs three days late gives the same grace, not three more days
    const lateSweep = dueTransition(active, ctx(at(33)));
    expect(lateSweep?.record).toMatchObject({
      accessEndsAt: at(30 + GRACE_DAYS),
      state: "grace",
    });
    // and one that runs after the grace already ran out ends it at the next pass
    const veryLate = dueTransition(active, ctx(at(45)));
    expect(veryLate?.record.accessEndsAt?.getTime()).toBeLessThan(
      at(45).getTime()
    );
  });

  it("the first charge failing ends the trial even a little before our own end of it", () => {
    const trialing = pro("trialing", at(7));
    const result = applied(trialing, failed(at(6.9)), ctx(at(6.9)));
    expect(result.record.state).toBe("free");
  });

  it("the renewal method being ready implies the opt-in when it overtakes the command, once", () => {
    const overtaken = applied(free(), {
      cycleMonths: 6,
      occurredAt: base,
      type: "trial_method_ready",
    });
    expect(overtaken.record).toMatchObject({
      accessEndsAt: at(TRIAL_DAYS),
      cycleMonths: 6,
      state: "trialing",
      trialConsumed: true,
    });
    // but never a second trial
    expect(
      reconcileFact(
        free({ trialConsumed: true }),
        { cycleMonths: 6, occurredAt: base, type: "trial_method_ready" },
        ctx()
      )
    ).toEqual({ outcome: "ignored", reason: "not_applicable" });
  });

  it("paying without a trial waives it", () => {
    const result = applied(free(), succeeded(base, at(30)));
    expect(result.record.trialConsumed).toBe(true);
    expect(isCoherentBillingRecord(result.record)).toBe(true);
  });
});

describe("refunds and chargebacks (PR84)", () => {
  const refunded = (occurredAt: Date, periodEndsAt: Date): BillingFact => ({
    occurredAt,
    periodEndsAt,
    type: "charge_refunded",
  });
  const disputed = (occurredAt: Date, periodEndsAt: Date): BillingFact => ({
    occurredAt,
    periodEndsAt,
    type: "charge_disputed",
  });
  const reversed = (occurredAt: Date, periodEndsAt: Date): BillingFact => ({
    occurredAt,
    periodEndsAt,
    type: "dispute_reversed",
  });
  const paid = (overrides: Partial<BillingRecord> = {}) =>
    pro("active", at(20), { cycleMonths: 6, ...overrides });
  const notApplicable = { outcome: "ignored", reason: "not_applicable" };

  it("a full refund of the current period takes the access back at once, into free_over_limit when the organization is over the limits", () => {
    const result = applied(paid(), refunded(at(1), at(20)), ctx(at(1)));
    expect(result.transition).toBe("access_revoked");
    expect(result.record).toMatchObject({
      accessEndsAt: null,
      cycleMonths: null,
      revoked: { cycleMonths: 6, periodEndsAt: at(20), reason: "refund" },
      state: "free",
    });
    expect(
      applied(paid(), refunded(at(1), at(20)), ctx(at(1), true)).record.state
    ).toBe("free_over_limit");
    expect(isCoherentBillingRecord(result.record)).toBe(true);
  });

  it("a chargeback is just as immediate, in grace too: no seven days to ride out", () => {
    const result = applied(paid(), disputed(at(1), at(20)), ctx(at(1)));
    expect(result.record).toMatchObject({
      accessEndsAt: null,
      revoked: { periodEndsAt: at(20), reason: "chargeback" },
      state: "free",
    });
    // grace stands on the period that ran out two days ago
    const inGrace = pro("grace", at(5), { cycleMonths: 1 });
    const fromGrace = applied(inGrace, disputed(at(1), at(-2)), ctx(at(1)));
    expect(fromGrace.record.state).toBe("free");
    expect(fromGrace.record.accessEndsAt).toBeNull();
  });

  it("only the payment behind the current period takes access away", () => {
    // an earlier period than the one in force: a renewal already superseded it
    for (const fact of [refunded(at(1), at(-10)), disputed(at(1), at(-10))]) {
      expect(reconcileFact(paid(), fact, ctx(at(1)))).toEqual(notApplicable);
    }
    const renewed = paid({ accessEndsAt: at(50) });
    expect(reconcileFact(renewed, refunded(at(1), at(20)), ctx(at(1)))).toEqual(
      notApplicable
    );
    // no paid period at all, and the period the fact names is already over
    for (const record of [
      free(),
      free({ state: "free_over_limit" }),
      pro("trialing", at(5)),
      free({ state: "trial_setup" }),
    ]) {
      expect(
        reconcileFact(record, refunded(at(10), at(-3)), ctx(at(10)))
      ).toEqual(notApplicable);
    }
  });

  it("a renewal paid early and refunded before its confirmation does not take the period still in force", () => {
    const result = reconcileFact(paid(), refunded(at(1), at(50)), ctx(at(1)));
    expect(result).toEqual(notApplicable);
  });

  it("a period end is the same one within the provider's rounding", () => {
    const rounded = new Date(at(20).getTime() + 3 * 3_600_000);
    const result = applied(paid(), refunded(at(1), rounded), ctx(at(1)));
    expect(result.record.state).toBe("free");
    // its late confirmation, with either rounding, never revives the access
    for (const end of [at(20), rounded]) {
      expect(
        reconcileFact(result.record, succeeded(at(0), end), ctx(at(2)))
      ).toEqual(notApplicable);
    }
    // and a reversal naming the other rounding still matches a chargeback
    const charged = applied(
      paid(),
      disputed(at(1), rounded),
      ctx(at(1))
    ).record;
    expect(
      applied(charged, reversed(at(3), at(20)), ctx(at(4))).record.state
    ).toBe("active");
  });

  it("the payment that was taken back never revives the access, a later one does", () => {
    const revoked = applied(paid(), refunded(at(1), at(20)), ctx(at(1))).record;
    expect(
      reconcileFact(revoked, succeeded(at(0), at(20)), ctx(at(2)))
    ).toEqual(notApplicable);
    // a new payment is a new subscription period, and forgets what was taken back
    const again = applied(revoked, succeeded(at(3), at(50)), ctx(at(3)));
    expect(again.record).toMatchObject({
      accessEndsAt: at(50),
      revoked: null,
      state: "active",
    });
    expect(isCoherentBillingRecord(again.record)).toBe(true);
  });

  it("a refund delivered before its charge is confirmed is remembered, so the confirmation cannot grant what was given back", () => {
    for (const record of [
      free(),
      free({ state: "free_over_limit" }),
      free({ state: "trial_setup" }),
      pro("trialing", at(5)),
    ]) {
      const early = applied(record, refunded(at(1), at(20)), ctx(at(1)));
      // nothing changes but the memory: a trial keeps running, a free record stays free
      expect(early.record.state).toBe(record.state);
      expect(early.record.revoked).toMatchObject({
        periodEndsAt: at(20),
        reason: "refund",
      });
      expect(isCoherentBillingRecord(early.record)).toBe(true);
      expect(
        reconcileFact(early.record, succeeded(at(0), at(20)), ctx(at(2)))
      ).toEqual(notApplicable);
      // a payment for a later period is a different charge
      expect(
        applied(early.record, succeeded(at(3), at(50)), ctx(at(3))).record
      ).toMatchObject({ revoked: null, state: "active" });
    }
  });

  it("ignores a period end no provider could report", () => {
    expect(
      reconcileFact(free(), refunded(at(1), at(1000)), ctx(at(1)))
    ).toEqual(notApplicable);
    expect(
      reconcileFact(paid(), refunded(at(1), at(1000)), ctx(at(1)))
    ).toEqual(notApplicable);
    expect(
      reconcileFact(free(), reversed(at(1), at(1000)), ctx(at(1)))
    ).toEqual(notApplicable);
  });

  it("what moved money is never dropped as stale, however late it arrives", () => {
    const newer = paid({ lastFactAt: at(5) });
    const result = applied(newer, refunded(at(1), at(20)), ctx(at(6)));
    expect(result.record.state).toBe("free");
    // and the clock of facts does not go back
    expect(result.record.lastFactAt).toEqual(at(5));
  });

  it("a chargeback decided in our favour restores the access for what is left of the period, with its cycle and its cancellation", () => {
    const cancelled = paid({ cancelAtPeriodEnd: true });
    const charged = applied(
      cancelled,
      disputed(at(1), at(20)),
      ctx(at(1))
    ).record;
    const restored = applied(charged, reversed(at(5), at(20)), ctx(at(6)));
    expect(restored.transition).toBe("subscribe");
    expect(restored.record).toMatchObject({
      accessEndsAt: at(20),
      cancelAtPeriodEnd: true,
      cycleMonths: 6,
      revoked: null,
      state: "active",
    });
    expect(isCoherentBillingRecord(restored.record)).toBe(true);
    // the same reversal delivered again cannot be told from one that overtook its
    // chargeback, so it is remembered (harmlessly: it only blocks that chargeback)
    const again = applied(restored.record, reversed(at(5), at(20)), ctx(at(6)));
    expect(again.record).toMatchObject({
      accessEndsAt: at(20),
      revoked: { reason: "won" },
      state: "active",
    });
    expect(
      reconcileFact(again.record, reversed(at(5), at(20)), ctx(at(6)))
    ).toEqual(notApplicable);
  });

  it("restores a trial that was running when the chargeback of an earlier payment is won", () => {
    const early = applied(
      pro("trialing", at(5)),
      disputed(at(1), at(20)),
      ctx(at(1))
    ).record;
    expect(early.state).toBe("trialing");
    const restored = applied(early, reversed(at(3), at(20)), ctx(at(4)));
    expect(restored.record).toMatchObject({ revoked: null, state: "active" });
  });

  it("a reversal after the period is over has nothing to restore, and only forgets the chargeback", () => {
    const charged = applied(paid(), disputed(at(1), at(20)), ctx(at(1))).record;
    const result = applied(charged, reversed(at(30), at(20)), ctx(at(30)));
    expect(result.transition).toBeNull();
    expect(result.record).toMatchObject({ revoked: null, state: "free" });
  });

  it("only a chargeback on record, for that period, is restored", () => {
    const charged = applied(paid(), disputed(at(1), at(20)), ctx(at(1))).record;
    const refundedRecord = applied(
      paid(),
      refunded(at(1), at(20)),
      ctx(at(1))
    ).record;
    for (const [record, fact] of [
      [charged, reversed(at(5), at(40))],
      [refundedRecord, reversed(at(5), at(20))],
    ] as const) {
      expect(reconcileFact(record, fact, ctx(at(6)))).toEqual(notApplicable);
    }
  });

  it("a refund after a chargeback means the reversal restores nothing: the customer has the money", () => {
    const charged = applied(paid(), disputed(at(1), at(20)), ctx(at(1))).record;
    const refundedAfter = applied(charged, refunded(at(2), at(20)), ctx(at(2)));
    expect(refundedAfter.record.state).toBe("free");
    expect(refundedAfter.record.revoked?.reason).toBe("refund");
    expect(
      reconcileFact(refundedAfter.record, reversed(at(5), at(20)), ctx(at(6)))
    ).toEqual(notApplicable);
    // and a chargeback after a refund adds nothing either
    const refundFirst = applied(
      paid(),
      refunded(at(1), at(20)),
      ctx(at(1))
    ).record;
    expect(
      reconcileFact(refundFirst, disputed(at(2), at(20)), ctx(at(2)))
    ).toEqual(notApplicable);
  });

  it("a reversal that overtakes its chargeback is remembered, so the chargeback then changes nothing", () => {
    const early = applied(free(), reversed(at(1), at(20)), ctx(at(1)));
    expect(early.record.revoked).toMatchObject({
      periodEndsAt: at(20),
      reason: "won",
    });
    expect(early.record.state).toBe("free");
    expect(
      reconcileFact(early.record, disputed(at(0), at(20)), ctx(at(2)))
    ).toEqual(notApplicable);
    // a remembered win does not block a real payment for that period
    expect(
      applied(early.record, succeeded(at(2), at(20)), ctx(at(2))).record.state
    ).toBe("active");
    // and a reversal for a period that is already over is not worth remembering
    expect(
      reconcileFact(free(), reversed(at(30), at(20)), ctx(at(30)))
    ).toEqual(notApplicable);
  });

  it("a win never pushes out one for a later period, and a past period only matters to grace", () => {
    const { record } = applied(paid(), reversed(at(1), at(20)), ctx(at(1)));
    // a reversal for a period that already ended does not replace the one still ahead
    expect(reconcileFact(record, reversed(at(2), at(-3)), ctx(at(2)))).toEqual(
      notApplicable
    );
    // and a record that is not on a paid period has no use for an ended one
    expect(reconcileFact(free(), reversed(at(2), at(1)), ctx(at(2)))).toEqual(
      notApplicable
    );
    // a later period replaces an earlier win
    const later = applied(record, reversed(at(2), at(40)), ctx(at(2))).record;
    expect(later.revoked?.periodEndsAt).toEqual(at(40));
  });

  it("learning the cycle of a refused confirmation does not move the clock of facts", () => {
    const early = applied(free(), disputed(at(1), at(20)), ctx(at(1))).record;
    const learned = applied(early, succeeded(at(0), at(20), 6), ctx(at(5)));
    expect(learned.record.lastFactAt).toEqual(early.lastFactAt);
  });

  it("a reversal that overtakes its chargeback on an active subscription is remembered too, and the chargeback then changes nothing", () => {
    for (const record of [paid(), pro("grace", at(5), { cycleMonths: 1 })]) {
      const end = record.state === "grace" ? at(-2) : at(20);
      const early = applied(record, reversed(at(1), end), ctx(at(1)));
      // the access is untouched: only the memory changes
      expect(early.record.state).toBe(record.state);
      expect(early.record.accessEndsAt).toEqual(record.accessEndsAt);
      expect(early.record.revoked).toMatchObject({
        periodEndsAt: end,
        reason: "won",
      });
      expect(isCoherentBillingRecord(early.record)).toBe(true);
      expect(
        reconcileFact(early.record, disputed(at(0), end), ctx(at(2)))
      ).toEqual(notApplicable);
      // a repeat of the reversal is not applied twice
      expect(
        reconcileFact(early.record, reversed(at(1), end), ctx(at(2)))
      ).toEqual(notApplicable);
      // a renewal keeps the memory (it concerns another period), and a refund of
      // the won period still takes the access back: the money was returned
      const renewed = applied(
        early.record,
        succeeded(at(3), at(60)),
        ctx(at(3))
      ).record;
      expect(renewed.revoked?.reason).toBe("won");
      expect(isCoherentBillingRecord(renewed)).toBe(true);
    }
    const won = applied(paid(), reversed(at(1), at(20)), ctx(at(1))).record;
    const refundedAfter = applied(won, refunded(at(2), at(20)), ctx(at(2)));
    expect(refundedAfter.record.state).toBe("free");
    expect(refundedAfter.record.revoked?.reason).toBe("refund");
  });

  it("learns the cycle of a payment taken back before its charge was known, to restore it if the chargeback is won", () => {
    const early = applied(free(), disputed(at(1), at(20)), ctx(at(1))).record;
    expect(early.revoked?.cycleMonths).toBeNull();
    // the confirmation of that payment is still refused, but tells its cycle
    const learned = applied(early, succeeded(at(0), at(20), 6), ctx(at(2)));
    expect(learned.record.state).toBe("free");
    expect(learned.record.revoked?.cycleMonths).toBe(6);
    // and a second confirmation is a repeat
    expect(
      reconcileFact(learned.record, succeeded(at(0), at(20), 6), ctx(at(2)))
    ).toEqual(notApplicable);
    const restored = applied(
      learned.record,
      reversed(at(5), at(20)),
      ctx(at(6))
    );
    expect(restored.record).toMatchObject({
      accessEndsAt: at(20),
      cycleMonths: 6,
      state: "active",
    });
  });

  it("restores nothing when the cycle was never learned: the confirmation of that charge, if it comes, grants it", () => {
    const early = applied(free(), disputed(at(1), at(20)), ctx(at(1))).record;
    const won = applied(early, reversed(at(3), at(20)), ctx(at(4)));
    expect(won.record).toMatchObject({ revoked: null, state: "free" });
    expect(
      applied(won.record, succeeded(at(5), at(20), 12), ctx(at(5))).record
    ).toMatchObject({ cycleMonths: 12, state: "active" });
  });

  it("does not restore over a subscription that was paid again in the meantime", () => {
    const charged = applied(paid(), disputed(at(1), at(20)), ctx(at(1))).record;
    const resubscribed = applied(
      charged,
      succeeded(at(2), at(50)),
      ctx(at(2))
    ).record;
    const late = applied(resubscribed, reversed(at(5), at(20)), ctx(at(6)));
    // nothing is restored over the new subscription: only the win is remembered
    expect(late.record).toMatchObject({
      accessEndsAt: at(50),
      revoked: { reason: "won" },
      state: "active",
    });
  });
});
