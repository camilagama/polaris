import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { StoredPeriodSummary } from "../lib/period-summary-cache";
import { noCostDayText, ResultCards, resultWarning } from "./result-cards";
import { resultKpis } from "./result-kpis";
import { addDays } from "./result-period";

/**
 * The cards of the Resultado when no cost of the goods is known (`cogsCoverageOf` "none", from
 * the item lines): the margin and the result show a dash with the badge and one line each, never the percent or
 * the amount the server makes of costs read as zero. A partial cost (3 of 25 days), and every day null with some cost
 * of the goods known or only a fee unknown (cases a/b), stay as any partial.
 */

const TODAY = "2026-10-25";

/** October to the 25th, the days of `unknown` (day numbers) of unknown cost; the server's cards are as without costs. */
function october(
  unknown: readonly number[],
  lines = { itemLines: 25, itemLinesWithUnknownCost: unknown.length }
): StoredPeriodSummary {
  const noCost = unknown.length === 25;
  return {
    cards: {
      items: 25,
      marginPercent: noCost ? "118.00" : "41.20",
      netSales: "1250.00",
      operatingResult: noCost ? "1250.00" : "1000.00",
      salesCount: 25,
      ticket: "50.00",
    },
    chain: {} as StoredPeriodSummary["chain"],
    daily: Array.from({ length: 31 }, (_, index) => {
      const sold = index < 25;
      const known = !unknown.includes(index + 1);
      const cost = sold ? "10.00" : "0.00";
      const result = sold ? "40.00" : "0.00";
      return {
        costs: known ? cost : null,
        date: addDays("2026-10-01", index),
        netSales: sold ? "50.00" : "0.00",
        operatingExpenses: "0.00",
        operatingResult: known ? result : null,
        salesCount: sold ? 1 : 0,
      };
    }),
    generatedAt: "2026-10-25T15:00:00.000Z",
    period: { from: "2026-10-01", to: "2026-10-31" },
    quality: {
      anticipationFeesUnknown: 0,
      ...lines,
      level: unknown.length > 0 ? "partial" : "complete",
      linkedExpenses: 0,
      missing: [],
      operatingExpenses: 0,
      processingFeesUnknown: 0,
      salesCount: 25,
    },
  } as unknown as StoredPeriodSummary;
}

// September weaker than October on every day, so a chip is due on every card that has one
const SEPTEMBER = {
  days: Array.from({ length: 30 }, (_, index) => ({
    costs: "10.00",
    date: addDays("2026-09-01", index),
    netSales: "40.00",
    operatingResult: "30.00",
    salesCount: 1,
  })),
  period: { from: "2026-09-01", to: "2026-09-30" },
};

// the same month as `dailySales` reads it: sales and counts only
const SEPTEMBER_SALES = {
  days: SEPTEMBER.days.map(({ date, netSales, salesCount }) => ({
    date,
    netSales,
    salesCount,
  })),
  period: SEPTEMBER.period,
};

const cards = (
  summary: StoredPeriodSummary,
  comparison: ComponentProps<typeof ResultCards>["comparison"] = SEPTEMBER,
  salesComparison: ComponentProps<
    typeof ResultCards
  >["salesComparison"] = SEPTEMBER_SALES,
  onOpenSales: ComponentProps<typeof ResultCards>["onOpenSales"] = null
) =>
  renderToStaticMarkup(
    <ResultCards
      comparison={comparison}
      onOpenSales={onOpenSales}
      salesComparison={salesComparison}
      summary={summary}
      today={TODAY}
    />
  );

/** The markup of one card, from its id to the next card. */
function card(markup: string, id: string): string {
  const start = markup.indexOf(`id="${id}"`);
  expect(start).toBeGreaterThan(-1);
  const next = markup.indexOf('id="result-kpi-', start + 1);
  return markup.slice(start, next === -1 ? undefined : next);
}

/** The text of a piece of markup, read tag by tag (not by a regular expression that strips them: it can leave a `<script`). */
function words(markup: string): string {
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
  return out.replace(/\s+/g, " ").trim();
}

/** The figure of a tile: its size follows the width of its own area, never the length of the amount. */
const TILE_FIGURE =
  /data-kpi-value="" style="font-size:max\(0\.875rem, min\(var\(--text-value-lg\), [\d.]+cqw\)\)"/;

const ALL = Array.from({ length: 25 }, (_, index) => index + 1);

/** The same summary with the server's `quality.cogsCoverage`: the screen reads the counts, never this field. */
function withCoverage(
  summary: StoredPeriodSummary,
  cogsCoverage: unknown
): StoredPeriodSummary {
  return { ...summary, quality: { ...summary.quality, cogsCoverage } };
}

describe("the Margem and the Resultado estimado with no cost known", () => {
  for (const [name, summary] of [
    [
      "every item line sold has an unknown cost (a copy kept before cogsCoverage)",
      october(ALL),
    ],
    [
      "every item line sold has an unknown cost, every day with a result",
      october([], { itemLines: 25, itemLinesWithUnknownCost: 25 }),
    ],
    [
      'every item line sold has an unknown cost, whatever the field says ("full")',
      withCoverage(october(ALL), "full"),
    ],
  ] as const) {
    it(`${name}: a dash, the badge and one line, no percent, no amount`, () => {
      const markup = cards(summary);
      const margin = card(markup, "result-kpi-margin");
      expect(words(margin)).toContain("—");
      expect(words(margin)).toContain("estimativa incompleta");
      expect(words(margin)).toContain("Sem custo informado");
      expect(margin).not.toContain("%");
      expect(margin).not.toContain("data-kpi-value");

      const result = card(markup, "result-kpi-result");
      expect(words(result)).toContain("—");
      expect(words(result)).toContain("estimativa incompleta");
      expect(words(result)).toContain(
        "Sem custo informado: não dá para estimar."
      );
      expect(result).not.toContain("R$");
      expect(result).not.toContain("data-kpi-value");
      // no chip, no curve, no keyboard reading of a curve (the sales card, beside it, has all three)
      expect(result).not.toContain("data-kpi-delta=");
      expect(result).not.toContain("data-kpi-spark");
      expect(result).not.toContain('type="range"');
      const sales = card(markup, "result-kpi-sales");
      expect(sales).toContain("data-kpi-delta=");
      expect(sales).toContain("data-kpi-spark");
      expect(sales).toContain('type="range"');
    });
  }

  it("the sales and ticket cards are untouched", () => {
    const markup = cards(october(ALL));
    expect(words(card(markup, "result-kpi-sales"))).toContain("1.250,00");
    expect(card(markup, "result-kpi-ticket")).toContain("50,00");
  });

  it("3 of 25 days unknown stays as it was: the margin, the count, no estimate line", () => {
    const markup = cards(october([5, 12, 22]));
    // the result has neither chip nor curve with a day unknown (AC-9), as before
    expect(card(markup, "result-kpi-result")).not.toContain("data-kpi-spark");
    const margin = card(markup, "result-kpi-margin");
    expect(words(margin)).toContain("41,2");
    expect(words(margin)).not.toContain("Sem custo informado");
    const result = card(markup, "result-kpi-result");
    expect(words(result)).toContain("estimativa incompleta");
    expect(result).toContain('data-kpi-unknown="">3 de 25 dias sem custo<');
    expect(result).toContain('data-kpi-notice=""');
    expect(words(result)).not.toContain("lucro líquido");
    expect(words(margin)).not.toContain("lucro líquido");
    expect(words(margin)).toContain("estimativa incompleta");
    expect(words(result)).toContain("R$");
    expect(words(result)).not.toContain("Sem custo informado");
  });

  for (const [name, lines] of [
    ["(a) only a fee unknown, every cost of the goods known", 0],
    ["(b) some cost of the goods known", 3],
  ] as const) {
    it(`every day null up to today, ${name}: the numbers with the badge, as any partial`, () => {
      const markup = cards(
        withCoverage(
          october(ALL, { itemLines: 25, itemLinesWithUnknownCost: lines }),
          "none"
        )
      );
      const result = card(markup, "result-kpi-result");
      expect(words(result)).toContain("estimativa incompleta");
      expect(words(result)).toContain("25 de 25 dias sem custo");
      expect(words(result)).toContain("R$");
      expect(result).toContain("data-kpi-value");
      expect(words(result)).not.toContain("Sem custo informado");
      expect(result).not.toContain("data-kpi-spark");
      const margin = card(markup, "result-kpi-margin");
      expect(margin).toContain("%");
      expect(words(margin)).not.toContain("Sem custo informado");
    });
  }

  it("every day known: no badge and no dash, with the chip and the curve of the result", () => {
    const markup = cards(october([]));
    expect(markup).not.toContain("estimativa incompleta");
    const result = card(markup, "result-kpi-result");
    expect(words(result)).toContain("1.000,00");
    expect(result).toContain("data-kpi-delta=");
    expect(result).toContain("data-kpi-spark");
    expect(result).toContain('type="range"');
  });

  it("the period of a copy with no series, every line of cost unknown: the dash, from the lines alone", () => {
    const { daily: _series, ...copy } = october([], {
      itemLines: 25,
      itemLinesWithUnknownCost: 25,
    });
    const markup = cards(copy as StoredPeriodSummary);
    expect(words(card(markup, "result-kpi-result"))).toContain(
      "Sem custo informado: não dá para estimar."
    );
    expect(words(card(markup, "result-kpi-margin"))).toContain(
      "Sem custo informado"
    );
  });
});

describe("the chips of the cards and where they come from", () => {
  // October: R$ 50,00 and one sale a day for 25 days; September the same days at R$ 40,00 and one sale (the sales read)
  it("Vendas and Ticket médio compare with the sales read: exact values, in the DOM", () => {
    const markup = cards(october([]), null, SEPTEMBER_SALES);
    // 1250,00 over 1000,00 is +25,0%; the ticket 50,00 over 40,00 too
    const sales = card(markup, "result-kpi-sales");
    expect(sales).toContain("data-kpi-delta=");
    expect(words(sales)).toContain("+25,0%");
    // what it compares with is in sight, short, and in the name of the chip with the exact range
    expect(sales).toContain(
      'aria-label="subiu 25,0 por cento em relação a setembro (1 a 25/09)"'
    );
    expect(words(sales)).toContain("+25,0%vs. setembro");
    const ticket = card(markup, "result-kpi-ticket");
    expect(words(ticket)).toContain("+25,0%vs. setembro");
    // the summary's read is not there: no chip of the result
    expect(card(markup, "result-kpi-result")).not.toContain("data-kpi-delta=");
  });

  it("with the sales read failed, only the chips of Vendas and Ticket médio are gone", () => {
    const markup = cards(october([]), SEPTEMBER, null);
    expect(card(markup, "result-kpi-sales")).not.toContain("data-kpi-delta=");
    expect(card(markup, "result-kpi-ticket")).not.toContain("data-kpi-delta=");
    const result = card(markup, "result-kpi-result");
    expect(result).toContain("data-kpi-delta=");
    // 1000,00 against 25 x 30,00
    expect(words(result)).toContain("+R$ 250,00vs. setembro");
  });

  it("the chip of the Resultado stays as the summary's days give it, whatever the sales read says", () => {
    const withSales = cards(october([]), SEPTEMBER, SEPTEMBER_SALES);
    const without = cards(october([]), SEPTEMBER, null);
    expect(card(withSales, "result-kpi-result")).toBe(
      card(without, "result-kpi-result")
    );
  });
});

describe("the strip of tiles and its (i)", () => {
  it("names each tile by what it is of: the month of a month, the period of any other, and says no date at rest", () => {
    const markup = cards(october([]));
    expect(card(markup, "result-kpi-sales")).toContain(">Vendas em outubro<");
    expect(markup).not.toContain("data-kpi-group");
    expect(markup).not.toContain("data-kpi-date");
    expect(markup).not.toContain("data-kpi-foot");
  });

  it("has an (i) on every card, named by its title, and none of them carries a warning", () => {
    const markup = cards(october([]));
    for (const about of [
      "Resultado estimado",
      "Vendas em outubro",
      "Ticket médio",
      "Margem",
    ]) {
      expect(markup).toContain(`aria-label="Sobre ${about}"`);
    }
    expect(markup.match(/data-slot="help-tip"/g)).toHaveLength(4);
  });

  it("is one column up to 759 px, two up to 1279 px and one strip of four columns from 1280 px", () => {
    const markup = cards(october([]));
    expect(markup).toContain(
      "grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4 xl:gap-0"
    );
    expect(markup).not.toContain("col-span");
    expect(markup.match(/data-kpi-row=/g)).toHaveLength(1);
    expect(markup.match(/xl:bg-transparent/g)).toHaveLength(4);
  });

  it("sizes the three amounts by the width of their own area, as the tiles of the Início do", () => {
    const markup = cards(october([]));
    for (const id of [
      "result-kpi-result",
      "result-kpi-sales",
      "result-kpi-ticket",
    ]) {
      expect(card(markup, id)).toMatch(TILE_FIGURE);
    }
    expect(card(markup, "result-kpi-margin")).not.toContain("cqw");
  });

  it("puts the chip on the support line under the number, with its sign and the name of what it compares with", () => {
    const markup = cards(october([]), null, SEPTEMBER_SALES);
    const sales = card(markup, "result-kpi-sales");
    expect(sales.indexOf("data-kpi-value")).toBeLessThan(
      sales.indexOf("data-kpi-chip-row")
    );
    expect(sales.indexOf("data-kpi-note-row")).toBeLessThan(
      sales.indexOf("data-kpi-chip-row")
    );
    expect(words(sales)).toContain("+25,0%vs. setembro");
    expect(sales).toContain(
      'aria-label="subiu 25,0 por cento em relação a setembro (1 a 25/09)"'
    );
    expect(sales).toContain('data-kpi-delta="up"');
  });

  it("has no chip row for a card with no comparison", () => {
    const markup = cards(october([]), null, null);
    for (const id of ["sales", "ticket", "result"]) {
      expect(card(markup, `result-kpi-${id}`)).not.toContain(
        "data-kpi-chip-row"
      );
    }
  });

  it("has a sparkline only with three points or more", () => {
    const days = october([]).daily ?? [];
    const short = (count: number): StoredPeriodSummary => ({
      ...october([]),
      daily: days.slice(0, count),
    });
    expect(cards(short(3))).toContain("data-kpi-spark");
    for (const count of [2, 1, 0]) {
      const markup = cards(short(count));
      expect(markup).not.toContain("data-kpi-spark");
      expect(markup).not.toContain('type="range"');
    }
  });

  it("gives the margin no sparkline, and the three of value one each", () => {
    const markup = cards(october([]));
    expect(markup.match(/data-kpi-spark/g)).toHaveLength(3);
    expect(card(markup, "result-kpi-margin")).not.toContain("data-kpi-spark");
  });

  it("keeps the sign of a negative result in the text, not only in the color", () => {
    const summary = october([]);
    const negative = {
      ...summary,
      cards: { ...summary.cards, operatingResult: "-99640.35" },
      daily: (summary.daily ?? []).map((day) => ({
        ...day,
        operatingResult: "-4.00",
      })),
    } as StoredPeriodSummary;
    const result = card(cards(negative), "result-kpi-result");
    expect(words(result)).toContain("-R$");
    expect(result).toContain("text-destructive");
  });
});

describe("the days with no cost: on the badge line while they fit, in the (i) when they do not", () => {
  const warning = (props: Parameters<typeof resultWarning>[0]) =>
    renderToStaticMarkup(<div>{resultWarning(props)}</div>);
  const missing = (unknown: number, total: number) =>
    warning({ incomplete: true, missing: { total, unknown }, noCost: false });

  it("fits two digits on each side", () => {
    const fits = missing(5, 23);
    expect(words(fits)).toContain("estimativa incompleta");
    expect(fits).toContain('data-kpi-unknown="">5 de 23 dias sem custo<');
    expect(missing(99, 99)).toContain("99 de 99 dias sem custo");
  });

  it("leaves the badge alone when the count is wider", () => {
    const long = missing(5, 120);
    expect(long).not.toContain("data-kpi-unknown");
    expect(words(long)).toContain("estimativa incompleta");
  });

  it("leaves the days out when no cost is known: the cause is the whole warning", () => {
    const none = warning({
      incomplete: true,
      missing: { total: 25, unknown: 25 },
      noCost: true,
    });
    expect(words(none)).toContain("Sem custo informado: não dá para estimar.");
    expect(none).not.toContain("data-kpi-unknown");
  });

  it("says nothing when the estimate is whole", () => {
    expect(warning({ incomplete: false, missing: null, noCost: false })).toBe(
      "<div></div>"
    );
  });
});

describe("a long period, by month (D1-2, D1-3, D1-6)", () => {
  /** January 15 to today, October 25, as the server sends it above 62 days: one entry per month, the ends cut. */
  function year(): StoredPeriodSummary {
    const months: [string, string][] = [["2026-01-15", "2026-01-31"]];
    for (let month = 2; month <= 10; month += 1) {
      const first = `2026-${String(month).padStart(2, "0")}-01`;
      const last =
        month === 10
          ? TODAY
          : addDays(`2026-${String(month + 1).padStart(2, "0")}-01`, -1);
      months.push([first, last]);
    }
    const base = october([]);
    return {
      ...base,
      daily: months.map(([date, to]) => {
        const days =
          Math.round(
            (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) /
              86_400_000
          ) + 1;
        return {
          costs: `${10 * days}.00`,
          date,
          days,
          netSales: `${50 * days}.00`,
          operatingExpenses: "0.00",
          operatingResult: `${40 * days}.00`,
          salesCount: days,
          to,
          unknownDays: 0,
        };
      }),
      granularity: "month",
      period: { from: "2026-01-15", to: TODAY },
    };
  }

  it("names the curves by month, reads to today at rest, and has no chip nor mark of its own", () => {
    const markup = cards(year(), null, null);
    expect(markup).toContain("Vendas líquidas, acumulado por mês");
    expect(markup).toContain("Resultado estimado, acumulado por mês");
    expect(markup).toContain("Ticket médio, por mês do período");
    expect(markup).not.toContain("acumulado por dia");
    expect(markup).toContain('aria-valuetext="Até 25/10: R$');
    expect(markup).not.toContain("por mês</");
  });

  it("keeps the names by day for a period by date", () => {
    const markup = cards(october([]));
    expect(markup).toContain("acumulado por dia");
    expect(markup).not.toContain("acumulado por mês");
  });
});

describe("the result while a day with no cost is read (RES-1)", () => {
  const kpisOf = (unknown: readonly number[]) => {
    const summary = october(unknown);
    return resultKpis({
      cards: summary.cards,
      daily: summary.daily ?? [],
      period: summary.period,
      previous: null,
      previousSales: null,
      today: TODAY,
    });
  };

  it("is due only on the unknown day itself, read by the pointer", () => {
    const kpis = kpisOf([5, 12]);
    expect(noCostDayText(kpis, 4, false)).toBe("sem custo neste dia");
    expect(noCostDayText(kpis, 11, false)).toBe("sem custo neste dia");
    expect(noCostDayText(kpis, 3, false)).toBeUndefined();
    expect(noCostDayText(kpis, 5, false)).toBeUndefined();
  });

  it("is not due at rest, with no cost of the goods known, or on a month of a long period", () => {
    const kpis = kpisOf([5]);
    expect(noCostDayText(kpis, null, false)).toBeUndefined();
    expect(noCostDayText(kpis, 4, true)).toBeUndefined();
    expect(noCostDayText({ ...kpis, monthly: true }, 4, false)).toBeUndefined();
  });

  it("says in the (i), not on the face, that the figure at rest is of the whole period when a day is unknown", () => {
    const kpis = kpisOf([5]);
    const rest = kpis.read(null).result;
    expect(rest.delta).toBeNull();
    expect(rest.help).toContain("do período inteiro");
    expect(rest.help).toContain("não é lucro líquido nem caixa");
  });

  it("is not due when every day is known", () => {
    expect(noCostDayText(kpisOf([]), 4, false)).toBeUndefined();
  });

  it("leaves the card at rest as it was: the badge, the days and the amount", () => {
    const result = card(cards(october([5])), "result-kpi-result");
    expect(words(result)).not.toContain("sem custo neste dia");
    expect(words(result)).toContain("1 de 25 dias sem custo");
  });
});

const ARROW_AFTER_WORDS = /Ver as 25 vendas<svg[^>]*aria-hidden="true"/;

describe("the link of the sales card to the Histórico", () => {
  const open = () => undefined;
  const sales = (summary: StoredPeriodSummary, onOpen = open) =>
    card(
      cards(summary, SEPTEMBER, SEPTEMBER_SALES, onOpen),
      "result-kpi-sales"
    );

  it("replaces the count with 'Ver as N vendas' and names the dates from the first day to today", () => {
    const markup = sales(october([]));
    expect(markup).toContain('data-kpi-sales-link=""');
    expect(markup).toContain(
      'aria-label="Ver as 25 vendas de 01/10 a 25/10 no Histórico"'
    );
    expect(words(markup)).toContain("Ver as 25 vendas");
  });

  it("says 'Ver a venda' with one sale", () => {
    const summary = october([]);
    summary.cards.salesCount = 1;
    const markup = sales(summary);
    expect(words(markup)).toContain("Ver a venda");
    expect(markup).toContain(
      'aria-label="Ver a venda de 01/10 a 25/10 no Histórico"'
    );
  });

  it("stays the text of the count with no way to open it (no connection, or the device's copy)", () => {
    const markup = card(cards(october([])), "result-kpi-sales");
    expect(markup).not.toContain("data-kpi-sales-link");
    expect(words(markup)).toContain("25 vendas");
  });

  it("has no link for a period that has not started: no day is counted yet", () => {
    const summary = october([]);
    summary.period = { from: "2026-11-01", to: "2026-11-30" };
    expect(sales(summary)).not.toContain("data-kpi-sales-link");
  });

  it("has no link with no sale", () => {
    const summary = october([]);
    summary.cards.salesCount = 0;
    expect(sales(summary)).not.toContain("data-kpi-sales-link");
  });

  it("takes a line of its own under the chip, and stays on the support line without it", () => {
    const withChip = sales(october([]));
    expect(withChip).toContain("data-kpi-chip-row");
    expect(withChip.indexOf("data-kpi-chip-row")).toBeLessThan(
      withChip.indexOf("basis-full")
    );
    expect(withChip.indexOf("basis-full")).toBeLessThan(
      withChip.indexOf("data-kpi-sales-link")
    );
    const without = card(
      renderToStaticMarkup(
        <ResultCards
          comparison={null}
          onOpenSales={open}
          salesComparison={null}
          summary={october([])}
          today={TODAY}
        />
      ),
      "result-kpi-sales"
    );
    expect(without).not.toContain("data-kpi-chip-row");
    expect(without).toContain("data-kpi-sales-link");
    expect(without).not.toContain("basis-full");
  });

  it("keeps the count on the line under the chip when there is no link", () => {
    const summary = october([]);
    summary.cards.salesCount = 0;
    const markup = sales(summary);
    expect(markup).not.toContain("data-kpi-sales-link");
    expect(markup.indexOf("data-kpi-chip-row")).toBeLessThan(
      markup.indexOf("basis-full")
    );
    expect(words(markup)).toContain("Nenhuma venda ainda");
  });

  it("puts the arrow after the words", () => {
    const markup = sales(october([]));
    expect(markup).toMatch(ARROW_AFTER_WORDS);
  });
});
