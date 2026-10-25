import { describe, expect, it } from "vitest";
import { calendarDayInTimezone } from "../lib/dates";
import {
  addDays,
  availablePresets,
  copyMonthOf,
  dayCount,
  LONG_PERIODS_ENABLED,
  MAX_PERIOD_DAYS,
  maxPeriodDays,
  monthAbbreviation,
  monthName,
  type PeriodPreset,
  periodText,
  presetPeriod,
  rangeMessage,
  rangeProblem,
  samePeriod,
} from "./result-period";

describe("what each preset reads (AC-1)", () => {
  it("reads this month whole, with its last day, and last month whole", () => {
    expect(presetPeriod("this-month", "2026-10-23", null)).toEqual({
      from: "2026-10-01",
      to: "2026-10-31",
    });
    expect(presetPeriod("last-month", "2026-10-23", null)).toEqual({
      from: "2026-09-01",
      to: "2026-09-30",
    });
  });

  it("turns the year at the edge of January: last month is December of the year before", () => {
    expect(presetPeriod("last-month", "2026-01-05", null)).toEqual({
      from: "2025-12-01",
      to: "2025-12-31",
    });
    expect(presetPeriod("this-month", "2026-12-31", null)).toEqual({
      from: "2026-12-01",
      to: "2026-12-31",
    });
  });

  it("knows February, with and without the leap day", () => {
    expect(presetPeriod("this-month", "2028-02-10", null)?.to).toBe(
      "2028-02-29"
    );
    expect(presetPeriod("last-month", "2026-03-10", null)).toEqual({
      from: "2026-02-01",
      to: "2026-02-28",
    });
  });

  it("reads the last 30 days as today minus 29 up to today, across months and years", () => {
    expect(presetPeriod("last-30", "2026-10-23", null)).toEqual({
      from: "2026-09-24",
      to: "2026-10-23",
    });
    expect(presetPeriod("last-30", "2026-01-10", null)).toEqual({
      from: "2025-12-12",
      to: "2026-01-10",
    });
    expect(dayCount(presetPeriod("last-30", "2026-03-01", null) as never)).toBe(
      30
    );
  });

  it("reads the year from January 1st to today", () => {
    expect(presetPeriod("year", "2026-10-23", null)).toEqual({
      from: "2026-01-01",
      to: "2026-10-23",
    });
    expect(presetPeriod("year", "2026-01-01", null)).toEqual({
      from: "2026-01-01",
      to: "2026-01-01",
    });
  });

  it("reads the range the person gave, and nothing before there is one", () => {
    const custom = { from: "2026-10-05", to: "2026-10-12" };
    expect(presetPeriod("custom", "2026-10-23", custom)).toEqual(custom);
    expect(presetPeriod("custom", "2026-10-23", null)).toBeNull();
  });

  it("starts the day in the store's zone: Manaus and Rio Branco are still on the 30th when UTC is on the 31st", () => {
    // 02:00 UTC of October 31st: 22:00 on the 30th in Manaus (UTC-4), 21:00 in Rio Branco (UTC-5)
    const instant = new Date("2026-10-31T02:00:00.000Z");
    for (const zone of ["America/Manaus", "America/Rio_Branco"]) {
      const today = calendarDayInTimezone(instant, zone);
      expect(today).toBe("2026-10-30");
      expect(presetPeriod("last-30", today, null)).toEqual({
        from: "2026-10-01",
        to: "2026-10-30",
      });
    }
    // and at the edge of the year: still December 31st in Rio Branco while UTC is on January 1st
    const newYear = new Date("2027-01-01T03:00:00.000Z");
    const today = calendarDayInTimezone(newYear, "America/Rio_Branco");
    expect(today).toBe("2026-12-31");
    expect(presetPeriod("year", today, null)).toEqual({
      from: "2026-01-01",
      to: "2026-12-31",
    });
    expect(presetPeriod("last-month", today, null)?.from).toBe("2026-11-01");
  });
});

describe("the presets on offer (AC-2, AC-23)", () => {
  it("keeps the year and the long ranges off until the CPU measure is registered", () => {
    expect(LONG_PERIODS_ENABLED).toBe(false);
    expect(availablePresets()).toEqual([
      "this-month",
      "last-month",
      "last-30",
      "custom",
    ]);
    expect(maxPeriodDays()).toBe(62);
  });

  it("opens the year and the 366 days with the switch on", () => {
    expect(availablePresets(true)).toContain<PeriodPreset>("year");
    expect(maxPeriodDays(true)).toBe(MAX_PERIOD_DAYS);
    expect(MAX_PERIOD_DAYS).toBe(366);
  });
});

describe("the range of Período (AC-2)", () => {
  it("accepts a range of up to 62 days, both ends counted", () => {
    expect(rangeProblem("2026-10-01", "2026-10-01")).toBeNull();
    expect(rangeProblem("2026-09-01", "2026-11-01")).toBeNull(); // 62 days
    expect(dayCount({ from: "2026-09-01", to: "2026-11-01" })).toBe(62);
  });

  it("refuses 63 days while the long periods are off, with the limit in the text", () => {
    expect(rangeProblem("2026-09-01", "2026-11-02")).toBe("too_long");
    expect(rangeMessage("too_long")).toBe("Escolha até 62 dias.");
  });

  it("allows 366 days and refuses 367 with the long periods on", () => {
    expect(rangeProblem("2026-01-01", "2026-12-31", 366)).toBeNull();
    expect(rangeProblem("2026-01-01", "2027-01-02", 366)).toBe("too_long");
    // a leap year has 366 days and is the longest range there is
    expect(rangeProblem("2028-01-01", "2028-12-31", 366)).toBeNull();
    expect(rangeMessage("too_long", 366)).toBe("Escolha até 1 ano.");
  });

  it("says what is wrong when an end is missing or is not a date, and when they are in the wrong order", () => {
    expect(rangeProblem("", "2026-10-10")).toBe("missing");
    expect(rangeProblem("2026-10-10", "")).toBe("missing");
    expect(rangeProblem("2026-02-30", "2026-03-10")).toBe("missing");
    expect(rangeProblem("2026-10-10", "2026-10-09")).toBe("order");
    expect(rangeMessage("missing")).toBe("Escolha a data inicial e a final.");
    expect(rangeMessage("order")).toBe("A data inicial vem depois da final.");
  });
});

describe("the dates in words (AC-1)", () => {
  it("says a period in one month as 1 a 23 de outubro", () => {
    expect(periodText({ from: "2026-10-01", to: "2026-10-23" }, "2026")).toBe(
      "1 a 23 de outubro"
    );
  });

  it("says a period across two months with both names", () => {
    expect(periodText({ from: "2026-09-24", to: "2026-10-23" }, "2026")).toBe(
      "24 de setembro a 23 de outubro"
    );
  });

  it("says one day on its own", () => {
    expect(periodText({ from: "2026-10-23", to: "2026-10-23" }, "2026")).toBe(
      "23 de outubro"
    );
  });

  it("writes the year when it is not this year or when the period crosses one", () => {
    expect(periodText({ from: "2025-10-01", to: "2025-10-31" }, "2026")).toBe(
      "1 a 31 de outubro de 2025"
    );
    expect(periodText({ from: "2025-12-12", to: "2026-01-10" }, "2026")).toBe(
      "12 de dezembro de 2025 a 10 de janeiro de 2026"
    );
  });

  it("names the months for the table and the axis of the long periods", () => {
    expect(monthName("2026-01-15")).toBe("janeiro");
    expect(monthName("2026-03")).toBe("março");
    expect(monthAbbreviation("2026-01-15")).toBe("jan");
    expect(monthAbbreviation("2026-02")).toBe("fev");
  });
});

describe("the copy of the device (AC-16, Q-2)", () => {
  it("exists only for the two months, under the month of the period", () => {
    const month = { from: "2026-09-01", to: "2026-09-30" };
    expect(copyMonthOf("last-month", month)).toBe("2026-09");
    expect(
      copyMonthOf("this-month", { from: "2026-10-01", to: "2026-10-31" })
    ).toBe("2026-10");
  });

  it("has none for a window that moves, the year or a range", () => {
    const window = { from: "2026-09-24", to: "2026-10-23" };
    expect(copyMonthOf("last-30", window)).toBeNull();
    expect(copyMonthOf("year", window)).toBeNull();
    // even a range that happens to be a whole month: it would take the name of a month it is not asked as
    expect(
      copyMonthOf("custom", { from: "2026-09-01", to: "2026-09-30" })
    ).toBeNull();
  });
});

describe("calendar arithmetic", () => {
  it("adds days across month and year ends", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("compares two periods by their dates", () => {
    expect(
      samePeriod(
        { from: "2026-10-01", to: "2026-10-31" },
        { from: "2026-10-01", to: "2026-10-31" }
      )
    ).toBe(true);
    expect(
      samePeriod(
        { from: "2026-10-01", to: "2026-10-31" },
        { from: "2026-10-01", to: "2026-10-30" }
      )
    ).toBe(false);
    expect(samePeriod(null, { from: "2026-10-01", to: "2026-10-31" })).toBe(
      false
    );
  });
});
