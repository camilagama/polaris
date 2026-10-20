import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addCalendarMonths,
  InvalidDueDateError,
  paidPeriodEndsAt,
  saoPauloDateOf,
} from "./provider-period";

describe("addCalendarMonths", () => {
  it.each([
    ["2026-10-29", 1, "2026-11-29"],
    ["2026-10-30", 1, "2026-11-30"],
    ["2026-10-31", 1, "2026-11-30"],
    ["2026-10-29", 12, "2027-10-29"],
    ["2026-10-30", 12, "2027-10-30"],
    ["2026-10-31", 12, "2027-10-31"],
    ["2026-12-15", 1, "2027-01-15"],
    ["2026-08-31", 6, "2027-02-28"],
  ])("adds %s + %i months = %s", (date, months, expected) => {
    expect(addCalendarMonths(date, months)).toBe(expected);
  });

  it("clamps 29, 30 and 31 January to the last day of a short February", () => {
    expect(addCalendarMonths("2027-01-29", 1)).toBe("2027-02-28");
    expect(addCalendarMonths("2027-01-30", 1)).toBe("2027-02-28");
    expect(addCalendarMonths("2027-01-31", 1)).toBe("2027-02-28");
  });

  it("keeps 29 February in a leap year when the target is leap too", () => {
    expect(addCalendarMonths("2028-01-29", 1)).toBe("2028-02-29");
    expect(addCalendarMonths("2028-01-31", 1)).toBe("2028-02-29");
  });

  it("clamps 29/02 of a leap year plus 12 months to 28/02", () => {
    expect(addCalendarMonths("2028-02-29", 12)).toBe("2029-02-28");
  });

  it("renews 31/01 to 28/02 and the renewal due 28/02 ends on 28/03", () => {
    const first = addCalendarMonths("2027-01-31", 1);
    const second = addCalendarMonths(first, 1);
    expect(first).toBe("2027-02-28");
    expect(second).toBe("2027-03-28");
    expect(second).not.toBe("2027-03-31");
  });

  it("returns the same date for zero months", () => {
    expect(addCalendarMonths("2026-10-31", 0)).toBe("2026-10-31");
  });

  it.each([
    "2026-02-30",
    "2027-02-29",
    "26-10-01",
    "",
    "2026-13-01",
    "2026-10-01T00:00:00Z",
  ])("rejects the invalid date %j", (date) => {
    expect(() => addCalendarMonths(date, 1)).toThrow(InvalidDueDateError);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects %s months",
    (months) => {
      expect(() => addCalendarMonths("2026-10-01", months)).toThrow(
        InvalidDueDateError
      );
    }
  );

  it("carries a stable error code that leaks nothing", () => {
    try {
      addCalendarMonths("2026-02-30", 1);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidDueDateError);
      expect((error as InvalidDueDateError).code).toBe("invalid_due_date");
      expect((error as Error).message).toBe("invalid_due_date");
    }
  });
});

describe("paidPeriodEndsAt", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ends at the end of the day in Sao Paulo (03:00 UTC of the next day)", () => {
    expect(paidPeriodEndsAt("2026-10-26", 1)).toEqual(
      new Date("2026-11-27T03:00:00.000Z")
    );
  });

  it("ends a yearly period at the end of the same day a year later", () => {
    expect(paidPeriodEndsAt("2026-10-26", 12)).toEqual(
      new Date("2027-10-27T03:00:00.000Z")
    );
  });

  it("ends a semiannual period six months later", () => {
    expect(paidPeriodEndsAt("2026-10-26", 6)).toEqual(
      new Date("2027-04-27T03:00:00.000Z")
    );
  });

  it("rolls over the month and year boundary", () => {
    expect(paidPeriodEndsAt("2026-11-30", 1)).toEqual(
      new Date("2026-12-31T03:00:00.000Z")
    );
    expect(paidPeriodEndsAt("2026-12-31", 12)).toEqual(
      new Date("2028-01-01T03:00:00.000Z")
    );
  });

  it("ends a charge due 31/01 on the whole of 28/02", () => {
    expect(paidPeriodEndsAt("2027-01-31", 1)).toEqual(
      new Date("2027-03-01T03:00:00.000Z")
    );
  });

  it("rejects an invalid due date", () => {
    expect(() => paidPeriodEndsAt("2026-02-30", 1)).toThrow(
      InvalidDueDateError
    );
    expect(() => paidPeriodEndsAt("", 1)).toThrow(InvalidDueDateError);
  });

  it("gives the same end whatever the clock says", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2020-01-01T00:00:00.000Z"));
    const early = paidPeriodEndsAt("2026-10-26", 1);
    vi.setSystemTime(new Date("2031-06-15T12:34:56.000Z"));
    const late = paidPeriodEndsAt("2026-10-26", 1);
    expect(early).toEqual(late);
    expect(early.toISOString()).toBe("2026-11-27T03:00:00.000Z");
  });
});

describe("saoPauloDateOf", () => {
  it("is the day in São Paulo, which starts at 03:00 UTC", () => {
    expect(saoPauloDateOf(new Date("2026-10-20T02:59:59.999Z"))).toBe(
      "2026-10-19"
    );
    expect(saoPauloDateOf(new Date("2026-10-20T03:00:00.000Z"))).toBe(
      "2026-10-20"
    );
    expect(saoPauloDateOf(new Date("2027-01-01T01:00:00.000Z"))).toBe(
      "2026-12-31"
    );
  });

  it("refuses an invalid instant", () => {
    expect(() => saoPauloDateOf(new Date(Number.NaN))).toThrow(
      "invalid_due_date"
    );
  });
});
