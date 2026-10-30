import { describe, expect, it } from "vitest";
import type { StoredDay } from "../lib/period-summary-cache";
import {
  comparisonPeriod,
  rangeText,
  resultChipPeriod,
  resultKpis,
} from "./result-kpis";
import { addDays } from "./result-period";

/** `count` days from `from`, each with R$ `sales` of net sales in one sale and a result of R$ `result`. */
function days(
  from: string,
  count: number,
  make: (index: number) => Partial<StoredDay> = () => ({})
): StoredDay[] {
  return Array.from({ length: count }, (_, index) => ({
    costs: "10.00",
    date: addDays(from, index),
    netSales: "50.00",
    operatingResult: "40.00",
    salesCount: 1,
    ...make(index),
  }));
}

const CARDS = {
  marginPercent: "41.2",
  netSales: "1250.00",
  operatingResult: "1000.00",
  salesCount: 25,
  ticket: "50.00",
};
const OCTOBER = { from: "2026-10-01", to: "2026-10-31" };
const SEPTEMBER = { from: "2026-09-01", to: "2026-09-30" };

describe("the period the chips compare with", () => {
  it("is the month before a whole month, of its own length", () => {
    expect(comparisonPeriod(OCTOBER, "2026-10-25")).toEqual(SEPTEMBER);
    expect(
      comparisonPeriod({ from: "2026-03-01", to: "2026-03-31" }, "2026-04-02")
    ).toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });

  it("is the same number of days just before any other range", () => {
    expect(
      comparisonPeriod({ from: "2026-09-26", to: "2026-10-25" }, "2026-10-25")
    ).toEqual({ from: "2026-08-27", to: "2026-09-25" });
  });

  it("is none for a period that has not started, or one that groups by month", () => {
    expect(comparisonPeriod(OCTOBER, "2026-09-30")).toBeNull();
    expect(
      comparisonPeriod({ from: "2026-01-01", to: "2026-10-25" }, "2026-10-25")
    ).toBeNull();
  });

  it("writes its dates short", () => {
    expect(rangeText("2026-10-01", "2026-10-25")).toBe("1 a 25/10");
    expect(rangeText("2026-09-26", "2026-10-25")).toBe("26/09 a 25/10");
    expect(rangeText("2026-10-25", "2026-10-25")).toBe("25/10");
  });
});

describe("the cards of the Resultado (v7 § 8)", () => {
  const previous = {
    days: days("2026-09-01", 30, () => ({
      netSales: "40.00",
      operatingResult: "30.00",
    })),
    period: SEPTEMBER,
  };

  it("reads the period up to today at rest, and compares with the same days of the month before", () => {
    const kpis = resultKpis({
      cards: CARDS,
      daily: days("2026-10-01", 31),
      period: OCTOBER,
      previous,
      previousSales: previous,
      today: "2026-10-25",
    });
    expect(kpis.days).toHaveLength(25);
    expect(kpis.month).toBe("outubro");
    const rest = kpis.read(null);
    expect(rest.sales).toMatchObject({
      count: "25 vendas",
      date: "1 a 25/10",
      delta: {
        basis: "em relação a 1 a 25/09",
        text: "+25,0%",
        trend: "up",
      },
      help: "Vendas líquidas de 1 a 25/10. Compara com 1 a 25/09.",
      note: null,
      value: "1250.00",
    });
    // every day known: the result is the sum of the days, with its chip in reais
    expect(rest.result).toMatchObject({
      date: "1 a 25/10",
      delta: { money: true, text: "+R$ 250,00" },
      value: "1000.00",
    });
    expect(rest.ticket.delta?.text).toBe("+25,0%");
    expect(kpis.series.result).toHaveLength(25);
  });

  it("takes the chips of sales and ticket from the sales read (dailySales) and the chip of the result from the summary", () => {
    // the sales read is the weaker month (R$ 40, 2 sales a day: ticket R$ 20); the summary's days say R$ 30, 1 sale
    const sales = {
      days: days("2026-09-01", 30, () => ({
        netSales: "40.00",
        salesCount: 2,
      })).map(({ date, netSales, salesCount }) => ({
        date,
        netSales,
        salesCount,
      })),
      period: SEPTEMBER,
    };
    const kpis = resultKpis({
      cards: CARDS,
      daily: days("2026-10-01", 31),
      period: OCTOBER,
      previous: {
        days: days("2026-09-01", 30, () => ({
          netSales: "10.00",
          operatingResult: "30.00",
          salesCount: 1,
        })),
        period: SEPTEMBER,
      },
      previousSales: sales,
      today: "2026-10-25",
    });
    const rest = kpis.read(null);
    // vendas: 25 x 50,00 = 1250,00 against 25 x 40,00 = 1000,00
    expect(rest.sales.delta).toMatchObject({ text: "+25,0%", trend: "up" });
    expect(rest.sales.delta?.basis).toBe("em relação a 1 a 25/09");
    // ticket: 50,00 against 1000,00 / 50 sales = 20,00
    expect(rest.ticket.delta).toMatchObject({ text: "+150,0%", trend: "up" });
    // resultado: 1000,00 against 25 x 30,00 = 750,00, from the summary's days, not from the sales read
    expect(rest.result.delta).toMatchObject({
      money: true,
      text: "+R$ 250,00",
    });
    // a day read compares the same days of the sales read: 10 x 50,00 against 10 x 40,00
    expect(kpis.read(9).sales).toMatchObject({
      delta: { basis: "em relação a 1 a 10/09", text: "+25,0%" },
    });
  });

  it("loses only the chips of sales and ticket when the sales read failed", () => {
    const rest = resultKpis({
      cards: CARDS,
      daily: days("2026-10-01", 31),
      period: OCTOBER,
      previous,
      previousSales: null,
      today: "2026-10-25",
    }).read(null);
    expect([rest.sales.delta, rest.ticket.delta]).toEqual([null, null]);
    expect([rest.sales.help, rest.ticket.help]).toEqual([
      "Vendas líquidas de 1 a 25/10.",
      "Vendas líquidas divididas pelo número de vendas, de 1 a 25/10.",
    ]);
    expect(rest.result.delta).toMatchObject({ text: "+R$ 250,00" });
  });

  it("loses only the chip of the result when the summary's read failed", () => {
    const rest = resultKpis({
      cards: CARDS,
      daily: days("2026-10-01", 31),
      period: OCTOBER,
      previous: null,
      previousSales: previous,
      today: "2026-10-25",
    }).read(null);
    expect(rest.result.delta).toBeNull();
    expect(rest.sales.delta?.text).toBe("+25,0%");
    expect(rest.ticket.delta?.text).toBe("+25,0%");
  });

  it("reads a day of the sparkline, the three cards together", () => {
    const kpis = resultKpis({
      cards: CARDS,
      daily: days("2026-10-01", 31),
      period: OCTOBER,
      previous,
      previousSales: previous,
      today: "2026-10-25",
    });
    const day = kpis.read(9);
    expect(day.sales).toMatchObject({
      count: "10 vendas",
      date: "1 a 10/10",
      value: "500.00",
    });
    expect(day.result.value).toBe("400.00");
    expect(day.ticket.value).toBe("50.00");
  });

  it("with a day of unknown cost: the server's card, the count of days, and no sparkline nor chip of the result (AC-9)", () => {
    const kpis = resultKpis({
      cards: CARDS,
      daily: days("2026-10-01", 31, (index) =>
        [2, 11, 20].includes(index)
          ? { costs: null, operatingResult: null }
          : {}
      ),
      period: OCTOBER,
      previous,
      previousSales: previous,
      today: "2026-10-25",
    });
    expect(kpis.result).toEqual({ kind: "incomplete", total: 25, unknown: 3 });
    expect(kpis.series.result).toBeNull();
    const rest = kpis.read(null);
    expect(rest.result).toMatchObject({
      date: "outubro inteiro",
      delta: null,
      note: null,
      value: "1000.00",
    });
    // a day read: never the sum of the known days
    expect(kpis.read(20).result.value).toBeNull();
    // the other cards keep their chips
    expect(rest.sales.delta).not.toBeNull();
  });

  it("at rest is the server's card of the whole period, with no chip, when an expense is dated after today", () => {
    const kpis = resultKpis({
      cards: { ...CARDS, operatingResult: "700.00" },
      daily: days("2026-10-01", 31, (index) =>
        index === 30
          ? {
              costs: "300.00",
              netSales: "0.00",
              operatingResult: "-300.00",
              salesCount: 0,
            }
          : {}
      ),
      period: OCTOBER,
      previous,
      previousSales: previous,
      today: "2026-10-25",
    });
    expect(kpis.read(null).result).toMatchObject({
      date: "outubro inteiro",
      delta: null,
      value: "700.00",
    });
    // a day read is the sum up to it, with its chip
    expect(kpis.read(24).result).toMatchObject({
      date: "1 a 25/10",
      delta: { text: "+R$ 250,00" },
      value: "1000.00",
    });
  });

  it("has no chip without the period before, and no chip of the result when the period before had an unknown day", () => {
    const alone = resultKpis({
      cards: CARDS,
      daily: days("2026-10-01", 31),
      period: OCTOBER,
      previous: null,
      previousSales: null,
      today: "2026-10-25",
    }).read(null);
    expect([alone.sales.delta, alone.result.delta, alone.ticket.delta]).toEqual(
      [null, null, null]
    );
    expect(alone.sales.help).toBe("Vendas líquidas de 1 a 25/10.");
    const unknownBefore = resultKpis({
      cards: CARDS,
      daily: days("2026-10-01", 31),
      period: OCTOBER,
      previous: {
        days: days("2026-09-01", 30, (index) =>
          index === 4 ? { operatingResult: null } : {}
        ),
        period: SEPTEMBER,
      },
      previousSales: previous,
      today: "2026-10-25",
    }).read(null);
    expect(unknownBefore.result.delta).toBeNull();
    expect(unknownBefore.sales.delta).not.toBeNull();
  });

  it("says the period before had no sale instead of a percent over nothing", () => {
    const rest = resultKpis({
      cards: CARDS,
      daily: days("2026-10-01", 31),
      period: OCTOBER,
      previous: null,
      previousSales: {
        days: days("2026-09-01", 30, () => ({
          netSales: "0.00",
          salesCount: 0,
        })),
        period: SEPTEMBER,
      },
      today: "2026-10-25",
    }).read(null);
    expect(rest.sales.delta).toBeNull();
    expect(rest.sales.help).toBe(
      "Vendas líquidas de 1 a 25/10. Sem vendas de 1 a 25/09, não há comparação."
    );
  });

  it("compares the last 30 days with the 30 before them, and calls it a period", () => {
    const period = { from: "2026-09-26", to: "2026-10-25" };
    const before = comparisonPeriod(period, "2026-10-25");
    const kpis = resultKpis({
      cards: CARDS,
      daily: days("2026-09-26", 30),
      period,
      previous: before ? { days: days(before.from, 30), period: before } : null,
      previousSales: before
        ? { days: days(before.from, 30), period: before }
        : null,
      today: "2026-10-25",
    });
    expect(kpis.month).toBeNull();
    const rest = kpis.read(null);
    expect(rest.sales.count).toBe("25 vendas");
    expect(rest.sales.date).toBe("26/09 a 25/10");
    expect(rest.sales.delta?.basis).toBe("em relação a 27/08 a 25/09");
    expect(rest.sales.delta?.text).toBe("0,0%");
  });

  it("names the whole period, never a range backwards, for a period that has not started", () => {
    const kpis = resultKpis({
      cards: { ...CARDS, netSales: "0.00", salesCount: 0, ticket: null },
      daily: days("2026-11-01", 30, () => ({
        netSales: "0.00",
        salesCount: 0,
      })),
      period: { from: "2026-11-01", to: "2026-11-30" },
      previous: null,
      previousSales: null,
      today: "2026-10-25",
    });
    expect(kpis.days).toEqual([]);
    const rest = kpis.read(null);
    expect(rest.sales.date).toBe("novembro inteiro");
    expect(rest.ticket.date).toBe("novembro inteiro");
  });

  it("reads the last day when the index read is beyond the series (the period changed under the pointer)", () => {
    const kpis = resultKpis({
      cards: CARDS,
      daily: days("2026-10-01", 31),
      period: OCTOBER,
      previous,
      previousSales: previous,
      today: "2026-10-05",
    });
    expect(kpis.read(20).sales).toMatchObject({
      date: "1 a 05/10",
      value: "250.00",
    });
  });

  it("has no result series for a copy that never sent the results of the days", () => {
    const kpis = resultKpis({
      cards: CARDS,
      daily: days("2026-10-01", 31).map(({ date, netSales, salesCount }) => ({
        date,
        netSales,
        salesCount,
      })),
      period: OCTOBER,
      previous,
      previousSales: previous,
      today: "2026-10-25",
    });
    expect(kpis.result.kind).toBe("unsent");
    expect(kpis.series.result).toBeNull();
    expect(kpis.read(null).result.value).toBe("1000.00");
  });
});

describe("the period before that the result's chip asks the engine for", () => {
  const TODAY = "2026-10-25";
  const lines = { itemLines: 25, itemLinesWithUnknownCost: 3 };
  const summary = (
    daily: StoredDay[],
    quality = lines
  ): Parameters<typeof resultChipPeriod>[0] => ({
    daily,
    period: OCTOBER,
    quality: {
      anticipationFeesUnknown: 0,
      level: "complete",
      linkedExpenses: 0,
      missing: [],
      operatingExpenses: 0,
      processingFeesUnknown: 0,
      salesCount: 25,
      ...quality,
    },
  });

  it("is the period before when the result is known and some cost is known", () => {
    expect(resultChipPeriod(summary(days("2026-10-01", 25)), TODAY)).toEqual(
      SEPTEMBER
    );
  });

  it("is null when some day up to today has no known result (incomplete)", () => {
    const partial = days("2026-10-01", 25, (index) =>
      index === 3 ? { costs: null, operatingResult: null } : {}
    );
    expect(resultChipPeriod(summary(partial), TODAY)).toBeNull();
  });

  it("is null when every day has a null result (incomplete, and no cost known)", () => {
    const unknown = days("2026-10-01", 25, () => ({ operatingResult: null }));
    expect(resultChipPeriod(summary(unknown), TODAY)).toBeNull();
  });

  it("is null when every item line sold has an unknown cost, even with a result on every day", () => {
    expect(
      resultChipPeriod(
        summary(days("2026-10-01", 25), {
          itemLines: 25,
          itemLinesWithUnknownCost: 25,
        }),
        TODAY
      )
    ).toBeNull();
  });

  it('reads the coverage from the counts, never from the field: "none" with 3 of 25 lines unknown keeps the chip', () => {
    const base = summary(days("2026-10-01", 25));
    expect(
      resultChipPeriod(
        { ...base, quality: { ...base.quality, cogsCoverage: "none" } },
        TODAY
      )
    ).toEqual(SEPTEMBER);
    const none = summary(days("2026-10-01", 25), {
      itemLines: 25,
      itemLinesWithUnknownCost: 25,
    });
    expect(
      resultChipPeriod(
        { ...none, quality: { ...none.quality, cogsCoverage: "full" } },
        TODAY
      )
    ).toBeNull();
  });

  it("ignores a day with no known result after today", () => {
    const later = days("2026-10-01", 31, (index) =>
      index === 27 ? { operatingResult: null } : {}
    );
    expect(resultChipPeriod(summary(later), TODAY)).toEqual(SEPTEMBER);
  });

  it("is null for a copy with no daily series at all", () => {
    const { period, quality } = summary([]);
    expect(resultChipPeriod({ period, quality }, TODAY)).toBeNull();
  });

  it("is null for a copy that never sent the results of the days", () => {
    const unsent = days("2026-10-01", 25).map(
      ({ date, netSales, salesCount }) => ({ date, netSales, salesCount })
    );
    expect(resultChipPeriod(summary(unsent as StoredDay[]), TODAY)).toBeNull();
  });
});
