import fc from "fast-check";
import { assertProperty } from "../testing/property";
import { describe, expect, it } from "vitest";
import { type PeriodResult, periodResult } from "../economics/sale-economics";
import {
  evaluateGoal,
  InvalidGoalError,
  normalizeGoal,
  normalizeGoalTarget,
  pausedGoalIds,
  settleGoal,
} from "./goal";

const today = "2026-10-14";

const base = {
  endsOn: "2026-10-31",
  kind: "net_sales",
  startsOn: "2026-10-01",
  target: "1000",
};

const result = (
  netSales: number,
  sales = 1,
  expenses: string[] = []
): PeriodResult =>
  periodResult(
    Array.from({ length: sales }, (_, index) => ({
      adjustments: [],
      anticipationFee: "0.00",
      cancelled: false,
      items: [
        {
          chargedUnitPrice: (netSales / sales).toFixed(2),
          position: index,
          quantity: 1,
          unitCost: null,
        },
      ],
      linkedExpenses: [],
      processingFee: "0.00",
      returnLines: [],
    })),
    expenses
  );

describe("normalizeGoalTarget", () => {
  it("keeps money exact with two places and a count as a whole number", () => {
    expect(normalizeGoalTarget("net_sales", " 1500 ")).toBe("1500.00");
    expect(normalizeGoalTarget("operating_result", "250.5")).toBe("250.50");
    expect(normalizeGoalTarget("sale_count", " 40 ")).toBe("40");
    expect(normalizeGoalTarget("sale_count", "007")).toBe("7");
  });

  it.each([
    ["net_sales", "0"],
    ["net_sales", "-5"],
    ["net_sales", "1.005"],
    ["net_sales", "abc"],
    ["operating_result", "0.00"],
    ["sale_count", "0"],
    ["sale_count", "1.5"],
    ["sale_count", "-3"],
    ["sale_count", "1000001"],
    ["sale_count", "12345678901"],
  ])("refuses %s %s", (kind, target) => {
    expect(() => normalizeGoalTarget(kind as "net_sales", target)).toThrow(
      InvalidGoalError
    );
  });
});

describe("normalizeGoal", () => {
  it("accepts a month, trims the name and the target", () => {
    expect(normalizeGoal({ ...base, name: "  Outubro  " }, today)).toEqual({
      endsOn: "2026-10-31",
      kind: "net_sales",
      name: "Outubro",
      startsOn: "2026-10-01",
      target: "1000.00",
    });
    expect(normalizeGoal({ ...base, name: "   " }, today).name).toBeNull();
  });

  it.each([
    ["unknown kind", { kind: "profit" }],
    ["impossible start", { startsOn: "2026-02-30" }],
    ["start before 2000", { startsOn: "1999-12-31", endsOn: "2000-01-31" }],
    ["start too far ahead", { startsOn: "2027-10-16", endsOn: "2027-10-31" }],
    ["end before start", { endsOn: "2026-09-30" }],
    ["longer than 366 days", { endsOn: "2027-10-02" }],
    ["long name", { name: "n".repeat(101) }],
    ["a name with NUL", { name: "a\u0000b" }],
    ["a name with a lone surrogate", { name: "a\uD800b" }],
  ])("refuses %s", (_label, override) => {
    expect(() => normalizeGoal({ ...base, ...override }, today)).toThrow(
      InvalidGoalError
    );
  });

  it("accepts exactly 366 days", () => {
    expect(() =>
      normalizeGoal(
        { ...base, endsOn: "2027-09-30", startsOn: "2026-10-01" },
        today
      )
    ).not.toThrow();
  });
});

describe("evaluateGoal and settleGoal", () => {
  const goal = {
    endsOn: "2026-10-31",
    kind: "net_sales" as const,
    target: "1000.00",
  };

  it("measures net sales, the estimated result and the sale count", () => {
    const month = result(400, 2, ["50.00"]);
    expect(evaluateGoal(goal, month, today)).toMatchObject({
      percent: "40.0",
      progress: "400.00",
      reached: false,
    });
    expect(
      evaluateGoal(
        { ...goal, kind: "operating_result", target: "300.00" },
        month,
        today
      )
    ).toMatchObject({ percent: "116.7", progress: "350.00", reached: true });
    expect(
      evaluateGoal({ ...goal, kind: "sale_count", target: "4" }, month, today)
    ).toMatchObject({ percent: "50.0", progress: "2", reached: false });
  });

  it("a negative result has no percent and does not reach a positive target", () => {
    const loss = result(0, 0, ["80.00"]);
    expect(
      evaluateGoal(
        { ...goal, kind: "operating_result", target: "100.00" },
        loss,
        today
      )
    ).toMatchObject({ percent: null, progress: "-80.00", reached: false });
  });

  it("completes as soon as the target is reached, even before the period ends", () => {
    const evaluation = evaluateGoal(goal, result(1000), today);
    expect(evaluation.periodEnded).toBe(false);
    expect(settleGoal("active", evaluation)).toBe("completed");
  });

  it("an operating-result goal settles only once its period has ended", () => {
    const op = {
      endsOn: "2026-10-31",
      kind: "operating_result" as const,
      target: "100.00",
    };
    const good = result(1000, 1, ["10.00"]);
    // reached mid-period: not settled (costs dated later in the month are not in yet)
    expect(
      settleGoal("active", evaluateGoal(op, good, today), "operating_result")
    ).toBeNull();
    expect(
      settleGoal(
        "active",
        evaluateGoal(op, good, "2026-11-01"),
        "operating_result"
      )
    ).toBe("completed");
    expect(
      settleGoal(
        "active",
        evaluateGoal(op, result(10), "2026-11-01"),
        "operating_result"
      )
    ).toBe("missed");
  });

  it("is missed only after the period ends without the target, and nothing else changes by itself", () => {
    const short = result(10);
    expect(settleGoal("active", evaluateGoal(goal, short, today))).toBeNull();
    expect(settleGoal("active", evaluateGoal(goal, short, "2026-11-01"))).toBe(
      "missed"
    );
    // reaching it on the last day completes it, not misses it
    expect(
      settleGoal("active", evaluateGoal(goal, result(1000), "2026-11-01"))
    ).toBe("completed");
    for (const status of ["completed", "missed", "cancelled"] as const) {
      expect(
        settleGoal(status, evaluateGoal(goal, result(5000), today))
      ).toBeNull();
    }
  });

  it("a completed goal stays completed when the numbers later fall (property)", () => {
    assertProperty(
      fc.property(fc.integer({ max: 5000, min: 0 }), (later) => {
        // once completed the status never asks to change, whatever the new result is
        expect(
          settleGoal(
            "completed",
            evaluateGoal(goal, result(later), "2026-12-01")
          )
        ).toBeNull();
      })
    );
  });

  it("the percent is the exact ratio to one place (property)", () => {
    assertProperty(
      fc.property(
        fc.integer({ max: 100_000, min: 1 }),
        fc.integer({ max: 100_000, min: 1 }),
        (netCents, targetCents) => {
          const month = result(netCents / 100);
          const target = (targetCents / 100).toFixed(2);
          const evaluation = evaluateGoal({ ...goal, target }, month, today);
          const exact = (netCents / targetCents) * 100;
          expect(
            Math.abs(Number(evaluation.percent) - exact)
          ).toBeLessThanOrEqual(0.05 + 1e-9);
        }
      )
    );
  });
});

describe("the goals a plan pauses", () => {
  const todayText = "2026-10-14";
  const goal = (
    id: string,
    day: number,
    options: { endsOn?: string; startsOn?: string } = {}
  ) => ({
    createdAt: new Date(Date.UTC(2026, 9, day)),
    endsOn: options.endsOn ?? "2026-10-31",
    id,
    startsOn: options.startsOn ?? "2026-10-01",
  });

  it("keeps the oldest goals running up to the limit and pauses the newer ones", () => {
    const active = [goal("c", 3), goal("a", 1), goal("b", 2)];
    expect(pausedGoalIds(active, 1, todayText)).toEqual(["b", "c"]);
    expect(pausedGoalIds(active, 2, todayText)).toEqual(["c"]);
    expect(pausedGoalIds(active, 3, todayText)).toEqual([]);
    expect(pausedGoalIds(active, 20, todayText)).toEqual([]);
  });

  it("breaks a tie by id, so the same goals are paused on every read", () => {
    const tied = [goal("b", 1), goal("a", 1)];
    expect(pausedGoalIds(tied, 1, todayText)).toEqual(["b"]);
    expect(pausedGoalIds([...tied].reverse(), 1, todayText)).toEqual(["b"]);
  });

  it("pauses everything when the limit is zero or not a number, and nothing when there are no goals", () => {
    expect(pausedGoalIds([goal("a", 1)], 0, todayText)).toEqual(["a"]);
    expect(pausedGoalIds([goal("a", 1)], Number.NaN, todayText)).toEqual(["a"]);
    expect(pausedGoalIds([], 1, todayText)).toEqual([]);
  });

  it("cancelling a goal that runs moves the next one in (it is derived, never stored)", () => {
    const active = [goal("a", 1), goal("b", 2)];
    expect(pausedGoalIds(active, 1, todayText)).toEqual(["b"]);
    expect(pausedGoalIds(active.slice(1), 1, todayText)).toEqual([]);
  });

  it("gives no place to a goal whose period has ended: the read settles it", () => {
    const ended = goal("old", 1, { endsOn: "2026-10-13" });
    const running = goal("new", 2);
    expect(pausedGoalIds([ended, running], 1, todayText)).toEqual([]);
    // an ended goal is never paused either, so it is always settled
    expect(
      pausedGoalIds([running, ended, goal("newer", 3)], 1, todayText)
    ).toEqual(["newer"]);
  });

  it("does not let a goal that has not started take the place of the one in progress", () => {
    const december = goal("december", 1, {
      endsOn: "2026-12-31",
      startsOn: "2026-12-01",
    });
    const current = goal("current", 2);
    expect(pausedGoalIds([december, current], 1, todayText)).toEqual([
      "december",
    ]);
    // once it starts it ranks by age like any other
    expect(pausedGoalIds([december, current], 1, "2026-12-02")).toEqual([]);
  });
});
