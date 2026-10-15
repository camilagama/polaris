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
        fc.integer({ max: 400, min: 1 })
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
          { cycleMonths, occurredAt, type: "cycle_change_scheduled" }
        );
      });
  const sequence = fc.array(
    fc.tuple(factArb(base), fc.integer({ max: 20, min: 0 }), fc.boolean()),
    { maxLength: 30 }
  );
  const start = fc.constantFrom(...states).map((state): BillingRecord => {
    if (grantsPro(state)) {
      return pro(state as "active" | "grace" | "trialing", at(10));
    }
    return free({ state });
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
        if (second.outcome === "applied") {
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
