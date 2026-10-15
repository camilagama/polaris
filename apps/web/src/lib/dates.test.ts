import { describe, expect, it } from "vitest";
import {
  calendarDayInTimezone,
  clockPartsInTimezone,
  isCalendarDate,
} from "./dates";

const dayText = /^\d{4}-\d{2}-\d{2}$/;
const clockDateText = /^\d{2}\/\d{2}\/\d{4}$/;

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

describe("clockPartsInTimezone", () => {
  const instant = new Date("2026-10-13T02:05:00.000Z");

  it("gives dd/mm/aaaa and HH:mm of the organization, not of UTC", () => {
    expect(clockPartsInTimezone(instant, "America/Sao_Paulo")).toEqual({
      date: "12/10/2026",
      time: "23:05",
    });
    expect(clockPartsInTimezone(instant, "UTC")).toEqual({
      date: "13/10/2026",
      time: "02:05",
    });
  });

  it("writes midnight as 00:00 and falls back to the device zone for an unknown zone", () => {
    expect(
      clockPartsInTimezone(new Date("2026-10-13T00:00:00.000Z"), "UTC").time
    ).toBe("00:00");
    expect(clockPartsInTimezone(instant, "Not/AZone").date).toMatch(
      clockDateText
    );
  });
});
