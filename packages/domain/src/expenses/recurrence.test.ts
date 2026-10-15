import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  dueOccurrences,
  InvalidExpenseRuleError,
  MAX_OCCURRENCES_PER_PASS,
  normalizeExpenseRule,
  occurrenceDate,
  occurrencesThrough,
  type RecurrenceFrequency,
} from "./recurrence";

const base = {
  amount: "1500",
  description: "Aluguel",
  frequency: "monthly",
  startsOn: "2026-01-05",
};
const today = "2026-10-14";

describe("occurrenceDate", () => {
  it("starts on the start date and steps weekly", () => {
    expect(occurrenceDate("2026-01-05", "weekly", 0)).toBe("2026-01-05");
    expect(occurrenceDate("2026-01-05", "weekly", 1)).toBe("2026-01-12");
    expect(occurrenceDate("2026-12-28", "weekly", 1)).toBe("2027-01-04");
  });

  it("steps monthly, counting from the start day: the 31st clamps and comes back", () => {
    const dates = [0, 1, 2, 3].map((n) =>
      occurrenceDate("2026-01-31", "monthly", n)
    );
    expect(dates).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
    ]);
    expect(occurrenceDate("2027-12-15", "monthly", 2)).toBe("2028-02-15");
    // leap year February
    expect(occurrenceDate("2027-11-30", "monthly", 3)).toBe("2028-02-29");
  });

  it("steps yearly and clamps Feb 29 in common years", () => {
    expect(occurrenceDate("2028-02-29", "yearly", 0)).toBe("2028-02-29");
    expect(occurrenceDate("2028-02-29", "yearly", 1)).toBe("2029-02-28");
    expect(occurrenceDate("2028-02-29", "yearly", 4)).toBe("2032-02-29");
  });

  it("is strictly increasing and always a real calendar date (property)", () => {
    const frequency = fc.constantFrom<RecurrenceFrequency>(
      "weekly",
      "monthly",
      "yearly"
    );
    const start = fc
      .date({
        max: new Date("2060-12-31"),
        min: new Date("2000-01-01"),
        noInvalidDate: true,
      })
      .map((date) => date.toISOString().slice(0, 10));
    fc.assert(
      fc.property(
        start,
        frequency,
        fc.integer({ max: 60, min: 0 }),
        (s, f, n) => {
          const a = occurrenceDate(s, f, n);
          const b = occurrenceDate(s, f, n + 1);
          expect(b > a).toBe(true);
          expect(new Date(`${a}T00:00:00Z`).toISOString().slice(0, 10)).toBe(a);
        }
      )
    );
  });
});

describe("dueOccurrences", () => {
  const rule = {
    endsOn: null,
    frequency: "monthly" as const,
    startsOn: "2026-01-05",
    today,
  };

  it("returns every occurrence up to today, starting from what was generated", () => {
    const all = dueOccurrences({ ...rule, generatedCount: 0 });
    expect(all.map((o) => o.date)).toEqual([
      "2026-01-05",
      "2026-02-05",
      "2026-03-05",
      "2026-04-05",
      "2026-05-05",
      "2026-06-05",
      "2026-07-05",
      "2026-08-05",
      "2026-09-05",
      "2026-10-05",
    ]);
    expect(all.map((o) => o.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(
      dueOccurrences({ ...rule, generatedCount: 8 }).map((o) => o.date)
    ).toEqual(["2026-09-05", "2026-10-05"]);
  });

  it("returns nothing when everything due was generated, or the start is ahead", () => {
    expect(dueOccurrences({ ...rule, generatedCount: 10 })).toEqual([]);
    expect(
      dueOccurrences({ ...rule, generatedCount: 0, startsOn: "2026-10-15" })
    ).toEqual([]);
    // an occurrence exactly today is due
    expect(
      dueOccurrences({ ...rule, generatedCount: 0, startsOn: "2026-10-14" })
    ).toHaveLength(1);
  });

  it("stops at the end date", () => {
    expect(
      dueOccurrences({ ...rule, endsOn: "2026-03-05", generatedCount: 0 })
    ).toHaveLength(3);
    expect(
      dueOccurrences({ ...rule, endsOn: "2026-03-04", generatedCount: 0 })
    ).toHaveLength(2);
    // an end date in the future does not allow the future
    expect(
      dueOccurrences({ ...rule, endsOn: "2027-12-31", generatedCount: 9 })
    ).toHaveLength(1);
  });

  it("catches up after a long pause, a limited number per pass, and passes add up to one", () => {
    const weekly = {
      endsOn: null,
      frequency: "weekly" as const,
      startsOn: "2000-01-01",
      today,
    };
    const first = dueOccurrences({ ...weekly, generatedCount: 0 });
    expect(first).toHaveLength(MAX_OCCURRENCES_PER_PASS);
    const second = dueOccurrences({
      ...weekly,
      generatedCount: first.length,
    });
    expect(second[0]?.index).toBe(MAX_OCCURRENCES_PER_PASS);
    expect(second[0]?.date).toBe(
      occurrenceDate("2000-01-01", "weekly", MAX_OCCURRENCES_PER_PASS)
    );
    const unlimited = dueOccurrences({
      ...weekly,
      generatedCount: 0,
      limit: MAX_OCCURRENCES_PER_PASS,
    });
    expect(unlimited).toEqual(first);
  });

  it("continuing from any split gives the same dates as one pass (property)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<RecurrenceFrequency>("weekly", "monthly", "yearly"),
        fc.integer({ max: 30, min: 0 }),
        (frequency, split) => {
          const args = {
            endsOn: null,
            frequency,
            startsOn: "2024-02-29",
            today,
          };
          const whole = dueOccurrences({ ...args, generatedCount: 0 });
          const head = whole.slice(0, split);
          const tail = dueOccurrences({ ...args, generatedCount: head.length });
          expect([...head, ...tail]).toEqual(whole);
        }
      )
    );
  });
});

describe("normalizeExpenseRule", () => {
  it("normalizes like an expense and keeps the frequency and the dates", () => {
    expect(
      normalizeExpenseRule(
        { ...base, amount: " 1500 ", description: "  Aluguel ", payee: " " },
        today
      )
    ).toEqual({
      amount: "1500.00",
      description: "Aluguel",
      endsOn: null,
      frequency: "monthly",
      payee: null,
      startsOn: "2026-01-05",
    });
  });

  it.each([
    ["unknown frequency", { frequency: "daily" }],
    ["impossible start", { startsOn: "2026-02-30" }],
    ["start before 2000", { startsOn: "1999-12-31" }],
    ["start too far ahead", { startsOn: "2027-10-16" }],
    ["end before start", { endsOn: "2026-01-04" }],
    ["impossible end", { endsOn: "2026-13-01" }],
    ["zero amount", { amount: "0" }],
    ["blank description", { description: " " }],
  ])("refuses %s", (_label, override) => {
    expect(() => normalizeExpenseRule({ ...base, ...override }, today)).toThrow(
      InvalidExpenseRuleError
    );
  });

  it("accepts a start up to 366 days ahead, and an end equal to the start", () => {
    expect(() =>
      normalizeExpenseRule(
        { ...base, endsOn: "2027-10-15", startsOn: "2027-10-15" },
        today
      )
    ).not.toThrow();
  });
});

describe("occurrencesThrough", () => {
  it("counts the occurrences on or before a date", () => {
    expect(occurrencesThrough("2026-01-05", "monthly", "2026-01-04")).toBe(0);
    expect(occurrencesThrough("2026-01-05", "monthly", "2026-01-05")).toBe(1);
    expect(occurrencesThrough("2026-01-05", "monthly", "2026-10-14")).toBe(10);
    expect(occurrencesThrough("2026-01-31", "monthly", "2026-02-28")).toBe(2);
    expect(occurrencesThrough("2026-01-05", "weekly", "2026-01-18")).toBe(2);
    expect(occurrencesThrough("2028-02-29", "yearly", "2029-02-27")).toBe(1);
    expect(occurrencesThrough("2028-02-29", "yearly", "2029-02-28")).toBe(2);
  });

  it("agrees with generating the due occurrences one by one (property)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<RecurrenceFrequency>("weekly", "monthly", "yearly"),
        fc
          .date({
            max: new Date("2030-12-31"),
            min: new Date("2010-01-01"),
            noInvalidDate: true,
          })
          .map((date) => date.toISOString().slice(0, 10)),
        fc
          .date({
            max: new Date("2040-12-31"),
            min: new Date("2010-01-01"),
            noInvalidDate: true,
          })
          .map((date) => date.toISOString().slice(0, 10)),
        (frequency, startsOn, through) => {
          const counted = occurrencesThrough(startsOn, frequency, through);
          const generated = dueOccurrences({
            endsOn: null,
            frequency,
            generatedCount: 0,
            limit: 500,
            startsOn,
            today: through,
          });
          if (generated.length < 500) {
            expect(counted).toBe(generated.length);
          } else {
            expect(counted).toBeGreaterThanOrEqual(500);
          }
        }
      )
    );
  });
});
