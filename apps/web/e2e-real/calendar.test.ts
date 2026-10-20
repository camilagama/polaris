import { describe, expect, it } from "vitest";
import { addDays, extremeTimeZone, localDate, monthStart } from "./calendar";

describe("the calendar of the e2e journeys", () => {
  it("always picks a zone whose date differs from UTC", () => {
    const start = Date.parse("2026-10-20T00:00:00Z");
    for (let minutes = 0; minutes < 24 * 60; minutes += 15) {
      const instant = start + minutes * 60_000;
      const zone = extremeTimeZone(instant);
      expect(
        localDate(instant, zone),
        `${new Date(instant).toISOString()} ${zone}`
      ).not.toBe(localDate(instant, "UTC"));
    }
  });

  it("shifts months and days by the calendar", () => {
    expect(monthStart("2026-12-31", 1)).toBe("2027-01-01");
    expect(monthStart("2026-01-15", -1)).toBe("2025-12-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});
