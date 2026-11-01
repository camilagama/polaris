import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { homeWritesDays } from "./home-writes-days";

const at = (iso: string) => () => new Date(iso);

const gateSource = readFileSync(
  new URL("./verify-home-writes-gate.ts", import.meta.url),
  "utf8"
);

function unpinnedSales(source: string): number {
  const calls = source.split("confirmPlainSale(").slice(1);
  return calls.filter(
    (call) => !call.split(");")[0]?.includes("occurredAt: days.saleInstant")
  ).length;
}

describe("the days of the home-writes gate", () => {
  const cases = [
    {
      iso: "2026-11-01T03:37:00.000Z",
      month: { from: "2026-10-01", to: "2026-10-31" },
      name: "the 1st just after midnight in São Paulo",
      saleDay: "2026-10-31",
      today: "2026-11-01",
    },
    {
      iso: "2026-11-01T02:59:59.000Z",
      month: { from: "2026-10-01", to: "2026-10-31" },
      name: "the last second of the 31st in São Paulo",
      saleDay: "2026-10-30",
      today: "2026-10-31",
    },
    {
      iso: "2026-11-01T03:00:00.000Z",
      month: { from: "2026-10-01", to: "2026-10-31" },
      name: "the first second of the 1st in São Paulo",
      saleDay: "2026-10-31",
      today: "2026-11-01",
    },
    {
      iso: "2026-10-15T15:00:00.000Z",
      month: { from: "2026-10-01", to: "2026-10-31" },
      name: "the middle of a month",
      saleDay: "2026-10-14",
      today: "2026-10-15",
    },
    {
      iso: "2026-10-31T20:00:00.000Z",
      month: { from: "2026-10-01", to: "2026-10-31" },
      name: "the last day of a month",
      saleDay: "2026-10-30",
      today: "2026-10-31",
    },
    {
      iso: "2028-02-29T12:00:00.000Z",
      month: { from: "2028-02-01", to: "2028-02-29" },
      name: "the last day of February in a leap year",
      saleDay: "2028-02-28",
      today: "2028-02-29",
    },
    {
      iso: "2027-01-01T02:59:59.000Z",
      month: { from: "2026-12-01", to: "2026-12-31" },
      name: "the last second of the year in São Paulo",
      saleDay: "2026-12-30",
      today: "2026-12-31",
    },
    {
      iso: "2027-01-01T03:00:00.000Z",
      month: { from: "2026-12-01", to: "2026-12-31" },
      name: "the first second of the year in São Paulo",
      saleDay: "2026-12-31",
      today: "2027-01-01",
    },
  ] as const;

  for (const { iso, month, name, saleDay, today } of cases) {
    it(`reads the month of the sale on ${name}`, () => {
      const days = homeWritesDays(at(iso));
      expect(days.today).toBe(today);
      expect(days.saleInstant).toBe(`${saleDay}T15:00:00.000Z`);
      expect(days.month).toEqual(month);
      expect(days.saleInstant < iso).toBe(true);
      expect(days.before.to < days.month.from).toBe(true);
    });
  }

  it("covers the day before the month on the 1st with the previous month", () => {
    const days = homeWritesDays(at("2026-11-01T03:37:00.000Z"));
    expect(days.before).toEqual({ from: "2026-09-01", to: "2026-09-30" });
  });

  it("is the same for every time of the same store day", () => {
    const a = homeWritesDays(at("2026-10-15T03:00:00.000Z"));
    const b = homeWritesDays(at("2026-10-16T02:59:59.000Z"));
    expect(a).toEqual(b);
  });
});

describe("the seeded sales of the gate", () => {
  it("every confirmPlainSale of the gate carries the instant of the gate's own clock", () => {
    expect(gateSource.split("confirmPlainSale(").length - 1).toBeGreaterThan(1);
    expect(unpinnedSales(gateSource)).toBe(0);
  });

  it("rejects a sale seeded without it", () => {
    const planted = `${gateSource}\nawait confirmPlainSale(rt, tenant, [{ quantity: 1, variantId: "x" }]);\n`;
    expect(unpinnedSales(planted)).toBe(1);
  });
});
