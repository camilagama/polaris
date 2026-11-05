import {
  MAX_LEGAL_HOLD_REVIEW_DAYS,
  normalizeLegalHoldReviewAt,
} from "@polaris/domain/admin/support-access";
import { describe, expect, it } from "vitest";
import { holdReviewAt, lastHoldReviewDay } from "../ui/views/purge";

const DAY_MS = 86_400_000;
const START = Date.parse("2026-11-05T00:00:00.000Z");

describe("review date of a legal hold: what the Admin page sends against the server's validator", () => {
  it("accepts a day in the middle of the range as the end of that day in Brasília", () => {
    const now = new Date("2026-11-05T15:00:00.000Z");
    const sent = holdReviewAt("2026-12-01", now);
    expect(sent).toBe("2026-12-01T23:59:59-03:00");
    expect(normalizeLegalHoldReviewAt(sent, now)).toBe(
      "2026-12-02T02:59:59.000Z"
    );
  });

  it("is refused by the server at the end of the last day, which is why the page sends an earlier instant", () => {
    const now = new Date("2026-11-05T15:00:00.000Z");
    const last = lastHoldReviewDay(now);
    const endOfDay = `${last}T23:59:59-03:00`;
    expect(new Date(endOfDay).getTime()).toBeGreaterThan(
      now.getTime() + MAX_LEGAL_HOLD_REVIEW_DAYS * DAY_MS
    );
    expect(() => normalizeLegalHoldReviewAt(endOfDay, now)).toThrow();
    expect(() =>
      normalizeLegalHoldReviewAt(holdReviewAt(last, now), now)
    ).not.toThrow();
  });

  it("is accepted for the last offered day at every moment of the day, and the day after is not offered", () => {
    let checked = 0;
    for (let minute = 0; minute < 24 * 60; minute += 7) {
      const now = new Date(START + minute * 60_000);
      const last = lastHoldReviewDay(now);
      const sent = holdReviewAt(last, now);
      expect(sent).not.toBeNull();
      expect(() => normalizeLegalHoldReviewAt(sent, now)).not.toThrow();
      const next = new Date(Date.parse(`${last}T12:00:00Z`) + DAY_MS)
        .toISOString()
        .slice(0, 10);
      expect(holdReviewAt(next, now)).toBeNull();
      checked += 1;
    }
    expect(checked).toBe(206);
  });

  it("is accepted for every offered day from today to the last", () => {
    const now = new Date("2026-11-05T02:30:00.000Z");
    const last = lastHoldReviewDay(now);
    let day = new Date(now.getTime() - 3 * 3_600_000)
      .toISOString()
      .slice(0, 10);
    let count = 0;
    while (day <= last) {
      expect(() =>
        normalizeLegalHoldReviewAt(holdReviewAt(day, now), now)
      ).not.toThrow();
      day = new Date(Date.parse(`${day}T12:00:00Z`) + DAY_MS)
        .toISOString()
        .slice(0, 10);
      count += 1;
    }
    expect(count).toBeGreaterThanOrEqual(365);
  });
});
