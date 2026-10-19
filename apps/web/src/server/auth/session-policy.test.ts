import { describe, expect, it } from "vitest";
import { RECENT_LOGIN_MINUTES } from "../../offline/runtime/devices-model";
import {
  FRESH_SESSION_MAX_AGE_MILLISECONDS,
  isSessionFresh,
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
