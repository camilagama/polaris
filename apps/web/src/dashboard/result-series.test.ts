import { Money } from "@polaris/domain/money/money";
import { describe, expect, it } from "vitest";
import type { StoredDay } from "../lib/period-summary-cache";
import type { PeriodChain, PeriodQuality } from "./dashboard-model";
import {
  axisMoney,
  bestRow,
  bestRowText,
  costParts,
  costsKnown,
  costText,
  hasAnyValue,
  hasSurcharges,
  hasUnknownCostDay,
  moneyText,
  NO_COST_TEXT,
  readingNote,
  resultSeries,
  supportText,
} from "./result-series";

/** The days of `from` to `to`, each built by `make(date)`. */
function days(
  from: string,
  to: string,
  make: (date: string, index: number) => Partial<StoredDay> = () => ({})
): StoredDay[] {
  const out: StoredDay[] = [];
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const count =
    Math.round((Date.parse(`${to}T00:00:00.000Z`) - start) / 86_400_000) + 1;
  for (let index = 0; index < count; index += 1) {
    const date = new Date(start + index * 86_400_000)
      .toISOString()
      .slice(0, 10);
    out.push({
      costs: "0.00",
      date,
      netSales: "0.00",
      operatingResult: "0.00",
      salesCount: 0,
      ...make(date, index),
    });
  }
  return out;
}

/** The days as an older server or copy sends them: no cost and no result of the day. */
const withoutCosts = (list: StoredDay[]): StoredDay[] =>
  list.map(({ date, netSales, salesCount }) => ({
    date,
    netSales,
    salesCount,
  }));

const sum = (values: ReadonlyArray<string | null | undefined>) =>
  values
    .reduce(
      (total, value) => total.add(Money.from(value ?? "0.00")),
      Money.fromMinorUnits(0n)
    )
    .toString();

describe("the cost line only exists when every day has its cost (AC-9)", () => {
  it("is drawn when every day carries costs and the result of the day as money", () => {
    expect(costsKnown(days("2026-10-01", "2026-10-07"))).toBe(true);
  });

  it("is not drawn when one day is unknown (null), in either field", () => {
    expect(
      costsKnown(
        days("2026-10-01", "2026-10-07", (date) =>
          date === "2026-10-04" ? { costs: null, operatingResult: null } : {}
        )
      )
    ).toBe(false);
    expect(
      costsKnown(
        days("2026-10-01", "2026-10-07", (date) =>
          date === "2026-10-04" ? { operatingResult: null } : {}
        )
      )
    ).toBe(false);
  });

  it("is not drawn for an older server or copy, with no costs at all (undefined)", () => {
    const old = withoutCosts(days("2026-10-01", "2026-10-07"));
    expect(costsKnown(old)).toBe(false);
    expect(hasUnknownCostDay(old)).toBe(false);
  });

  it("is not drawn when only some days have the field", () => {
    const [first, ...rest] = days("2026-10-01", "2026-10-07");
    const mixed = [...withoutCosts([first as StoredDay]), ...rest];
    expect(costsKnown(mixed)).toBe(false);
  });

  it("tells an unknown day from a field that was never sent", () => {
    expect(
      hasUnknownCostDay(
        days("2026-10-01", "2026-10-03", (date) =>
          date === "2026-10-02" ? { costs: null, operatingResult: null } : {}
        )
      )
    ).toBe(true);
  });

  it("is not drawn with no days at all", () => {
    expect(costsKnown([])).toBe(false);
  });

  it("says 'sem custo' for an unknown day and never 0,00", () => {
    expect(costText(null)).toBe(NO_COST_TEXT);
    expect(costText(undefined)).toBe(NO_COST_TEXT);
    expect(costText("0.00")).toBe("R$ 0,00");
    expect(costText("2050.00")).toBe("R$ 2.050,00");
  });
});

describe("the series ends at today and keeps what comes after (AC-6, AC-10)", () => {
  it("draws only the days up to today, never the days to come as zero", () => {
    const series = resultSeries(days("2026-10-01", "2026-10-31"), "2026-10-23");
    expect(series.rows).toHaveLength(23);
    expect(series.rows.at(-1)?.key).toBe("2026-10-23");
    expect(series.grouped).toBe(false);
  });

  it("keeps a day with no sale and no cost as a zero in the series, never a gap", () => {
    const series = resultSeries(days("2026-10-01", "2026-10-05"), "2026-10-05");
    expect(series.rows.map((row) => row.netSales)).toEqual([
      "0.00",
      "0.00",
      "0.00",
      "0.00",
      "0.00",
    ]);
  });

  it("sums the expenses of the days after today into one line for the table, so that the table adds up", () => {
    const daily = days("2026-10-01", "2026-10-31", (date) => {
      if (date === "2026-10-23") {
        return {
          costs: "100.00",
          netSales: "300.00",
          operatingResult: "200.00",
          salesCount: 2,
        };
      }
      if (date === "2026-10-31") {
        return { costs: "1800.00", operatingResult: "-1800.00" };
      }
      return {};
    });
    const series = resultSeries(daily, "2026-10-23");
    expect(series.afterToday).toBe("1800.00");
    // what the table lists plus what comes after is the whole period's cost
    expect(
      sum([...series.rows.map((row) => row.costs), series.afterToday])
    ).toBe(sum(daily.map((day) => day.costs)));
  });

  it("has no line after today when the period ends today, or when nothing is due after it", () => {
    expect(
      resultSeries(days("2026-10-01", "2026-10-23"), "2026-10-23").afterToday
    ).toBeNull();
    expect(
      resultSeries(days("2026-10-01", "2026-10-31"), "2026-10-23").afterToday
    ).toBeNull();
  });

  it("never adds the known costs when a day is unknown: no line after today either", () => {
    const daily = days("2026-10-01", "2026-10-31", (date) => {
      if (date === "2026-10-05") {
        return { costs: null, operatingResult: null };
      }
      return date === "2026-10-31" ? { costs: "1800.00" } : {};
    });
    const series = resultSeries(daily, "2026-10-23");
    expect(series.costsDrawn).toBe(false);
    expect(series.afterToday).toBeNull();
  });

  it("shows nothing for a period that starts after today", () => {
    expect(
      resultSeries(days("2026-11-01", "2026-11-30"), "2026-10-23").rows
    ).toEqual([]);
  });
});

describe("a day with no sale carries its cost as an expense without a sale (AC-8, AC-11)", () => {
  it("names the expense of a day with no sale and no other part in the cost", () => {
    const series = resultSeries(
      days("2026-10-01", "2026-10-05", (date) =>
        date === "2026-10-05"
          ? { costs: "1800.00", operatingResult: "-1800.00" }
          : {}
      ),
      "2026-10-31"
    );
    const row = series.rows.at(-1);
    expect(row?.expenses).toBe("1800.00");
    expect(readingNote(row)).toBe("inclui R$ 1.800,00 de despesas do período");
  });

  it("does not split the cost of a day that had sales: no third part in the reading", () => {
    const series = resultSeries(
      days("2026-10-01", "2026-10-05", (date) =>
        date === "2026-10-05"
          ? {
              costs: "2050.00",
              netSales: "320.00",
              operatingResult: "-1730.00",
              salesCount: 4,
            }
          : {}
      ),
      "2026-10-31"
    );
    expect(series.rows.at(-1)?.expenses).toBeNull();
    expect(readingNote(series.rows.at(-1))).toBeNull();
    expect(readingNote(undefined)).toBeNull();
  });

  it("has no expense on a day with no sale and no cost", () => {
    const series = resultSeries(days("2026-10-01", "2026-10-02"), "2026-10-31");
    expect(series.rows.every((row) => row.expenses === null)).toBe(true);
  });
});

describe("long periods group by month with Money (AC-7)", () => {
  /** A year, every day selling R$ 10,10 with a cost of R$ 4,05 and a result of R$ 6,05. */
  const year = days("2026-01-01", "2026-12-31", () => ({
    costs: "4.05",
    netSales: "10.10",
    operatingResult: "6.05",
    salesCount: 1,
  }));

  it("groups a period above 62 days into at most 13 months", () => {
    const series = resultSeries(year, "2026-12-31");
    expect(series.grouped).toBe(true);
    expect(series.rows).toHaveLength(12);
    expect(series.rows[0]).toMatchObject({
      key: "2026-01",
      label: "jan",
      tableLabel: "janeiro de 2026",
    });
    expect(series.rows[11]?.label).toBe("dez");
  });

  it("keeps 62 days daily and groups 63", () => {
    expect(
      resultSeries(days("2026-09-01", "2026-11-01"), "2026-11-01").grouped
    ).toBe(false);
    expect(
      resultSeries(days("2026-09-01", "2026-11-02"), "2026-11-02").grouped
    ).toBe(true);
  });

  it("adds up to the total of the days, to the cent, in sales, costs and result", () => {
    const series = resultSeries(year, "2026-12-31");
    expect(sum(series.rows.map((row) => row.netSales))).toBe(
      sum(year.map((day) => day.netSales))
    );
    expect(sum(series.rows.map((row) => row.costs))).toBe(
      sum(year.map((day) => day.costs))
    );
    expect(sum(series.rows.map((row) => row.operatingResult))).toBe(
      sum(year.map((day) => day.operatingResult))
    );
    // January has 31 days: 31 x 10.10, exact where a float would drift
    expect(series.rows[0]?.netSales).toBe("313.10");
    expect(series.rows[0]?.salesCount).toBe(31);
  });

  it("turns the year: a period from December into January has two months, in order", () => {
    const series = resultSeries(days("2025-12-01", "2026-02-15"), "2026-02-15");
    expect(series.rows.map((row) => row.key)).toEqual([
      "2025-12",
      "2026-01",
      "2026-02",
    ]);
    expect(series.rows[0]?.tableLabel).toBe("dezembro de 2025");
    expect(series.rows[2]?.salesCount).toBe(0);
  });

  it("cuts the last month at today and keeps the rest for the line after today", () => {
    const daily = days("2026-01-01", "2026-12-31", (date) =>
      date === "2026-12-31" ? { costs: "500.00" } : { costs: "1.00" }
    );
    const series = resultSeries(daily, "2026-10-15");
    expect(series.rows.at(-1)?.key).toBe("2026-10");
    expect(series.rows.at(-1)?.netSales).toBe("0.00");
    // the days after today cost 16 days of October + 30 + 31 of the end of the year, the last one 500.00
    expect(series.afterToday).toBe(
      sum(
        daily.filter((day) => day.date > "2026-10-15").map((day) => day.costs)
      )
    );
  });

  it("is unknown in a month with one unknown day, and the unknown is not summed", () => {
    const { rows } = resultSeries(
      days("2026-01-01", "2026-03-31", (date) =>
        date === "2026-02-10"
          ? { costs: null, operatingResult: null }
          : { costs: "1.00" }
      ),
      "2026-03-31"
    );
    expect(rows[0]?.costs).toBe("31.00");
    expect(rows[1]?.costs).toBeNull();
    expect(rows[1]?.operatingResult).toBeNull();
    expect(rows[2]?.costs).toBe("31.00");
  });

  it("has no cost in a month made of days that never sent one", () => {
    const { rows } = resultSeries(
      withoutCosts(days("2026-01-01", "2026-03-31")),
      "2026-03-31"
    );
    expect(rows.every((row) => row.costs === undefined)).toBe(true);
  });
});

describe("the best day and the numbers written above the drawing (AC-5)", () => {
  const series = resultSeries(
    days("2026-10-01", "2026-10-05", (date) => {
      if (date === "2026-10-03") {
        return { netSales: "412.50", salesCount: 3 };
      }
      return date === "2026-10-04" ? { netSales: "412.50", salesCount: 2 } : {};
    }),
    "2026-10-31"
  );

  it("is the first day with the highest net sales", () => {
    expect(bestRow(series.rows)?.key).toBe("2026-10-03");
    expect(bestRowText(series)).toBe("Melhor dia: 03/10, R$ 412,50");
  });

  it("is a month for the long periods", () => {
    const long = resultSeries(
      days("2026-01-01", "2026-12-31", (date) =>
        date.startsWith("2026-05") ? { netSales: "10.00" } : {}
      ),
      "2026-12-31"
    );
    expect(bestRowText(long)).toBe("Melhor mês: maio, R$ 310,00");
  });

  it("is none when nothing sold", () => {
    const quiet = resultSeries(days("2026-10-01", "2026-10-05"), "2026-10-31");
    expect(bestRow(quiet.rows)).toBeNull();
    expect(bestRowText(quiet)).toBeNull();
    expect(hasAnyValue(quiet.rows, true)).toBe(false);
  });

  it("counts a day of costs only as a drawing when the cost line is drawn", () => {
    const costly = resultSeries(
      days("2026-10-01", "2026-10-05", (date) =>
        date === "2026-10-02" ? { costs: "50.00" } : {}
      ),
      "2026-10-31"
    );
    expect(hasAnyValue(costly.rows, true)).toBe(true);
    expect(hasAnyValue(costly.rows, false)).toBe(false);
  });
});

const chain: PeriodChain = {
  anticipationFees: "10.00",
  cogs: "1712.40",
  commercialSurcharges: "0.00",
  contributionMargin: "0.00",
  discounts: "0.00",
  estimatedOperatingResult: "223.55",
  grossProfit: "0.00",
  grossSales: "0.00",
  linkedExpenses: "61.55",
  netSales: "3841.10",
  operatingExpenses: "1735.40",
  processingFees: "98.20",
  returns: "0.00",
};

const completeQuality: PeriodQuality = {
  anticipationFeesUnknown: 0,
  itemLines: 4,
  itemLinesWithUnknownCost: 0,
  level: "complete",
  linkedExpenses: 1,
  missing: [],
  operatingExpenses: 2,
  processingFeesUnknown: 0,
  salesCount: 3,
};

describe("the sentence that supports the chart (AC-11)", () => {
  it("says the difference is the result of the day when both lines are drawn and there is no surcharge", () => {
    expect(supportText(true, chain)).toBe(
      "A diferença entre as duas linhas é o resultado estimado do dia. Despesas do período entram no dia da competência."
    );
  });

  it("sends the reader to the table when the period has a surcharge: the equality would not hold", () => {
    const withFreight = { ...chain, commercialSurcharges: "12.00" };
    expect(hasSurcharges(withFreight)).toBe(true);
    expect(supportText(true, withFreight)).toBe(
      "O resultado de cada dia está em Ver os números. Despesas do período entram no dia da competência."
    );
  });

  it("says nothing when the cost line is not drawn", () => {
    expect(supportText(false, chain)).toBeNull();
    expect(
      supportText(false, { ...chain, commercialSurcharges: "5.00" })
    ).toBeNull();
  });

  it("counts a negative surcharge as one too", () => {
    expect(hasSurcharges({ ...chain, commercialSurcharges: "-3.00" })).toBe(
      true
    );
    expect(hasSurcharges(chain)).toBe(false);
  });
});

describe("the parts of the cost (AC-12)", () => {
  it("adds up the cost of goods, the fees and the expenses to the cost of the period", () => {
    const { parts, total } = costParts(chain, completeQuality);
    expect(parts.map((part) => [part.id, part.value])).toEqual([
      ["goods", "1712.40"],
      ["fees", "108.20"],
      ["expenses", "1796.95"],
    ]);
    expect(total).toBe("3617.55");
    expect(sum(parts.map((part) => part.value))).toBe(total);
  });

  it("is the sum of the costs of the days, with and without a commercial surcharge in the period", () => {
    // sales 3841.10, result 223.55 with no surcharge: the costs are what separates them
    const noSurcharge = Money.from("3841.10")
      .subtract(Money.from("223.55"))
      .toString();
    expect(costParts(chain, completeQuality).total).toBe(noSurcharge);
    // with a surcharge of 12.00 the result is 12.00 higher and the cost does not move: surcharges do not reduce it
    const withSurcharge = {
      ...chain,
      commercialSurcharges: "12.00",
      estimatedOperatingResult: "235.55",
    };
    expect(costParts(withSurcharge, completeQuality).total).toBe(
      costParts(chain, completeQuality).total
    );
  });

  it("marks as incomplete the part that has an unknown input, and only that part", () => {
    const goods = costParts(chain, {
      ...completeQuality,
      itemLinesWithUnknownCost: 3,
    });
    expect(goods.parts.map((part) => part.incomplete)).toEqual([
      true,
      false,
      false,
    ]);
    const fees = costParts(chain, {
      ...completeQuality,
      processingFeesUnknown: 1,
    });
    expect(fees.parts.map((part) => part.incomplete)).toEqual([
      false,
      true,
      false,
    ]);
    const anticipation = costParts(chain, {
      ...completeQuality,
      anticipationFeesUnknown: 2,
    });
    expect(anticipation.parts.map((part) => part.incomplete)).toEqual([
      false,
      true,
      false,
    ]);
    expect(
      costParts(chain, completeQuality).parts.every((part) => !part.incomplete)
    ).toBe(true);
  });
});

describe("the text of a value in the drawing", () => {
  it("writes the axis with the unit left to the top line", () => {
    expect(axisMoney(500)).toBe("500");
    expect(axisMoney(1250)).toBe("1.250");
    expect(axisMoney(12_500)).toBe("12,5 mil");
    expect(axisMoney(1_000_000)).toBe("1 mi");
  });

  it("writes a value of the reading as exact BRL", () => {
    expect(moneyText(2050)).toBe("R$ 2.050,00");
    expect(moneyText(0.1 + 0.2)).toBe("R$ 0,30");
  });
});
