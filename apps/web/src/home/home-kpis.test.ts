import { describe, expect, it } from "vitest";
import { helpTipTextProblem } from "../ui/help-tip-text";
import {
  dayReading,
  moneyDelta,
  monthKpis,
  percentDelta,
  resultHelp,
  todaySeries,
  unknownDaysFit,
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

/** Every item line sold with a known cost: the cost coverage of the goods is "full". */
const costs = { itemLines: 25, itemLinesWithUnknownCost: 0 };

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

  it("from +1.000% up, says how many times the base, with no place from 100 times up", () => {
    // 10.999 / 1.000 = +999,9%; 11.000 / 1.000 = +1.000,0%, 11 times
    expect(percentDelta(10_999n, 1000n)).toEqual({
      money: false,
      text: "+999,9%",
      trend: "up",
    });
    expect(percentDelta(11_000n, 1000n)).toEqual({
      money: false,
      spoken: "11,0 vezes",
      text: "11,0×",
      trend: "up",
    });
    // the multiple is rounded half-up on its own: 16,005 times is 16,0, 15,651 is 15,7
    expect(percentDelta(160_050n, 10_000n)?.text).toBe("16,0×");
    expect(percentDelta(156_510n, 10_000n)?.text).toBe("15,7×");
    // 99,94 times keeps its place; 99,95 rounds to 100 and drops it
    expect(percentDelta(99_940n, 1000n)?.text).toBe("99,9×");
    expect(percentDelta(99_950n, 1000n)).toEqual({
      money: false,
      spoken: "100 vezes",
      text: "100×",
      trend: "up",
    });
    expect(percentDelta(1_234_400n, 1000n)?.text).toBe("1.234×");
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
  // `2026-10-25` is a Sunday; the four before it: `18/10`, `11/10`, `04/10` and `27/09`
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
      count: "4 vendas",
      // no date at rest: the title says it is today
      date: "",
      delta: { money: false, text: "+52,9%", trend: "up" },
      help: "Vendas líquidas de hoje. Compara com a média dos 4 domingos anteriores.",
      note: "vs. média dos domingos",
      value: "320.10",
    });
    // another day of the strip is dated, and the help says whose it is
    const read = dayReading(before, month, "2026-10-18", TODAY);
    expect(read.date).toBe("dom, 18/10");
    expect(read.help.startsWith("Vendas líquidas de dom, 18/10.")).toBe(true);
  });

  it("writes the feminine for a weekday that is feminine", () => {
    // `2026-10-23` is a Friday: `16/10`, `09/10`, `02/10` and `25/09`
    const month = days("2026-10-01", "2026-10-31", (date) =>
      ["2026-10-02", "2026-10-09", "2026-10-16", "2026-10-23"].includes(date)
        ? { netSales: "100.00", salesCount: 1 }
        : undefined
    );
    const before = days("2026-09-01", "2026-09-30", (date) =>
      date === "2026-09-25" ? { netSales: "100.00", salesCount: 1 } : undefined
    );
    const reading = dayReading(before, month, "2026-10-23", "2026-10-23");
    expect(reading.date).toBe("");
    expect(reading.note).toBe("vs. média das sextas");
    expect(reading.delta?.text).toBe("0,0%");
    expect(reading.help).toBe(
      "Vendas líquidas de hoje. Compara com a média das 4 sextas-feiras anteriores."
    );
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
    expect(reading.note).toBeNull();
    expect(reading.help).toBe(
      "Vendas líquidas de hoje. Sem venda nos 4 domingos anteriores, não há comparação."
    );

    const friday = dayReading(
      days("2026-09-01", "2026-09-30"),
      days("2026-10-01", "2026-10-31"),
      "2026-10-23",
      "2026-10-23"
    );
    expect(friday.delta).toBeNull();
    expect(friday.note).toBeNull();
    expect(friday.help).toBe(
      "Vendas líquidas de hoje. Sem venda nas 4 sextas-feiras anteriores, não há comparação."
    );
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
      "Nenhuma venda ainda"
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
    // `2026-10-01` is not in either series
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
    const kpis = monthKpis(september(), october(), TODAY, cards, costs);
    const { sales } = kpis.read(16);
    expect(sales).toEqual({
      count: "17 vendas",
      date: "1 a 17/10",
      // 17 x 20,00 against 17 x 10,00
      delta: {
        basis: "em relação a 1 a 17/09",
        money: false,
        text: "+100,0%",
        trend: "up",
      },
      help: "Vendas líquidas de 1 a 17/10. Compara com 1 a 17/09.",
      // the comparison is in the (i) and in the name of the chip, not in sight
      note: null,
      value: "340.00",
    });
  });

  it("reads the server's cards at rest", () => {
    const kpis = monthKpis(september(), october(), TODAY, cards, costs);
    expect(kpis.read(null).sales).toEqual({
      count: "25 vendas",
      date: "1 a 25/10",
      delta: {
        basis: "em relação a 1 a 25/09",
        money: false,
        text: "+100,0%",
        trend: "up",
      },
      help: "Vendas líquidas de 1 a 25/10. Compara com 1 a 25/09.",
      note: null,
      value: "500.00",
    });
  });

  it("keeps the days from the 1st to today only", () => {
    const kpis = monthKpis(september(), october(), TODAY, cards, costs);
    expect(kpis.days).toHaveLength(25);
    expect(kpis.days.at(-1)?.date).toBe(TODAY);
  });

  it("says there was no sale to compare when the previous month had none", () => {
    const kpis = monthKpis(
      september(() => ({ netSales: "0.00", salesCount: 0 })),
      october(),
      TODAY,
      cards,
      costs
    );
    const { sales } = kpis.read(null);
    expect(sales.delta).toBeNull();
    expect(sales.help).toBe(
      "Vendas líquidas de 1 a 25/10. Sem vendas de 1 a 25/09, não há comparação."
    );
  });

  it("never compares with less: a short B gives no chip", () => {
    const before = september().filter((day) => day.date <= "2026-09-20");
    const { sales } = monthKpis(before, october(), TODAY, cards, costs).read(
      null
    );
    expect(sales.delta).toBeNull();
    expect(sales.help).toBe("Vendas líquidas de 1 a 25/10.");
    // but a day inside the short B still compares
    expect(
      monthKpis(before, october(), TODAY, cards, costs).read(9).sales.delta
        ?.basis
    ).toBe("em relação a 1 a 10/09");
  });

  it("compares the 31st with the whole of a 30-day previous month", () => {
    const kpis = monthKpis(september(), october(), "2026-10-31", cards, costs);
    const { sales } = kpis.read(null);
    expect(sales.delta?.basis).toBe("em relação a 1 a 30/09");
    // 31 x 20,00 = 620,00 against 30 x 10,00 = 300,00
    expect(sales.delta?.text).toBe("+106,7%");
    expect(sales.date).toBe("1 a 31/10");
  });

  it("draws the sales as cumulative reais", () => {
    const kpis = monthKpis(september(), october(), TODAY, cards, costs);
    expect(kpis.series.sales).toHaveLength(25);
    expect(kpis.series.sales.slice(0, 3)).toEqual([20, 40, 60]);
    expect(kpis.series.sales.at(-1)).toBe(500);
  });
});

describe("monthKpis: sales without any sale", () => {
  const noSales = () => october(() => ({ netSales: "0.00", salesCount: 0 }));

  it("says 'ainda' for the month still open, read at rest", () => {
    const kpis = monthKpis(
      september(),
      noSales(),
      TODAY,
      { ...cards, netSales: "0.00", salesCount: 0 },
      costs
    );
    expect(kpis.read(null).sales.count).toBe("Nenhuma venda ainda");
  });

  it("does not say 'ainda' for a day of the month already gone", () => {
    const kpis = monthKpis(september(), noSales(), TODAY, cards, costs);
    expect(kpis.read(5).sales.count).toBe("Sem vendas no período");
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
      cards,
      costs
    );
    expect(a.read(0).ticket.value).toBe("33.33");
    const b = monthKpis(
      september(),
      first("200.00").map((day) => ({ ...day, ...flat(day.date) })),
      TODAY,
      cards,
      costs
    );
    expect(b.read(0).ticket.value).toBe("66.67");
  });

  it("compares with the previous ticket in percent", () => {
    const month = october((date) =>
      date === "2026-10-01" ? { netSales: "100.00", salesCount: 3 } : undefined
    );
    const { ticket } = monthKpis(september(), month, TODAY, cards, costs).read(
      0
    );
    // 33,33 against 10,00
    expect(ticket).toEqual({
      // nothing under the number: what it is and what it compares with are in the (i)
      count: "",
      date: "01/10",
      delta: {
        basis: "em relação a 01/09",
        money: false,
        text: "+233,3%",
        trend: "up",
      },
      help: "Vendas líquidas divididas pelo número de vendas, de 01/10. Compara com 01/09.",
      note: null,
      value: "33.33",
    });
  });

  it("has no value before the first sale of the month", () => {
    const month = october((date) =>
      date === "2026-10-01" || date === "2026-10-02"
        ? { netSales: "0.00", salesCount: 0 }
        : undefined
    );
    const kpis = monthKpis(september(), month, TODAY, cards, costs);
    const { ticket } = kpis.read(1);
    expect(ticket.value).toBeNull();
    expect(ticket.count).toBe("Sem vendas no período");
    expect(ticket.delta).toBeNull();
    // the drawing starts flat at the first ticket
    expect(kpis.series.ticket.slice(0, 3)).toEqual([20, 20, 20]);
  });

  it("reads the server's ticket at rest", () => {
    const { ticket } = monthKpis(
      september(),
      october(),
      TODAY,
      cards,
      costs
    ).read(null);
    expect(ticket.value).toBe("20.00");
    expect(ticket.count).toBe("");
    expect(ticket.help).toBe(
      "Vendas líquidas divididas pelo número de vendas, de 1 a 25/10. Compara com 1 a 25/09."
    );
    expect(ticket.delta?.basis).toBe("em relação a 1 a 25/09");
    expect(ticket.delta?.text).toBe("+100,0%");
  });
});

describe("monthKpis: result (AC-9)", () => {
  it("with no cost of the goods known is a dash with its sentence, with no sparkline and no chip, as on the Resultado", () => {
    // every item line sold without a cost: every day with a sale has a null result, and the server's card is the sales
    const month = october(() => ({ operatingResult: null }));
    const kpis = monthKpis(
      september(undefined, "2.00"),
      month,
      TODAY,
      {
        ...cards,
        operatingResult: "500.00",
      },
      { itemLines: 25, itemLinesWithUnknownCost: 25 }
    );
    expect(kpis.result).toEqual({ kind: "noCost" });
    expect(kpis.series.result).toBeNull();
    expect(kpis.read(null).result).toEqual({
      count: "Sem custo informado: não dá para estimar.",
      date: "outubro inteiro",
      delta: null,
      help: "Vendas menos custos, taxas e despesas de 1 a 25/10.",
      note: null,
      value: null,
    });
    for (const index of [3, 24]) {
      expect(kpis.read(index).result.value).toBeNull();
      expect(kpis.read(index).result.delta).toBeNull();
    }
    // the other cards keep their values
    expect(kpis.read(null).sales.value).toBe("500.00");
    expect(kpis.series.sales).toHaveLength(25);
  });

  it("with a partial or a full cost of the goods stays as it was", () => {
    const month = october(
      (date) => (date === "2026-10-10" ? { operatingResult: null } : undefined),
      "5.00"
    );
    const partial = monthKpis(
      september(undefined, "2.00"),
      month,
      TODAY,
      cards,
      {
        itemLines: 25,
        itemLinesWithUnknownCost: 3,
      }
    );
    expect(partial.result).toEqual({
      kind: "incomplete",
      total: 25,
      unknown: 1,
    });
    expect(partial.read(null).result.value).toBe(cards.operatingResult);
    const full = monthKpis(
      september(undefined, "2.00"),
      october(undefined, "5.00"),
      TODAY,
      cards,
      costs
    );
    expect(full.result).toEqual({ kind: "known" });
    expect(full.read(null).result.value).toBe("125.00");
  });

  it("with no item sold the cost is not missing: the result is the server's, as before", () => {
    const kpis = monthKpis(
      september(),
      october(undefined, "5.00"),
      TODAY,
      cards,
      {
        itemLines: 0,
        itemLinesWithUnknownCost: 0,
      }
    );
    expect(kpis.result).toEqual({ kind: "known" });
  });

  it("is incomplete, with no sparkline and no chip, when any day has an unknown result", () => {
    const month = october(
      (date) => (date === "2026-10-10" ? { operatingResult: null } : undefined),
      "5.00"
    );
    const kpis = monthKpis(
      september(undefined, "2.00"),
      month,
      TODAY,
      cards,
      costs
    );
    expect(kpis.result).toEqual({ kind: "incomplete", total: 25, unknown: 1 });
    expect(kpis.series.result).toBeNull();
    for (const index of [null, 3, 9, 20]) {
      expect(kpis.read(index).result.delta).toBeNull();
    }
    // no day is read as a sum of known days while the month has an unknown one; at rest, the server's card
    expect(kpis.read(3).result.value).toBeNull();
    expect(kpis.read(9).result.value).toBeNull();
    expect(kpis.read(null).result.value).toBe(cards.operatingResult);
    expect(kpis.read(null).result.date).toBe("outubro inteiro");
    expect(kpis.read(9).result.date).toBe("1 a 10/10");
  });

  it("with an unknown day, says the server's card is the whole month, the expense dated after today in it", () => {
    // the rent of 3.000,00 on `30/10` is in the server's card (-2.875,00), which reads the month to the 31st
    const month = october((date) => {
      if (date === "2026-10-10") {
        return { operatingResult: null };
      }
      return date === "2026-10-30"
        ? { operatingResult: "-3000.00" }
        : undefined;
    }, "5.00");
    const kpis = monthKpis(
      september(undefined, "2.00"),
      month,
      TODAY,
      {
        ...cards,
        operatingResult: "-2875.00",
      },
      costs
    );
    const atRest = kpis.read(null).result;
    expect(atRest.value).toBe("-2875.00");
    expect(atRest.date).toBe("outubro inteiro");
    expect(atRest.delta).toBeNull();
    // the other cards keep the range up to today
    expect(kpis.read(null).sales.date).toBe("1 a 25/10");
  });

  it("ignores an unknown result after today", () => {
    const month = october(
      (date) => (date === "2026-10-30" ? { operatingResult: null } : undefined),
      "5.00"
    );
    const kpis = monthKpis(
      september(undefined, "2.00"),
      month,
      TODAY,
      cards,
      costs
    );
    expect(kpis.result).toEqual({ kind: "known" });
  });

  it("is unsent when the days lack the field", () => {
    const kpis = monthKpis(september(), october(), TODAY, cards, costs);
    expect(kpis.result).toEqual({ kind: "unsent" });
    expect(kpis.series.result).toBeNull();
    expect(kpis.read(null).result.delta).toBeNull();
  });

  it("gives the money difference of the cumulative results when all are known", () => {
    const kpis = monthKpis(
      september(undefined, "2.00"),
      october(undefined, "5.00"),
      TODAY,
      cards,
      costs
    );
    expect(kpis.result).toEqual({ kind: "known" });
    // 3 x 5,00 against 3 x 2,00
    expect(kpis.read(2).result).toEqual({
      count: "Não é lucro líquido nem caixa",
      date: "1 a 03/10",
      delta: {
        basis: "em relação a 1 a 03/09",
        money: true,
        text: "+R$ 9,00",
        trend: "up",
      },
      help: "Vendas menos custos, taxas e despesas de 1 a 03/10. Compara com 1 a 03/09.",
      note: null,
      value: "15.00",
    });
    expect(kpis.read(null).result.value).toBe("125.00");
    expect(kpis.read(null).result.delta?.text).toBe("+R$ 75,00");
    expect(kpis.series.result?.slice(0, 3)).toEqual([5, 10, 15]);
  });

  it("at rest, says the sum up to today, not the whole month with the expenses dated after today", () => {
    // the rent of 3.000,00 has its competence on `30/10`: the month's card (-2.875,00) has it, today (`25/10`) does not
    const month = october(
      (date) =>
        date === "2026-10-30" ? { operatingResult: "-3000.00" } : undefined,
      "5.00"
    );
    const kpis = monthKpis(
      september(undefined, "2.00"),
      month,
      TODAY,
      {
        ...cards,
        operatingResult: "-2875.00",
      },
      costs
    );
    const atRest = kpis.read(null).result;
    expect(atRest.value).toBe("125.00");
    expect(atRest.date).toBe("1 a 25/10");
    // the chip is the difference of that same number: 125,00 against 25 x 2,00
    expect(atRest.delta?.text).toBe("+R$ 75,00");
    expect(kpis.read(24).result.value).toBe(atRest.value);
  });

  it("at rest, without the results of the days, says the server's card", () => {
    const kpis = monthKpis(
      september(),
      october(),
      TODAY,
      {
        ...cards,
        operatingResult: "-2875.00",
      },
      costs
    );
    expect(kpis.read(null).result.value).toBe("-2875.00");
    expect(kpis.read(null).result.date).toBe("outubro inteiro");
  });

  it("without the series (a copy kept before it), says the server's card, never a sum of no day", () => {
    const kpis = monthKpis(
      [],
      [],
      TODAY,
      {
        ...cards,
        operatingResult: "-5.00",
      },
      costs
    );
    expect(kpis.result).toEqual({ kind: "unsent" });
    expect(kpis.read(null).result.value).toBe("-5.00");
    expect(kpis.read(null).result.date).toBe("outubro inteiro");
  });

  it("gives no chip, but still draws, when the previous month has an unknown day in the range", () => {
    const before = september(
      (date) => (date === "2026-09-03" ? { operatingResult: null } : undefined),
      "2.00"
    );
    const kpis = monthKpis(
      before,
      october(undefined, "5.00"),
      TODAY,
      cards,
      costs
    );
    expect(kpis.series.result).toHaveLength(25);
    // 1 to `02/09` is known, 1 to `03/09` is not
    expect(kpis.read(1).result.delta?.text).toBe("+R$ 6,00");
    expect(kpis.read(2).result.delta).toBeNull();
    expect(kpis.read(2).result.help).toBe(
      "Vendas menos custos, taxas e despesas de 1 a 03/10."
    );
    expect(kpis.read(null).result.delta).toBeNull();
  });
});

describe("unknownDaysText", () => {
  it("says how many days lack a cost", () => {
    expect(unknownDaysText(1, 23)).toBe("1 de 23 dias sem custo");
    expect(unknownDaysText(5, 23)).toBe("5 de 23 dias sem custo");
  });
});

describe("the days with no cost, on the line or in the (i)", () => {
  it("stay on the line of the badge while two digits fit on each side, and go to the (i) after", () => {
    expect(unknownDaysFit(5, 23)).toBe(true);
    // the widest a month can be, and the widest the line has room for
    expect(unknownDaysFit(31, 31)).toBe(true);
    expect(unknownDaysFit(99, 99)).toBe(true);
    // a long period of the Resultado
    expect(unknownDaysFit(5, 120)).toBe(false);
    expect(unknownDaysFit(100, 100)).toBe(false);
  });

  it("are said in words by the help when they do not fit, in place of the comparison", () => {
    expect(
      resultHelp("de 1 a 23/10", "1 a 23/09", { total: 23, unknown: 5 })
    ).toBe(
      "Vendas menos custos, taxas e despesas de 1 a 23/10. Compara com 1 a 23/09."
    );
    const long = resultHelp("de 01/06 a 28/10", "1 a 23/09", {
      total: 120,
      unknown: 5,
    });
    expect(long).toBe(
      "Vendas menos custos, taxas e despesas de 01/06 a 28/10. 5 de 120 dias ainda sem custo informado."
    );
    expect(helpTipTextProblem(long)).toBeNull();
  });
});

describe("the texts of the (i) of the cards", () => {
  it("stay within two sentences and 160 characters, in every reading", () => {
    const { before, month } = {
      before: days("2026-09-01", "2026-09-30", () => ({
        netSales: "10.00",
        salesCount: 1,
      })),
      month: days("2026-10-01", "2026-10-31", () => ({
        netSales: "20.00",
        salesCount: 1,
      })),
    };
    const kpis = monthKpis(before, month, TODAY, cards, costs);
    const texts = [
      dayReading(before, month, TODAY, TODAY).help,
      dayReading(before, month, "2026-10-18", TODAY).help,
      ...[null, 0, 9, 24].flatMap((index) => {
        const read = kpis.read(index);
        return [read.sales.help, read.result.help, read.ticket.help];
      }),
    ];
    for (const text of texts) {
      expect(helpTipTextProblem(text), text).toBeNull();
    }
  });
});
