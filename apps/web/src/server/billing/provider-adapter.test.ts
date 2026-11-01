import { describe, expect, it } from "vitest";
import { retryRefusalReason, withinRetryWindow } from "./provider-adapter";

const now = new Date("2026-10-19T12:00:00.000Z");
const MINUTE = 60_000;
const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);

describe("withinRetryWindow", () => {
  it.each([
    ["now", 0, true],
    ["30 minutes ago", -30 * MINUTE, true],
    ["30 minutes and 1 ms ago", -30 * MINUTE - 1, false],
    ["5 minutes ahead (clock drift)", 5 * MINUTE, true],
    ["5 minutes and 1 ms ahead", 5 * MINUTE + 1, false],
    ["a day ahead", 24 * 60 * MINUTE, false],
  ])("%s", (_name, offsetMs, expected) => {
    expect(withinRetryWindow(at(offsetMs), now)).toBe(expected);
  });

  it("an invalid date is outside the window", () => {
    expect(withinRetryWindow(new Date(Number.NaN), now)).toBe(false);
  });
});

describe("retryRefusalReason", () => {
  it("names a date far ahead as future", () => {
    expect(retryRefusalReason(at(5 * MINUTE + 1), now)).toBe("future");
  });

  it.each([
    ["an old date", at(-31 * MINUTE)],
    ["an invalid date", new Date(Number.NaN)],
  ])("names %s as stale", (_name, date) => {
    expect(retryRefusalReason(date, now)).toBe("stale");
  });
});
