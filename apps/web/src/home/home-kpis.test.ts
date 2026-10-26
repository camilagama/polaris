import { describe, expect, it } from "vitest";
import {
  dayReading,
  moneyDelta,
  monthKpis,
  percentDelta,
  todaySeries,
  unknownDaysText,
} from "./home-kpis";

interface Day {
  date: string;
  netSales: string;
  operatingResult?: string | null;
  salesCount: number;
}

type Pick = (date: string) => Partial<Omit<Day, "date">> | undefined;

/** Every day from `from` to `to`; `pick` overrides the default (no sale, no result field). */
function days(from: string, to: string, pick: Pick = () => undefined): Day[] {
  const result: Day[] = [];
  for (
    let moment = Date.parse(`${from}T00:00:00Z`);
    moment <= Date.parse(`${to}T00:00:00Z`);
    moment += 86_400_000
  ) {
    const date = new Date(moment).toISOString().slice(0, 10);
    result.push({ date, netSales: "0.00", salesCount: 0, ...pick(date) });
  }
  return result;
}

const TODAY = "2026-10-25";
const cards = {
  netSales: "500.00",
  operatingResult: "125.00",
  salesCount: 25,
  ticket: "20.00",
};

/** September: 10.00 and one sale a day (and the given result, when there is one). */
const september = (extra: Pick = () => undefined, result?: string | null) =>
  days("2026-09-01", "2026-09-30", (date) => ({
    netSales: "10.00",
    salesCount: 1,
    ...(result === undefined ? {} : { operatingResult: result }),
    ...extra(date),
  }));

/** October up to the 31st: 20.00 and one sale a day. */
const october = (extra: Pick = () => undefined, result?: string | null) =>
  days("2026-10-01", "2026-10-31", (date) => ({
    netSales: "20.00",
    salesCount: 1,
    ...(result === undefined ? {} : { operatingResult: result }),
    ...extra(date),
  }));

describe("percentDelta", () => {
  it("writes the signed percent with one place and a comma", () => {
    expect(percentDelta(15_290n, 10_000n)).toEqual({
      money: false,
      text: "+52,9%",
      trend: "up",
    });
    expect(percentDelta(8800n, 10_000n)).toEqual({
      money: false,
      text: "-12,0%",
      trend: "down",
    });
  });

  it("rounds half-up, ties away from zero", () => {
    // 1 / 2000 = 0,05% = 0,5 tenth
    expect(percentDelta(2001n, 2000n)?.text).toBe("+0,1%");
    expect(percentDelta(1999n, 2000n)?.text).toBe("-0,1%");
    // 1 / 1600 = 0,0625% = 0,625 tenth
    expect(percentDelta(1601n, 1600n)?.text).toBe("+0,1%");
  });

  it("is flat without a sign when nothing moved or the move rounds to zero", () => {
    expect(percentDelta(500n, 500n)).toEqual({
      money: false,
      text: "0,0%",
      trend: "flat",
    });
    expect(percentDelta(10_001n, 10_000n)?.text).toBe("0,0%");
    expect(percentDelta(10_001n, 10_000n)?.trend).toBe("flat");
  });

  it("separates thousands of percent with a dot", () => {
    expect(percentDelta(13_345n, 1000n)?.text).toBe("+1.234,5%");
  });

  it("says nothing over a base that is not above zero", () => {
    expect(percentDelta(500n, 0n)).toBeNull();
    expect(percentDelta(500n, -100n)).toBeNull();
  });
});

describe("moneyDelta", () => {
  it("writes the difference in reais, marked as money", () => {
    expect(moneyDelta(50_000n, 6314n)).toEqual({
      money: true,
      text: "+R$ 436,86",
      trend: "up",
    });
    expect(moneyDelta(0n, 1200n)).toEqual({
      money: true,
      text: "-R$ 12,00",
      trend: "down",
    });
    expect(moneyDelta(700n, 700n)).toEqual({
      money: true,
      text: "R$ 0,00",
      trend: "flat",
    });
  });
});

describe("dayReading (Vendas hoje)", () => {
  // 2026-10-25 is a Sunday; the four before it: 18/10, 11/10, 04/10 and 27/09
  const sundays: Record<string, [string, number]> = {
    "2026-09-27": ["150.00", 2],
    "2026-10-04": ["187.40", 1],
    "2026-10-11": ["300.00", 3],
    "2026-10-18": ["200.00", 2],
  };
  const build = (overrides: Record<string, [string, number]> = {}) => {
    const all: Record<string, [string, number]> = {
      ...sundays,
      ...overrides,
      "2026-10-25": ["320.10", 4],
    };
    return {
      before: days("2026-09-01", "2026-09-30", (date) => {
        const found = all[date];
        return found ? { netSales: found[0], salesCount: found[1] } : undefined;
      }),
      month: days("2026-10-01", "2026-10-31", (date) => {
        const found = all[date];
        return found ? { netSales: found[0], salesCount: found[1] } : undefined;
      }),
    };
  };

  it("compares the day with the mean of the 4 same weekdays before it", () => {
    const { before, month } = build();
    // mean of 837,40 / 4 = 209,35; (320,10 - 209,35) / 209,35 = +52,9%
    expect(dayReading(before, month, TODAY, TODAY)).toEqual({
      count: "4 vendas hoje",
      date: "domingo, 25/10",
      delta: { money: false, text: "+52,9%", trend: "up" },
      note: "vs. média dos 4 domingos anteriores",
      value: "320.10",
    });
  });

  it("writes the feminine for a weekday that is feminine", () => {
    // 2026-10-23 is a Friday: 16/10, 09/10, 02/10 and 25/09
    const month = days("2026-10-01", "2026-10-31", (date) =>
      ["2026-10-02", "2026-10-09", "2026-10-16", "2026-10-23"].includes(date)
        ? { netSales: "100.00", salesCount: 1 }
        : undefined
    );
    const before = days("2026-09-01", "2026-09-30", (date) =>
      date === "2026-09-25" ? { netSales: "100.00", salesCount: 1 } : undefined
    );
    const reading = dayReading(before, month, "2026-10-23", "2026-10-23");
    expect(reading.date).toBe("sexta-feira, 23/10");
    expect(reading.note).toBe("vs. média das 4 sextas anteriores");
    expect(reading.delta?.text).toBe("0,0%");
  });

  it("says the 4 weekdays had no sale, with no chip", () => {
    const { before, month } = build({
      "2026-09-27": ["0.00", 0],
      "2026-10-04": ["0.00", 0],
      "2026-10-11": ["0.00", 0],
      "2026-10-18": ["0.00", 0],
    });
    const reading = dayReading(before, month, TODAY, TODAY);
    expect(reading.delta).toBeNull();
    expect(reading.note).toBe("Os 4 domingos anteriores não tiveram venda");

    const friday = dayReading(
      days("2026-09-01", "2026-09-30"),
      days("2026-10-01", "2026-10-31"),
      "2026-10-23",
      "2026-10-23"
    );
    expect(friday.delta).toBeNull();
    expect(friday.note).toBe("As 4 sextas anteriores não tiveram venda");
  });

  it("says nothing when one of the 4 weekdays is not in the series", () => {
    const { before, month } = build();
    const short = before.filter((day) => day.date !== "2026-09-27");
    const reading = dayReading(short, month, TODAY, TODAY);
    expect(reading.delta).toBeNull();
    expect(reading.note).toBeNull();
  });

  it("says there is no sale yet today, and no sale on another day", () => {
    const { before, month } = build();
    const empty = month.map((day) =>
      day.date === TODAY ? { ...day, netSales: "0.00", salesCount: 0 } : day
    );
    expect(dayReading(before, empty, TODAY, TODAY).count).toBe(
      "Nenhuma venda hoje ainda"
    );
    expect(dayReading(before, empty, TODAY, "2026-10-26").count).toBe(
      "Nenhuma venda"
    );
  });
});

describe("todaySeries", () => {
  it("is the 30 days that end today, a missing day being a zero", () => {
    const before = days("2026-09-26", "2026-09-30", () => ({
      netSales: "5.00",
      salesCount: 1,
    }));
    const month = days("2026-10-02", "2026-10-25", () => ({
      netSales: "7.00",
      salesCount: 2,
    }));
    const series = todaySeries(before, month, TODAY);
    expect(series).toHaveLength(30);
    expect(series[0]?.date).toBe("2026-09-26");
    expect(series[29]?.date).toBe(TODAY);
    expect(series[0]?.netSales).toBe("5.00");
    // 2026-10-01 is not in either series
    expect(series[5]).toEqual({
      date: "2026-10-01",
      netSales: "0.00",
      salesCount: 0,
    });
    expect(series[6]?.netSales).toBe("7.00");
  });
});

describe("monthKpis: sales", () => {
  it("reads the cumulative value on a day, against the same days of the previous month", () => {
    const kpis = monthKpis(september(), october(), TODAY, cards);
    const { sales } = kpis.read(16);
    expect(sales).toEqual({
      count: "17 vendas até 17/10",
      date: "1 a 17/10",
      // 17 x 20,00 against 17 x 10,00
      delta: { money: false, text: "+100,0%", trend: "up" },
      note: "vs. 1 a 17/09",
      value: "340.00",
    });
  });

  it("reads the server's cards at rest", () => {
    const kpis = monthKpis(september(), october(), TODAY, cards);
    expect(kpis.read(null).sales).toEqual({
      count: "25 vendas no mês",
      date: "1 a 25/10",
      delta: { money: false, text: "+100,0%", trend: "up" },
      note: "vs. 1 a 25/09",
      value: "500.00",
    });
  });

  it("keeps the days from the 1st to today only", () => {
    const kpis = monthKpis(september(), october(), TODAY, cards);
    expect(kpis.days).toHaveLength(25);
    expect(kpis.days.at(-1)?.date).toBe(TODAY);
  });

  it("says there was no sale to compare when the previous month had none", () => {
    const kpis = monthKpis(
      september(() => ({ netSales: "0.00", salesCount: 0 })),
      october(),
      TODAY,
      cards
    );
    const { sales } = kpis.read(null);
    expect(sales.delta).toBeNull();
    expect(sales.note).toBe("Sem vendas de 1 a 25/09 para comparar");
  });

  it("never compares with less: a short B gives no chip", () => {
    const before = september().filter((day) => day.date <= "2026-09-20");
    const { sales } = monthKpis(before, october(), TODAY, cards).read(null);
    expect(sales.delta).toBeNull();
    expect(sales.note).toBeNull();
    // but a day inside the short B still compares
    expect(monthKpis(before, october(), TODAY, cards).read(9).sales.note).toBe(
      "vs. 1 a 10/09"
    );
  });

  it("compares the 31st with the whole of a 30-day previous month", () => {
    const kpis = monthKpis(september(), october(), "2026-10-31", cards);
    const { sales } = kpis.read(null);
    expect(sales.note).toBe("vs. 1 a 30/09");
    // 31 x 20,00 = 620,00 against 30 x 10,00 = 300,00
    expect(sales.delta?.text).toBe("+106,7%");
    expect(sales.date).toBe("1 a 31/10");
  });

  it("draws the sales as cumulative reais", () => {
    const kpis = monthKpis(september(), october(), TODAY, cards);
    expect(kpis.series.sales).toHaveLength(25);
    expect(kpis.series.sales.slice(0, 3)).toEqual([20, 40, 60]);
    expect(kpis.series.sales.at(-1)).toBe(500);
  });
});

describe("monthKpis: ticket", () => {
  it("divides the cumulative net by the cumulative count, half-up to the cent", () => {
    const first = (net: string) =>
      october((date) =>
        date === "2026-10-01" ? { netSales: net, salesCount: 3 } : undefined
      );
    const flat = (date: string) =>
      date >= "2026-10-02" ? { netSales: "0.00", salesCount: 0 } : undefined;
    const a = monthKpis(
      september(),
      first("100.00").map((day) => ({ ...day, ...flat(day.date) })),
      TODAY,
      cards
    );
    expect(a.read(0).ticket.value).toBe("33.33");
    const b = monthKpis(
      september(),
      first("200.00").map((day) => ({ ...day, ...flat(day.date) })),
      TODAY,
      cards
    );
    expect(b.read(0).ticket.value).toBe("66.67");
  });

  it("compares with the previous ticket in percent", () => {
    const month = october((date) =>
      date === "2026-10-01" ? { netSales: "100.00", salesCount: 3 } : undefined
    );
    const { ticket } = monthKpis(september(), month, TODAY, cards).read(0);
    // 33,33 against 10,00
    expect(ticket).toEqual({
      count: "Média por venda de 01/10",
      date: "01/10",
      delta: { money: false, text: "+233,3%", trend: "up" },
      note: "vs. 01/09",
      value: "33.33",
    });
  });

  it("has no value before the first sale of the month", () => {
    const month = october((date) =>
      date === "2026-10-01" || date === "2026-10-02"
        ? { netSales: "0.00", salesCount: 0 }
        : undefined
    );
    const kpis = monthKpis(september(), month, TODAY, cards);
    const { ticket } = kpis.read(1);
    expect(ticket.value).toBeNull();
    expect(ticket.count).toBe("Sem vendas no período");
    expect(ticket.delta).toBeNull();
    // the drawing starts flat at the first ticket
    expect(kpis.series.ticket.slice(0, 3)).toEqual([20, 20, 20]);
  });

  it("reads the server's ticket at rest", () => {
    const { ticket } = monthKpis(september(), october(), TODAY, cards).read(
      null
    );
    expect(ticket.value).toBe("20.00");
    expect(ticket.count).toBe("Média por venda no mês");
    expect(ticket.note).toBe("vs. 1 a 25/09");
    expect(ticket.delta?.text).toBe("+100,0%");
  });
});

describe("monthKpis: result (AC-9)", () => {
  it("is incomplete, with no sparkline and no chip, when any day has an unknown result", () => {
    const month = october(
      (date) => (date === "2026-10-10" ? { operatingResult: null } : undefined),
      "5.00"
    );
    const kpis = monthKpis(september(undefined, "2.00"), month, TODAY, cards);
    expect(kpis.result).toEqual({ kind: "incomplete", total: 25, unknown: 1 });
    expect(kpis.series.result).toBeNull();
    for (const index of [null, 3, 9, 20]) {
      expect(kpis.read(index).result.delta).toBeNull();
    }
    // no day is read as a sum of known days while the month has an unknown one; at rest, the server's card
    expect(kpis.read(3).result.value).toBeNull();
    expect(kpis.read(9).result.value).toBeNull();
    expect(kpis.read(null).result.value).toBe(cards.operatingResult);
  });

  it("ignores an unknown result after today", () => {
    const month = october(
      (date) => (date === "2026-10-30" ? { operatingResult: null } : undefined),
      "5.00"
    );
    const kpis = monthKpis(september(undefined, "2.00"), month, TODAY, cards);
    expect(kpis.result).toEqual({ kind: "known" });
  });

  it("is unsent when the days lack the field", () => {
    const kpis = monthKpis(september(), october(), TODAY, cards);
    expect(kpis.result).toEqual({ kind: "unsent" });
    expect(kpis.series.result).toBeNull();
    expect(kpis.read(null).result.delta).toBeNull();
  });

  it("gives the money difference of the cumulative results when all are known", () => {
    const kpis = monthKpis(
      september(undefined, "2.00"),
      october(undefined, "5.00"),
      TODAY,
      cards
    );
    expect(kpis.result).toEqual({ kind: "known" });
    // 3 x 5,00 against 3 x 2,00
    expect(kpis.read(2).result).toEqual({
      count: "Não é lucro líquido nem dinheiro já recebido.",
      date: "1 a 03/10",
      delta: { money: true, text: "+R$ 9,00", trend: "up" },
      note: "vs. 1 a 03/09",
      value: "15.00",
    });
    expect(kpis.read(null).result.value).toBe("125.00");
    expect(kpis.read(null).result.delta?.text).toBe("+R$ 75,00");
    expect(kpis.series.result?.slice(0, 3)).toEqual([5, 10, 15]);
  });

  it("at rest, says the sum up to today, not the whole month with the expenses dated after today", () => {
    // the rent of 3.000,00 has its competence on 30/10: the month's card (-2.875,00) has it, today (25/10) does not
    const month = october(
      (date) =>
        date === "2026-10-30" ? { operatingResult: "-3000.00" } : undefined,
      "5.00"
    );
    const kpis = monthKpis(september(undefined, "2.00"), month, TODAY, {
      ...cards,
      operatingResult: "-2875.00",
    });
    const atRest = kpis.read(null).result;
    expect(atRest.value).toBe("125.00");
    expect(atRest.date).toBe("1 a 25/10");
    // the chip is the difference of that same number: 125,00 against 25 x 2,00
    expect(atRest.delta?.text).toBe("+R$ 75,00");
    expect(kpis.read(24).result.value).toBe(atRest.value);
  });

  it("at rest, without the results of the days, says the server's card", () => {
    const kpis = monthKpis(september(), october(), TODAY, {
      ...cards,
      operatingResult: "-2875.00",
    });
    expect(kpis.read(null).result.value).toBe("-2875.00");
  });

  it("gives no chip, but still draws, when the previous month has an unknown day in the range", () => {
    const before = september(
      (date) => (date === "2026-09-03" ? { operatingResult: null } : undefined),
      "2.00"
    );
    const kpis = monthKpis(before, october(undefined, "5.00"), TODAY, cards);
    expect(kpis.series.result).toHaveLength(25);
    // 1 to 02/09 is known, 1 to 03/09 is not
    expect(kpis.read(1).result.delta?.text).toBe("+R$ 6,00");
    expect(kpis.read(2).result.delta).toBeNull();
    expect(kpis.read(2).result.note).toBeNull();
    expect(kpis.read(null).result.delta).toBeNull();
  });
});

describe("unknownDaysText", () => {
  it("says how many days lack a cost", () => {
    expect(unknownDaysText(1, 23)).toBe(
      "1 de 23 dias sem custo informado: o gráfico do resultado volta quando o custo for conhecido."
    );
  });
});
