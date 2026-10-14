import { assert as fcAssert, integer, property } from "fast-check";
import { describe, expect, it } from "vitest";
import {
  assertSaleOccurredWithinWindow,
  calendarDaysBetween,
  OWNER_MAX_RETROACTIVE_DAYS,
  retroactiveLimitDaysForRole,
  SaleOccurredTooOldError,
} from "./sale-dates";

const saoPaulo = "America/Sao_Paulo";
const now = new Date("2026-10-13T15:00:00Z"); // 12:00 on 2026-10-13 in São Paulo

describe("retroactiveLimitDaysForRole", () => {
  it("gives the V1 owner about 30 days and unknown roles none", () => {
    expect(retroactiveLimitDaysForRole("owner")).toBe(30);
    expect(OWNER_MAX_RETROACTIVE_DAYS).toBe(30);
    for (const role of ["admin", "", "__proto__", "OWNER"]) {
      expect(retroactiveLimitDaysForRole(role)).toBe(0);
    }
  });
});

describe("calendarDaysBetween", () => {
  it("counts calendar days across months, years and leap days", () => {
    expect(calendarDaysBetween("2026-10-13", "2026-10-13")).toBe(0);
    expect(calendarDaysBetween("2026-09-13", "2026-10-13")).toBe(30);
    expect(calendarDaysBetween("2025-12-31", "2026-01-01")).toBe(1);
    expect(calendarDaysBetween("2024-02-28", "2024-03-01")).toBe(2);
    expect(calendarDaysBetween("2026-10-14", "2026-10-13")).toBe(-1);
  });
});

describe("assertSaleOccurredWithinWindow", () => {
  const window = (occurredAt: string, timeZone = saoPaulo, days = 30) => ({
    maxRetroactiveDays: days,
    now,
    occurredAt: new Date(occurredAt),
    timeZone,
  });

  it("returns the commercial date in the organization's calendar", () => {
    // 01:30Z is the previous evening in São Paulo and already tomorrow in Tokyo
    expect(assertSaleOccurredWithinWindow(window("2026-10-13T01:30:00Z"))).toBe(
      "2026-10-12"
    );
    expect(
      assertSaleOccurredWithinWindow(
        window("2026-10-13T01:30:00Z", "Asia/Tokyo")
      )
    ).toBe("2026-10-13");
  });

  it("accepts the same local date 30 days ago and rejects the day before", () => {
    // 2026-09-13 local is exactly 30 calendar days before 2026-10-13
    expect(assertSaleOccurredWithinWindow(window("2026-09-13T03:00:00Z"))).toBe(
      "2026-09-13"
    );
    // one second earlier is still the evening of 2026-09-12 in São Paulo
    expect(() =>
      assertSaleOccurredWithinWindow(window("2026-09-13T02:59:59Z"))
    ).toThrow(SaleOccurredTooOldError);
    expect(() =>
      assertSaleOccurredWithinWindow(window("2025-01-01T12:00:00Z"))
    ).toThrow(SaleOccurredTooOldError);
  });

  it("follows the organization's calendar, so the same instant can fall on either side", () => {
    // 14:30Z is 11:30 on 2026-09-13 in São Paulo (30 days before its "today",
    // 2026-10-13) but 23:30 on 2026-09-13 in Tokyo, where "today" is already
    // 2026-10-14, 31 days later.
    const instant = "2026-09-13T14:30:00Z";
    expect(assertSaleOccurredWithinWindow(window(instant, saoPaulo))).toBe(
      "2026-09-13"
    );
    expect(() =>
      assertSaleOccurredWithinWindow(window(instant, "Asia/Tokyo"))
    ).toThrow(SaleOccurredTooOldError);
  });
  it("allows today and the near past, and has no window for a zero-day role", () => {
    expect(assertSaleOccurredWithinWindow(window("2026-10-13T12:00:00Z"))).toBe(
      "2026-10-13"
    );
    expect(
      assertSaleOccurredWithinWindow(
        window("2026-10-13T12:00:00Z", saoPaulo, 0)
      )
    ).toBe("2026-10-13");
    expect(() =>
      assertSaleOccurredWithinWindow(
        window("2026-10-12T12:00:00Z", saoPaulo, 0)
      )
    ).toThrow(SaleOccurredTooOldError);
  });

  it("is monotonic: the older the sale, the less likely it is accepted (property)", () => {
    fcAssert(
      property(
        integer({ max: 120, min: 0 }),
        integer({ max: 120, min: 0 }),
        (first, second) => {
          const accepts = (daysAgo: number) => {
            try {
              assertSaleOccurredWithinWindow({
                maxRetroactiveDays: 30,
                now,
                occurredAt: new Date(now.getTime() - daysAgo * 86_400_000),
                timeZone: saoPaulo,
              });
              return true;
            } catch (error) {
              expect(error).toBeInstanceOf(SaleOccurredTooOldError);
              return false;
            }
          };
          const [older, newer] =
            first >= second ? [first, second] : [second, first];
          if (accepts(older)) {
            expect(accepts(newer)).toBe(true);
          }
          expect(accepts(30)).toBe(true);
          expect(accepts(31)).toBe(false);
        }
      ),
      { numRuns: 200 }
    );
  });
});
