import { describe, expect, it } from "vitest";
import { RECENT_LOGIN_MINUTES } from "../../offline/runtime/devices-model";
import {
  FRESH_SESSION_MAX_AGE_MILLISECONDS,
  isSessionFresh,
  SESSION_IDLE_TTL_SECONDS,
  SESSION_REFRESH_INTERVAL_SECONDS,
} from "./session-policy";

const minute = 60 * 1000;
const now = Date.parse("2026-10-19T12:00:00.000Z");

describe("isSessionFresh", () => {
  it("allows 15 minutes of freshness", () => {
    expect(FRESH_SESSION_MAX_AGE_MILLISECONDS).toBe(15 * minute);
  });

  it("is the window the devices screen words in its text", () => {
    expect(RECENT_LOGIN_MINUTES * minute).toBe(
      FRESH_SESSION_MAX_AGE_MILLISECONDS
    );
  });

  it("is fresh 14 minutes after sign-in", () => {
    expect(isSessionFresh(new Date(now - 14 * minute), now)).toBe(true);
  });

  it("is not fresh 15 minutes after sign-in", () => {
    expect(isSessionFresh(new Date(now - 15 * minute), now)).toBe(false);
  });

  it("reads an ISO string creation time", () => {
    expect(isSessionFresh(new Date(now - minute).toISOString(), now)).toBe(
      true
    );
    expect(isSessionFresh(new Date(now - 16 * minute).toISOString(), now)).toBe(
      false
    );
  });

  it("is not fresh when the creation time is unreadable", () => {
    expect(isSessionFresh("not-a-date", now)).toBe(false);
    expect(isSessionFresh(new Date(Number.NaN), now)).toBe(false);
  });
});

describe("the session lifetimes the M3 of the activation measure leans on", () => {
  const day = 24 * 60 * 60;

  it("keeps the idle lifetime within the 14-day window of the measure", () => {
    expect(
      SESSION_IDLE_TTL_SECONDS,
      "migration 0127 counts a session signed in before the 14 days and touched after them as a return inside them, which holds only while a session idle for 14 days is already gone: revise activation_return_freeze and ADR 0106 (D9) before raising the idle lifetime past 14 days"
    ).toBeLessThanOrEqual(14 * day);
  });

  it("renews the session no more than once a day, so a renewal is never on the day of its creation", () => {
    expect(
      SESSION_REFRESH_INTERVAL_SECONDS,
      "migration 0127 reads a touch on a later day of São Paulo than the session's creation as a return, which rests on a renewal being a day or more after the creation: under 24 hours it could fall on the same day, revise the function and ADR 0106 (D9) first"
    ).toBeGreaterThanOrEqual(day);
  });
});
