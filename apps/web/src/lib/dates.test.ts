import { describe, expect, it } from "vitest";
import { calendarDayInTimezone, isCalendarDate } from "./dates";

const dayText = /^\d{4}-\d{2}-\d{2}$/;

describe("calendarDayInTimezone", () => {
  const instant = new Date("2026-10-13T02:30:00.000Z");

  it("uses the organization's calendar day, not the UTC day", () => {
    expect(calendarDayInTimezone(instant, "America/Sao_Paulo")).toBe(
      "2026-10-12"
    );
    expect(calendarDayInTimezone(instant, "Asia/Tokyo")).toBe("2026-10-13");
    expect(calendarDayInTimezone(instant, "UTC")).toBe("2026-10-13");
  });

  it("falls back to the device zone for an unknown zone", () => {
    expect(calendarDayInTimezone(instant, "Not/AZone")).toMatch(dayText);
    expect(calendarDayInTimezone(instant, null)).toMatch(dayText);
  });
});

describe("isCalendarDate", () => {
  it("accepts only real calendar dates", () => {
    expect(isCalendarDate("2026-02-28")).toBe(true);
    expect(isCalendarDate("2028-02-29")).toBe(true);
    expect(isCalendarDate("2026-02-29")).toBe(false);
    expect(isCalendarDate("2026-13-01")).toBe(false);
    expect(isCalendarDate("26-02-01")).toBe(false);
    expect(isCalendarDate("")).toBe(false);
  });
});
