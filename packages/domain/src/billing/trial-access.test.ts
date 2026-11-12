import { describe, expect, it } from "vitest";
import { planInForce } from "./entitlements";
import { TRIAL_SLACK_HOURS, trialAccessEndsAt } from "./trial-access";

const brt = (local: string) => new Date(`${local}-03:00`);

describe("trialAccessEndsAt (AC-47)", () => {
  it.each([
    ["2026-11-17T13:46:00.000", "2026-11-18T06:00:00.000"],
    ["2026-11-17T00:00:00.000", "2026-11-18T06:00:00.000"],
    ["2026-11-17T23:59:59.999", "2026-11-18T06:00:00.000"],
    ["2026-11-17T22:30:00.000", "2026-11-18T06:00:00.000"],
    ["2026-11-30T21:00:00.000", "2026-12-01T06:00:00.000"],
    ["2026-12-31T23:59:00.000", "2027-01-01T06:00:00.000"],
    ["2028-02-28T10:00:00.000", "2028-02-29T06:00:00.000"],
    ["2027-02-28T10:00:00.000", "2027-03-01T06:00:00.000"],
  ])(
    "a trial stored to end at %s (São Paulo) lasts until %s",
    (stored, expected) => {
      expect(trialAccessEndsAt(brt(stored)).toISOString()).toBe(
        brt(expected).toISOString()
      );
    }
  );

  it("reads the day in São Paulo, not in UTC: 22:30 in São Paulo is already the next day in UTC", () => {
    const stored = new Date("2026-11-18T01:30:00.000Z");
    expect(trialAccessEndsAt(stored)).toEqual(
      new Date("2026-11-18T09:00:00.000Z")
    );
  });

  it("is the end of the day plus the slack, whatever hour the trial started", () => {
    expect(TRIAL_SLACK_HOURS).toBe(6);
    const stored = brt("2026-11-17T13:46:00.000");
    expect(trialAccessEndsAt(stored)).toEqual(
      new Date(brt("2026-11-18T00:00:00.000").getTime() + 6 * 3_600_000)
    );
  });

  it("never ends a trial before its stored end", () => {
    for (let minute = 0; minute < 24 * 60; minute += 7) {
      const stored = new Date(
        brt("2026-11-17T00:00:00.000").getTime() + minute * 60_000
      );
      expect(trialAccessEndsAt(stored).getTime()).toBeGreaterThan(
        stored.getTime()
      );
    }
  });

  it("throws on an instant that is not a date", () => {
    expect(() => trialAccessEndsAt(new Date(Number.NaN))).toThrow();
  });
});

describe("the plan in force at the edges of the slack (AC-47)", () => {
  const trial = {
    accessEndsAt: brt("2026-11-17T13:46:00.000"),
    state: "trialing" as const,
  };

  it.each([
    ["2026-11-17T13:46:00.000", "pro"],
    ["2026-11-17T13:47:00.000", "pro"],
    ["2026-11-17T23:59:59.999", "pro"],
    ["2026-11-18T00:00:00.000", "pro"],
    ["2026-11-18T05:59:00.000", "pro"],
    ["2026-11-18T05:59:59.999", "pro"],
    ["2026-11-18T06:00:00.000", "free"],
    ["2026-11-18T06:01:00.000", "free"],
  ] as const)(
    "at %s (São Paulo) a trial stored to end at 17/11 13:46 is %s",
    (local, plan) => {
      expect(planInForce(trial, brt(local))).toBe(plan);
    }
  );

  it("gives the slack only to the trial: a paid period and a grace end at their stored instant", () => {
    const end = brt("2026-11-17T13:46:00.000");
    const after = brt("2026-11-17T13:47:00.000");
    expect(planInForce({ accessEndsAt: end, state: "active" }, after)).toBe(
      "free"
    );
    expect(planInForce({ accessEndsAt: end, state: "grace" }, after)).toBe(
      "free"
    );
  });
});
