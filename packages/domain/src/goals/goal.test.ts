import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type PeriodResult, periodResult } from "../economics/sale-economics";
import {
  evaluateGoal,
  InvalidGoalError,
  normalizeGoal,
  normalizeGoalTarget,
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
    fc.assert(
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
    fc.assert(
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
