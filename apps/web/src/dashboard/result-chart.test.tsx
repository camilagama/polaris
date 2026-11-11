import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { StoredPeriodSummary } from "../lib/period-summary-cache";
import { GapSeries } from "../ui/charts/chart-gaps";
import { knownRuns } from "../ui/charts/chart-data";
import { NumbersTable, periodHelp, ResultChart } from "./result-chart";
import { addDays } from "./result-period";
import { resultSeries, supportParts } from "./result-series";

/**
 * The markup of "Vendas × custos por dia" (AC-9 and AC-11): the five sentences of support, the
 * summary a screen reader gets (`role="img"`) and the invisible table of the numbers, where a
 * day of unknown cost says "sem custo informado", never R$ 0,00. The drawing itself is measured in the browser.
 */

// the plot is measured by the browser and is not in the markup of the server: the gap series is drawn here inside a
// stand-in of the context of the blocks (seven days, 70 px each), the rest of the module is the real one
vi.mock("../ui/bklit/charts/chart-context", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useChart: () => {
    const data = Array.from({ length: 7 }, (_, index) => ({
      date: new Date(2026, 9, index + 1),
      drawn: 10,
      drawnSecondary: index % 2 === 1 ? 5 : undefined,
      label: String(index + 1),
      raw: 10,
      rawSecondary: index % 2 === 1 ? 5 : null,
    }));
    return {
      data,
      innerHeight: 100,
      innerWidth: 420,
      isLoaded: true,
      tooltipData: null,
      xScale: (date: Date) => (date.getDate() - 1) * 70,
    };
  },
  useYScale: () => (value: number) => 100 - value * 5,
}));

const ZONE = "America/Sao_Paulo";
// October 2026 read on the 25th at noon of the store
const READ = "2026-10-25T15:00:00.000Z";

/** October with the days of `unknown` (day numbers) of unknown cost, and `surcharges` in the chain. */
function october(
  unknown: readonly number[],
  surcharges = "0.00"
): StoredPeriodSummary {
  return {
    cards: {
      items: 25,
      marginPercent: "41.20",
      netSales: "1250.00",
      operatingResult: "1000.00",
      salesCount: 25,
      ticket: "50.00",
    },
    chain: {
      anticipationFees: "0.00",
      cogs: "250.00",
      commercialSurcharges: surcharges,
      contributionMargin: "1000.00",
      discounts: "0.00",
      estimatedOperatingResult: "1000.00",
      grossProfit: "1000.00",
      grossSales: "1250.00",
      linkedExpenses: "0.00",
      netSales: "1250.00",
      operatingExpenses: "0.00",
      processingFees: "0.00",
      returns: "0.00",
    },
    daily: Array.from({ length: 31 }, (_, index) => {
      const date = addDays("2026-10-01", index);
      const sold = index < 25;
      const known = !unknown.includes(index + 1);
      const cost = sold ? "10.00" : "0.00";
      const result = sold ? "40.00" : "0.00";
      return {
        costs: known ? cost : null,
        date,
        netSales: sold ? "50.00" : "0.00",
        operatingExpenses: "0.00",
        operatingResult: known ? result : null,
        salesCount: sold ? 1 : 0,
      };
    }),
    generatedAt: READ,
    period: { from: "2026-10-01", to: "2026-10-31" },
    quality: {
      anticipationFeesUnknown: 0,
      itemLines: 25,
      itemLinesWithUnknownCost: unknown.length,
      level: unknown.length > 0 ? "incomplete" : "complete",
      linkedExpenses: 0,
      missing: [],
      operatingExpenses: 0,
      processingFeesUnknown: 0,
      salesCount: 25,
    },
  } as StoredPeriodSummary;
}

const chart = (summary: StoredPeriodSummary) =>
  renderToStaticMarkup(
    <ResultChart source="server" summary={summary} timezone={ZONE} />
  );

/** The text of a piece of markup, read tag by tag. */
function text(markup: string) {
  let out = "";
  let inTag = false;
  for (const char of markup) {
    if (char === "<") {
      inTag = true;
    } else if (char === ">") {
      inTag = false;
    } else if (!inTag) {
      out += char;
    }
  }
  return out.replaceAll("&quot;", '"');
}

const CUTS_TEXT = /max-h-|line-clamp/;
function support(summary: StoredPeriodSummary): string {
  const { count, tail } = supportParts(
    resultSeries(summary.daily ?? [], "2026-10-25"),
    summary.chain
  );
  return [count, tail].filter((part) => part !== null).join(" ");
}
const COSTS_TOTAL = /<dt[^>]*>Custos<\/dt>/;
const THIRD_ROW = /<tr[^>]*>(?:(?!<\/tr>).)*03\/10\/2026.*?<\/tr>/s;
const EQUALITY = "A diferença entre as duas linhas";
const ALL_UNKNOWN = Array.from({ length: 25 }, (_, index) => index + 1);

describe("the sentence of support of the chart, in its five cases (AC-11)", () => {
  it("1. every day known, no surcharge: the equality", () => {
    expect(support(october([]))).toBe(
      "A diferença entre as duas linhas é o resultado estimado do dia. Despesas do período entram no dia da competência."
    );
  });

  it("2. every day known, a surcharge: to the table, no equality", () => {
    const said = support(october([], "12.00"));
    expect(said).toBe(
      "O resultado de cada dia está na tabela do gráfico. Despesas do período entram no dia da competência."
    );
    expect(said).not.toContain(EQUALITY);
  });

  it("3. 3 of 25 days unknown, no surcharge: the count, then the equality on the days without the hatch", () => {
    expect(support(october([3, 12, 21]))).toBe(
      "3 de 25 dias sem custo informado. A diferença entre as duas linhas é o resultado estimado do dia nos dias sem hachura. Despesas do período entram no dia da competência."
    );
  });

  it("4. 3 of 25 days unknown, a surcharge: the count, then the table", () => {
    const said = support(october([3, 12, 21], "12.00"));
    expect(said).toBe(
      "3 de 25 dias sem custo informado. O resultado de cada dia está na tabela do gráfico. Despesas do período entram no dia da competência."
    );
    expect(said).not.toContain(EQUALITY);
  });

  it("5. no day known: the count and the competence, no equality", () => {
    for (const surcharges of ["0.00", "12.00"]) {
      expect(support(october(ALL_UNKNOWN, surcharges))).toBe(
        "25 de 25 dias sem custo informado. Despesas do período entram no dia da competência."
      );
    }
  });
});

describe("the chart with unknown days (AC-9, emenda de 25/10)", () => {
  it("keeps the badge and writes no total of the costs: never a partial sum", () => {
    const markup = chart(october([3, 12, 21]));
    expect(markup).toContain("estimativa incompleta");
    expect(text(markup)).not.toContain("CustosR$");
    expect(markup).not.toMatch(COSTS_TOTAL);
  });

  it("writes the total of the costs when every day is known", () => {
    expect(chart(october([]))).toMatch(COSTS_TOTAL);
  });

  it("no longer says that the cost line is not drawn", () => {
    expect(chart(october([3]))).not.toContain("A linha de custos não aparece");
  });
});

describe("the room the card keeps for its lines (lugar reservado)", () => {
  it("keeps the line of the note and the line of the best day in the box, whatever the state", () => {
    const complete = chart(october([]));
    const incomplete = chart(october([3]));
    const lines = (markup: string) =>
      markup.match(/<p class="[^"]*min-h-\[1\.125rem\][^"]*"[^>]*>/g) ?? [];
    expect(lines(complete)).toHaveLength(lines(incomplete).length);
    expect(lines(complete).length).toBeGreaterThanOrEqual(2);
  });

  it("holds the same row in the box that stands in for the drawing while its chunk loads", () => {
    const markup = chart(october([3]));
    expect(markup).toContain("data-chart-loading");
    const rows =
      markup.match(
        /<div aria-hidden="true" class="[^"]*min-h-\[8\.5rem\][^"]*"/g
      ) ?? [];
    expect(rows).toHaveLength(1);
    expect(markup).not.toContain("min-h-[calc(5*1.125rem)]");
  });

  it("reserves with min-h only: nothing is cut with max-h or a line clamp", () => {
    const markup = chart(october([3]));
    expect(markup).toContain("min-h-[");
    expect(markup).not.toMatch(CUTS_TEXT);
  });
});

describe("the table of the numbers, invisible and tied to the chart (AC-9, AC-18)", () => {
  const table = (unknown: readonly number[]) =>
    renderToStaticMarkup(
      <NumbersTable
        hasCosts
        id="numbers"
        series={resultSeries(october(unknown).daily ?? [], "2026-10-25")}
        visible={false}
      />
    );

  it("says 'sem custo informado' in the cost and in the result of an unknown day, never R$ 0,00", () => {
    const markup = table([3]);
    const row = markup.match(THIRD_ROW)?.[0];
    expect(row).toBeDefined();
    const said = text(row ?? "");
    expect(said.match(/sem custo informado/g)).toHaveLength(2);
    expect(said).not.toContain("R$ 0,00");
    // the other days keep their amounts
    expect(text(markup)).toContain("R$ 10,00");
  });

  it("keeps the header cell of each row", () => {
    expect(table([3])).toContain('scope="row"');
  });
});

describe("the cost line by run of known days (AC-9)", () => {
  // the stand-in has days 2, 4 and 6 known between unknown ones: three runs of one day
  const markup = renderToStaticMarkup(
    <svg aria-hidden="true">
      <GapSeries
        color="var(--chart-result)"
        dash="4 3"
        mainColor="var(--chart-sales)"
        runs={knownRuns(
          Array.from({ length: 7 }, (_, index) => ({
            label: String(index + 1),
            value: index % 2 === 1 ? 5 : null,
          }))
        )}
      />
    </svg>
  );

  it("draws a known day alone between two unknown ones as a point, never as a line", () => {
    expect(markup.match(/data-chart-lone-day="/g)).toHaveLength(3);
    expect(markup).toContain('data-chart-lone-day="1"');
    expect(markup).toContain('data-chart-lone-day="3"');
    expect(markup).toContain('data-chart-lone-day="5"');
    // a run of one day has no path: `data-chart-run` is only of a run of two days or more
    expect(markup).not.toContain("data-chart-run");
  });

  it("hatches the four unknown days and nothing else", () => {
    expect(markup.match(/data-chart-unknown-day="/g)).toHaveLength(4);
  });

  it("keeps the line of a run of two days or more beside the point of the day alone", () => {
    const mixed = renderToStaticMarkup(
      <svg aria-hidden="true">
        <GapSeries
          color="var(--chart-result)"
          dash="4 3"
          mainColor="var(--chart-sales)"
          runs={[
            { end: 1, start: 1 },
            { end: 5, start: 3 },
          ]}
        />
      </svg>
    );
    expect(mixed).toContain('data-chart-lone-day="1"');
    expect(mixed).toContain('data-chart-run="3-5"');
    expect(mixed.match(/data-chart-run="/g)).toHaveLength(1);
  });
});

describe("the unit of the texts follows the grouping (day for a month, month for a year)", () => {
  /** January to October read on the 25th, as the server sends it above 62 days: one bucket per month, the last one cut at today. */
  const year = (): StoredPeriodSummary => {
    const base = october([]);
    const lastDays = [31, 28, 31, 30, 31, 30, 31, 31, 30, 25];
    const daily = lastDays.map((days, index) => {
      const date = `2026-${String(index + 1).padStart(2, "0")}-01`;
      return {
        costs: `${days * 10}.00`,
        date,
        days,
        netSales: `${days * 50}.00`,
        operatingExpenses: "0.00",
        operatingResult: `${days * 40}.00`,
        salesCount: days,
        to: addDays(date, days - 1),
        unknownDays: 0,
      };
    });
    return {
      ...base,
      daily,
      granularity: "month",
      period: { from: "2026-01-01", to: "2026-10-25" },
    } as StoredPeriodSummary;
  };
  it("says month in the title, the sentence and the result column when the rows are months", () => {
    const markup = chart(year());
    const said = text(markup);
    expect(said).toContain("Vendas × custos por mês");
    expect(said).not.toContain("Vendas × custos por dia");
    expect(
      supportParts(
        resultSeries(year().daily ?? [], "2026-10-25", {
          granularity: "month",
        }),
        year().chain
      ).tail
    ).toContain("é o resultado estimado do mês");

    const table = text(
      renderToStaticMarkup(
        <NumbersTable
          hasCosts
          id="numbers"
          series={resultSeries(year().daily ?? [], "2026-10-25", {
            granularity: "month",
          })}
          visible={false}
        />
      )
    );
    expect(table).toContain("Resultado do mês");
    expect(table).not.toContain("Resultado do dia");
  });

  it("keeps day for a single month", () => {
    const markup = chart(october([]));
    const said = text(markup);
    expect(said).toContain("Vendas × custos por dia");
    expect(support(october([]))).toContain("é o resultado estimado do dia");

    const table = text(
      renderToStaticMarkup(
        <NumbersTable
          hasCosts
          id="numbers"
          series={resultSeries(october([]).daily ?? [], "2026-10-25")}
          visible={false}
        />
      )
    );
    expect(table).toContain("Resultado do dia");
    expect(table).not.toContain("Resultado do mês");
  });
});

describe("the (i) of the title and the caveat said once (AC-7.2 to AC-7.4)", () => {
  const states = [
    ["complete", october([])],
    ["with unknown days", october([3, 12, 21])],
    ["with surcharges", october([], "12.00")],
    ["with no known day", october(ALL_UNKNOWN, "12.00")],
  ] as const;

  for (const [name, summary] of states) {
    it(`${name}: the card says no "lucro líquido" and no "Ver os números", the (i) are the place for it`, () => {
      const said = text(chart(summary));
      expect(said).not.toContain("lucro líquido");
      expect(said).not.toContain("Ver os números");
      expect(said).not.toContain("1 a 31 de outubro");
    });
  }

  it("the seal of the estimate stays beside the title of an incomplete chart", () => {
    expect(text(chart(october([3])))).toContain("estimativa incompleta");
    expect(text(chart(october([])))).not.toContain("estimativa incompleta");
  });

  it("each (i) keeps within 160 characters, whatever the period, the copy and the days without cost", () => {
    const ranges = [
      "1 a 31 de outubro",
      "28 de fevereiro de 2025 a 23 de setembro de 2026",
    ];
    for (const range of ranges) {
      for (const source of ["cache", "server"] as const) {
        for (const unknown of [0, 3, 366]) {
          const summary = october(
            Array.from({ length: unknown }, (_, index) => index + 1),
            "12.00"
          );
          const { tail } = supportParts(
            resultSeries(summary.daily ?? [], "2026-10-25"),
            summary.chain
          );
          const count =
            unknown > 0 ? "366 de 366 dias sem custo informado." : null;
          for (const help of [periodHelp({ count, range, source }), tail]) {
            expect(help?.length ?? 0).toBeLessThanOrEqual(160);
          }
        }
      }
    }
  });

  it("the first (i) carries the dates, the copy and the days without cost, in this order, and no caveat", () => {
    expect(
      periodHelp({
        count: "3 de 31 dias sem custo informado.",
        range: "1 a 31 de outubro",
        source: "cache",
      })
    ).toBe(
      "1 a 31 de outubro · cópia guardada. 3 de 31 dias sem custo informado."
    );
    expect(
      periodHelp({ count: null, range: "1 a 31 de outubro", source: "server" })
    ).toBe("1 a 31 de outubro.");
  });
});

describe("the table when the chart does not open (AC-7.8)", () => {
  const series = resultSeries(
    (october([]).daily ?? []).map((day) =>
      day.date > "2026-10-25" ? { ...day, costs: "10.00" } : day
    ),
    "2026-10-25"
  );
  const render = (visible: boolean) =>
    renderToStaticMarkup(
      <NumbersTable hasCosts id="numbers" series={series} visible={visible} />
    );

  it("is clipped to one pixel when the chart opens and shown when it does not, with the same rows", () => {
    expect(render(false)).toContain('data-chart-data-table="hidden"');
    expect(render(true)).toContain('data-chart-data-table="visible"');
    expect(text(render(false))).toBe(text(render(true)));
  });

  it("closes with what the days after today cost, and never offers a button", () => {
    const said = text(render(false));
    expect(said).toContain("Depois de hoje: despesas R$ 60,00");
    expect(render(false)).not.toContain("<button");
    expect(render(false)).not.toContain("tabindex");
  });
});

describe("the table of five columns on a phone (AC-7.8)", () => {
  const series = resultSeries(october([]).daily ?? [], "2026-10-25");
  const render = (visible: boolean) =>
    renderToStaticMarkup(
      <NumbersTable hasCosts id="numbers" series={series} visible={visible} />
    );

  it("stacks each row as a card with the name of each column beside its value, shown or not", () => {
    for (const visible of [true, false]) {
      const markup = render(visible);
      expect(markup).toContain("@max-3xl:grid");
      expect(markup).toContain('data-label="Custos"');
      expect(markup).toContain('data-label="Despesas do período"');
    }
  });

  it("leaves a table of two columns as it is", () => {
    const markup = renderToStaticMarkup(
      <NumbersTable
        hasCosts={false}
        id="numbers"
        series={series}
        visible={true}
      />
    );
    expect(markup).not.toContain("@max-3xl:grid");
  });
});
