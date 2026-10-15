import fc from "fast-check";
import { describe, expect, it } from "vitest";
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
  isCoherentBillingFacts,
  MAX_PERIOD_DAYS,
  RejectedBillingEventError,
  type TransitionContext,
  TRIAL_DAYS,
} from "./subscription-state";

const now = new Date("2026-10-14T12:00:00.000Z");
const DAY = 86_400_000;
const days = (n: number, from = now) => new Date(from.getTime() + n * DAY);
const periodEnd = days(31);
const ctx = (
  overFreeLimits = false,
  clock = now,
  trialConsumed = false
): TransitionContext => ({ now: clock, overFreeLimits, trialConsumed });
const at = (
  state: BillingState,
  accessEndsAt: Date | null = null
): BillingFacts => ({ accessEndsAt, state });
const FREE_STATE_NAMES: ReadonlySet<BillingState> = new Set([
  "free",
  "free_over_limit",
]);
const rejection = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(RejectedBillingEventError);
    return (error as RejectedBillingEventError).code;
  }
  throw new Error("expected a rejection");
};

describe("the happy paths", () => {
  it("trial: the person opts in, the renewal method is ready, the trial runs for seven days and converts", () => {
    let facts = at("free");
    facts = applyBillingEvent(facts, { type: "start_trial" }, ctx());
    expect(facts).toEqual({ accessEndsAt: null, state: "trial_setup" });
    expect(grantsPro(facts.state)).toBe(false);
    facts = applyBillingEvent(facts, { type: "renewal_ready" }, ctx());
    expect(facts).toEqual({
      accessEndsAt: days(TRIAL_DAYS),
      state: "trialing",
    });
    facts = applyBillingEvent(
      facts,
      { periodEndsAt: periodEnd, type: "payment_succeeded" },
      ctx()
    );
    expect(facts).toEqual({ accessEndsAt: periodEnd, state: "active" });
  });

  it("a paid subscription renews, fails into grace after the paid period, recovers, or lapses to free", () => {
    let facts = applyBillingEvent(
      at("free"),
      { periodEndsAt: periodEnd, type: "subscribe" },
      ctx()
    );
    expect(facts).toEqual({ accessEndsAt: periodEnd, state: "active" });
    facts = applyBillingEvent(
      facts,
      { periodEndsAt: days(60), type: "payment_succeeded" },
      ctx()
    );
    expect(facts.accessEndsAt).toEqual(days(60));
    // the renewal fails once the paid period has run out: grace follows it
    const afterPeriod = days(61);
    const grace = applyBillingEvent(
      facts,
      { type: "payment_failed" },
      ctx(false, afterPeriod)
    );
    expect(grace).toEqual({
      accessEndsAt: days(GRACE_DAYS, afterPeriod),
      state: "grace",
    });
    const recovered = applyBillingEvent(
      grace,
      { periodEndsAt: days(90), type: "payment_succeeded" },
      ctx(false, afterPeriod)
    );
    expect(recovered).toEqual({ accessEndsAt: days(90), state: "active" });
    expect(
      applyBillingEvent(
        grace,
        { type: "grace_expired" },
        ctx(false, days(GRACE_DAYS, afterPeriod))
      )
    ).toEqual(at("free"));
  });

  it("leaving Pro lands on free_over_limit when the organization holds more than free allows", () => {
    const over = ctx(true, days(3));
    const ended = days(2);
    expect(
      applyBillingEvent(at("grace", ended), { type: "grace_expired" }, over)
    ).toEqual(at("free_over_limit"));
    expect(
      applyBillingEvent(at("active", ended), { type: "period_ended" }, over)
    ).toEqual(at("free_over_limit"));
    expect(
      applyBillingEvent(
        at("trialing", ended),
        { type: "trial_ended_without_payment" },
        over
      )
    ).toEqual(at("free_over_limit"));
    expect(
      applyBillingEvent(
        at("trial_setup"),
        { type: "abandon_trial_setup" },
        over
      )
    ).toEqual(at("free_over_limit"));
  });

  it("the free states follow the usage, and nothing else does", () => {
    expect(
      applyBillingEvent(at("free"), { type: "usage_changed" }, ctx(true))
    ).toEqual(at("free_over_limit"));
    expect(
      applyBillingEvent(
        at("free_over_limit"),
        { type: "usage_changed" },
        ctx(false)
      )
    ).toEqual(at("free"));
    expect(() =>
      applyBillingEvent(
        at("active", periodEnd),
        { type: "usage_changed" },
        ctx(true)
      )
    ).toThrow(InvalidBillingTransitionError);
  });

  it("an organization over the free limits can still start a trial or subscribe", () => {
    expect(
      applyBillingEvent(
        at("free_over_limit"),
        { type: "start_trial" },
        ctx(true)
      ).state
    ).toBe("trial_setup");
    expect(
      applyBillingEvent(
        at("free_over_limit"),
        { periodEndsAt: periodEnd, type: "subscribe" },
        ctx(true)
      ).state
    ).toBe("active");
  });
});

describe("defence against stale, early and malformed facts", () => {
  it("refuses a period end that is not a real date, is not in the future or is beyond a year or so", () => {
    for (const periodEndsAt of [
      new Date(Number.NaN),
      days(-1),
      now,
      days(MAX_PERIOD_DAYS + 1),
    ]) {
      expect(
        rejection(() =>
          applyBillingEvent(
            at("free"),
            { periodEndsAt, type: "subscribe" },
            ctx()
          )
        )
      ).toBe("invalid_period_end");
      expect(
        rejection(() =>
          applyBillingEvent(
            at("trialing", days(3)),
            { periodEndsAt, type: "payment_succeeded" },
            ctx()
          )
        )
      ).toBe("invalid_period_end");
    }
    // the longest allowed period is accepted
    expect(
      applyBillingEvent(
        at("free"),
        { periodEndsAt: days(MAX_PERIOD_DAYS), type: "subscribe" },
        ctx()
      ).state
    ).toBe("active");
  });

  it("an old or repeated payment never moves the end of access backwards", () => {
    const paid = at("active", days(60));
    expect(
      rejection(() =>
        applyBillingEvent(
          paid,
          { periodEndsAt: days(31), type: "payment_succeeded" },
          ctx()
        )
      )
    ).toBe("stale_period_end");
    expect(
      rejection(() =>
        applyBillingEvent(
          paid,
          { periodEndsAt: days(60), type: "payment_succeeded" },
          ctx()
        )
      )
    ).toBe("stale_period_end");
    expect(
      applyBillingEvent(
        paid,
        { periodEndsAt: days(90), type: "payment_succeeded" },
        ctx()
      ).accessEndsAt
    ).toEqual(days(90));
  });

  it("a failed payment never shortens the period already paid for", () => {
    const early = applyBillingEvent(
      at("active", days(20)),
      { type: "payment_failed" },
      ctx()
    );
    expect(early.accessEndsAt).toEqual(days(20 + GRACE_DAYS));
    const late = applyBillingEvent(
      at("active", days(-2)),
      { type: "payment_failed" },
      ctx()
    );
    expect(late.accessEndsAt).toEqual(days(GRACE_DAYS));
  });

  it("the events that end access are refused before the access they end has run out", () => {
    const early: [BillingState, BillingEvent][] = [
      ["trialing", { type: "trial_ended_without_payment" }],
      ["grace", { type: "grace_expired" }],
      ["active", { type: "period_ended" }],
    ];
    for (const [state, event] of early) {
      expect(
        rejection(() => applyBillingEvent(at(state, days(2)), event, ctx()))
      ).toBe("event_not_due");
      // at the end instant itself the access is over
      expect(
        FREE_STATE_NAMES.has(
          applyBillingEvent(at(state, now), event, ctx()).state
        )
      ).toBe(true);
    }
  });

  it("a trial is offered once", () => {
    for (const state of ["free", "free_over_limit"] as const) {
      expect(
        rejection(() =>
          applyBillingEvent(
            at(state),
            { type: "start_trial" },
            ctx(false, now, true)
          )
        )
      ).toBe("trial_already_consumed");
    }
    // a subscription is not a trial
    expect(
      applyBillingEvent(
        at("free"),
        { periodEndsAt: periodEnd, type: "subscribe" },
        ctx(false, now, true)
      ).state
    ).toBe("active");
  });

  it("a returned date is a copy, not the event's own", () => {
    const event = {
      periodEndsAt: new Date(periodEnd),
      type: "subscribe",
    } as const;
    const facts = applyBillingEvent(at("free"), event, ctx());
    facts.accessEndsAt?.setTime(0);
    expect(event.periodEndsAt.getTime()).toBe(periodEnd.getTime());
  });
});

const eventTypes = [
  "start_trial",
  "abandon_trial_setup",
  "renewal_ready",
  "trial_ended_without_payment",
  "subscribe",
  "payment_succeeded",
  "payment_failed",
  "grace_expired",
  "period_ended",
  "usage_changed",
] as const satisfies readonly BillingEvent["type"][];
const states: BillingState[] = [
  "free",
  "trial_setup",
  "trialing",
  "active",
  "grace",
  "free_over_limit",
];

/** An event of the given type, with period ends computed from the clock it arrives at. */
const eventOf = (type: BillingEvent["type"], clock: Date): BillingEvent => {
  if (type === "subscribe" || type === "payment_succeeded") {
    return { periodEndsAt: days(31, clock), type };
  }
  return { type } as BillingEvent;
};

describe("the transition table", () => {
  it("accepts exactly the events that apply to each state, and refuses the rest with the state and the event", () => {
    const accepted: Record<BillingState, BillingEvent["type"][]> = {
      active: ["payment_failed", "payment_succeeded", "period_ended"],
      free: ["start_trial", "subscribe", "usage_changed"],
      free_over_limit: ["start_trial", "subscribe", "usage_changed"],
      grace: ["grace_expired", "payment_succeeded"],
      trial_setup: [
        "abandon_trial_setup",
        "renewal_ready",
        "start_trial",
        "subscribe",
      ],
      trialing: ["payment_succeeded", "trial_ended_without_payment"],
    };
    for (const state of states) {
      // access that has already run out, so that the events that end it are due
      const facts = at(state, grantsPro(state) ? days(-1) : null);
      for (const type of eventTypes) {
        let applied = true;
        try {
          applyBillingEvent(facts, eventOf(type, now), ctx());
        } catch (error) {
          applied = false;
          expect(error).toBeInstanceOf(InvalidBillingTransitionError);
          expect(error).toMatchObject({ event: type, state });
        }
        expect(applied).toBe(accepted[state].includes(type));
      }
    }
  });
});

describe("properties of any sequence of events", () => {
  const step = fc.tuple(
    fc.constantFrom(...eventTypes),
    fc.boolean(),
    fc.integer({ max: 20, min: 0 }),
    fc.boolean()
  );

  /** Runs a random sequence with the clock moving forward; returns each applied step. */
  const run = (
    steps: [BillingEvent["type"], boolean, number, boolean][],
    check: (
      before: BillingFacts,
      after: BillingFacts,
      event: BillingEvent,
      context: TransitionContext
    ) => void
  ) => {
    let facts = at("free");
    let clock = now;
    for (const [type, over, advance, consumed] of steps) {
      clock = days(advance, clock);
      const event = eventOf(type, clock);
      const context = ctx(over, clock, consumed);
      let next: BillingFacts;
      try {
        next = applyBillingEvent(facts, event, context);
      } catch (error) {
        expect([
          InvalidBillingTransitionError,
          RejectedBillingEventError,
        ]).toContain((error as Error).constructor);
        continue;
      }
      check(facts, next, event, context);
      facts = next;
    }
  };

  it("the record stays coherent, in the future when it grants Pro, and Pro starts only through a renewal method or a payment", () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 40 }), (steps) => {
        run(steps, (before, after, event, context) => {
          expect(isCoherentBillingFacts(after)).toBe(true);
          if (grantsPro(after.state) && after.state !== "grace") {
            expect(after.accessEndsAt?.getTime()).toBeGreaterThan(
              context.now.getTime()
            );
          }
          if (grantsPro(after.state) && !grantsPro(before.state)) {
            expect(["renewal_ready", "subscribe"]).toContain(event.type);
          }
        });
      })
    );
  });

  it("access never ends early and a payment never shortens it", () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 40 }), (steps) => {
        run(steps, (before, after, _event, context) => {
          const left = grantsPro(before.state) && !grantsPro(after.state);
          if (left) {
            // leaving Pro happens only once the access had run out, or by giving up a trial setup
            expect(before.accessEndsAt?.getTime()).toBeLessThanOrEqual(
              context.now.getTime()
            );
          }
          if (before.state === "active" && after.state === "active") {
            expect(after.accessEndsAt?.getTime()).toBeGreaterThan(
              before.accessEndsAt?.getTime() ?? 0
            );
          }
          if (before.state === "active" && after.state === "grace") {
            expect(after.accessEndsAt?.getTime()).toBeGreaterThanOrEqual(
              before.accessEndsAt?.getTime() ?? 0
            );
          }
        });
      })
    );
  });

  it("free_over_limit is entered, and left for free, only when the usage says so", () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 40 }), (steps) => {
        run(steps, (before, after, _event, context) => {
          if (
            after.state === "free_over_limit" &&
            before.state !== "free_over_limit"
          ) {
            expect(context.overFreeLimits).toBe(true);
          }
          if (after.state === "free" && before.state === "free_over_limit") {
            expect(context.overFreeLimits).toBe(false);
          }
        });
      })
    );
  });

  it("a trial that is still being set up can be started again (the person closed the checkout), and nothing else restarts it", () => {
    expect(
      applyBillingEvent(at("trial_setup"), { type: "start_trial" }, ctx())
    ).toEqual({ accessEndsAt: null, state: "trial_setup" });
    expect(
      rejection(() =>
        applyBillingEvent(
          at("trial_setup"),
          { type: "start_trial" },
          ctx(false, now, true)
        )
      )
    ).toBe("trial_already_consumed");
  });

  it("a trial cannot be started while one is running or a subscription exists, nor again once consumed", () => {
    for (const state of ["trialing", "active", "grace"] as const) {
      expect(() =>
        applyBillingEvent(
          at(state, grantsPro(state) ? periodEnd : null),
          { type: "start_trial" },
          ctx()
        )
      ).toThrow(InvalidBillingTransitionError);
    }
    fc.assert(
      fc.property(fc.array(step, { maxLength: 40 }), (steps) => {
        run(steps, (before, after, event, context) => {
          if (event.type === "start_trial" && after.state === "trial_setup") {
            expect(context.trialConsumed).toBe(false);
            // from the free states, or again while the trial is still being set up
            expect(["free", "free_over_limit", "trial_setup"]).toContain(
              before.state
            );
          }
        });
      })
    );
  });
});
