import { describe, expect, it } from "vitest";
import { type DailySalesReadModel, dailySales, polarisContract } from "./index";

const input = polarisContract.report.dailySales["~orpc"].inputSchema;

function dates(from: string, days: number): string[] {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  return Array.from({ length: days }, (_, index) =>
    new Date(start + index * 86_400_000).toISOString().slice(0, 10)
  );
}

describe("report.dailySales input", () => {
  it.each([
    ["2026-04-27", "2026-10-25", 182],
    ["2026-10-25", "2026-10-25", 1],
    ["2028-01-01", "2028-06-30", 182],
  ])("takes %s to %s (%s dates)", async (from, to) => {
    const parsed = await input?.["~standard"].validate({
      from,
      organizationId: "org",
      to,
    });
    expect(parsed).not.toHaveProperty("issues");
  });

  it.each([
    ["2026-04-26", "2026-10-25"],
    ["2028-01-01", "2028-07-01"],
    ["2025-10-25", "2026-10-25"],
  ])("refuses %s to %s (183 dates or more)", async (from, to) => {
    const parsed = await input?.["~standard"].validate({
      from,
      organizationId: "org",
      to,
    });
    expect(parsed).toHaveProperty("issues");
    expect(JSON.stringify(parsed)).toContain("period_too_long");
  });

  it.each([
    { from: "25/10/2026", organizationId: "org", to: "2026-10-25" },
    { from: "2026-10-01", organizationId: " ", to: "2026-10-25" },
    { from: "2026-10-01", to: "2026-10-25" },
  ])("refuses a malformed date or a missing organization: %o", async (bad) => {
    expect(await input?.["~standard"].validate(bad)).toHaveProperty("issues");
  });
});

describe("report.dailySales output", () => {
  it("is the first date and two positional arrays, a date without sales 0.00 and 0", () => {
    const series: DailySalesReadModel = {
      count: [2, 0, 1],
      from: "2026-10-01",
      net: ["150.90", "0.00", "10.00"],
    };
    expect(dailySales.parse(series)).toEqual(series);
  });

  it("refuses arrays of different lengths, a negative or fractional count and more than 182 dates", () => {
    const from = "2026-01-01";
    for (const bad of [
      { count: [1], from, net: ["1.00", "2.00"] },
      { count: [-1], from, net: ["1.00"] },
      { count: [1.5], from, net: ["1.00"] },
      {
        count: Array.from({ length: 183 }, () => 0),
        from,
        net: Array.from({ length: 183 }, () => "0.00"),
      },
    ]) {
      expect(dailySales.safeParse(bad).success).toBe(false);
    }
  });

  it("stays under 3 KB of JSON for 182 dates, even with five-digit days", () => {
    const days = dates("2026-04-27", 182);
    const series = dailySales.parse({
      count: days.map(() => 999),
      from: days[0],
      net: days.map(() => "99999.99"),
    });
    // ASCII only: the length is the size in bytes
    expect(JSON.stringify(series).length).toBeLessThan(3 * 1024);
  });
});
