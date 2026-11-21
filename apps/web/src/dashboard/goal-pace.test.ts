import type { GoalReadModel } from "@polaris/contracts";
import { describe, expect, it } from "vitest";
import { calendarDayInTimezone } from "../lib/dates";
import { GOAL_PACE_LABEL, goalPace, goalPaceSpoken } from "./goal-pace";

type PaceGoal = Pick<
  GoalReadModel,
  "endsOn" | "paused" | "progress" | "startsOn" | "status"
>;

function goal(percent: string | null, overrides: Partial<PaceGoal> = {}) {
  return {
    endsOn: "2026-11-30",
    paused: false,
    progress: { percent, periodEnded: false, reached: false, value: "1.00" },
    startsOn: "2026-11-01",
    status: "active",
    ...overrides,
  } satisfies PaceGoal;
}

describe("goalPace", () => {
  it("has no mark on the first day of the period", () => {
    expect(goalPace(goal("0.0"), "2026-11-01")).toBeNull();
  });

  it("places the mark at the days over ÷ the days of a 30-day period", () => {
    const day15 = goalPace(goal("46.7"), "2026-11-15");
    expect(day15?.position).toBeCloseTo((14 * 100) / 30, 10);
    expect(day15?.expectedPercent).toBe(47);
    const day2 = goalPace(goal("10.0"), "2026-11-02");
    expect(day2?.position).toBeCloseTo(100 / 30, 10);
    const day30 = goalPace(goal("90.0"), "2026-11-30");
    expect(day30?.position).toBeCloseTo((29 * 100) / 30, 10);
    expect(day30?.expectedPercent).toBe(97);
  });

  it("follows the store's day at the turn of the day in São Paulo", () => {
    const timezone = "America/Sao_Paulo";
    const before = calendarDayInTimezone(
      new Date("2026-11-15T02:59:59.000Z"),
      timezone
    );
    const after = calendarDayInTimezone(
      new Date("2026-11-15T03:00:00.000Z"),
      timezone
    );
    expect(before).toBe("2026-11-14");
    expect(after).toBe("2026-11-15");
    expect(goalPace(goal("40.0"), before)?.position).toBeCloseTo(
      (13 * 100) / 30,
      10
    );
    expect(goalPace(goal("40.0"), after)?.position).toBeCloseTo(
      (14 * 100) / 30,
      10
    );
  });

  it("counts the days of a period that is not a month", () => {
    const week = goal("30.0", { endsOn: "2026-11-10", startsOn: "2026-11-04" });
    expect(goalPace(week, "2026-11-06")?.position).toBeCloseTo(200 / 7, 10);
    const oneDay = goal("30.0", {
      endsOn: "2026-11-04",
      startsOn: "2026-11-04",
    });
    expect(goalPace(oneDay, "2026-11-04")).toBeNull();
  });

  it("crosses a month and a year when the period does", () => {
    const wide = goal("20.0", { endsOn: "2027-01-09", startsOn: "2026-12-31" });
    expect(goalPace(wide, "2027-01-05")?.position).toBeCloseTo(50, 10);
  });

  describe("state", () => {
    const today = "2026-11-16";

    it("is ahead when what was done passes the expected", () => {
      expect(goalPace(goal("50.1"), today)?.state).toBe("ahead");
      expect(goalPace(goal("80.0"), today)?.state).toBe("ahead");
    });

    it("is on pace from the expected down to 5% of the target under it", () => {
      expect(goalPace(goal("50.0"), today)?.state).toBe("on_pace");
      expect(goalPace(goal("45.0"), today)?.state).toBe("on_pace");
    });

    it("is behind under that", () => {
      expect(goalPace(goal("44.9"), today)?.state).toBe("behind");
      expect(goalPace(goal("0.0"), today)?.state).toBe("behind");
    });

    it("compares in exact tenths where the expected is not one", () => {
      const thirds = "2026-11-11";
      expect(goalPace(goal("33.3"), thirds)?.state).toBe("on_pace");
      expect(goalPace(goal("33.4"), thirds)?.state).toBe("ahead");
      expect(goalPace(goal("28.4"), thirds)?.state).toBe("on_pace");
      expect(goalPace(goal("28.3"), thirds)?.state).toBe("behind");
    });

    it("reads a progress that is not positive as nothing done", () => {
      expect(goalPace(goal(null), today)?.state).toBe("behind");
    });
  });

  describe("no mark and no word", () => {
    it.each([
      ["a paused goal", goal("10.0", { paused: true })],
      ["a goal with no progress read", goal("10.0", { progress: null })],
      [
        "a reached goal",
        goal("100.0", {
          progress: {
            percent: "100.0",
            periodEnded: false,
            reached: true,
            value: "1000.00",
          },
        }),
      ],
      [
        "a period that ended",
        goal("30.0", {
          progress: {
            percent: "30.0",
            periodEnded: true,
            reached: false,
            value: "300.00",
          },
        }),
      ],
      ["a goal that is not active", goal("30.0", { status: "missed" })],
    ])("for %s", (_name, input) => {
      expect(goalPace(input, "2026-11-16")).toBeNull();
    });

    it("before the period begins and after it ends", () => {
      expect(goalPace(goal("0.0"), "2026-10-31")).toBeNull();
      expect(goalPace(goal("0.0"), "2026-12-01")).toBeNull();
    });

    it("when the store's day is not known", () => {
      expect(goalPace(goal("30.0"), null)).toBeNull();
    });
  });
});

describe("goalPaceSpoken", () => {
  it("says the state and the expected share in words", () => {
    const pace = goalPace(goal("30.0"), "2026-11-19");
    expect(pace).not.toBeNull();
    expect(goalPaceSpoken(pace as NonNullable<typeof pace>)).toBe(
      "Atrasada: o esperado até hoje era 60%."
    );
  });

  it("names the three states", () => {
    expect(GOAL_PACE_LABEL).toEqual({
      ahead: "Adiantada",
      behind: "Atrasada",
      on_pace: "No ritmo",
    });
  });
});
