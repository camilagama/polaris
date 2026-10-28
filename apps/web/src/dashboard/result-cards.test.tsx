import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { StoredPeriodSummary } from "../lib/period-summary-cache";
import { ResultCards } from "./result-cards";
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
  >["salesComparison"] = SEPTEMBER_SALES
) =>
  renderToStaticMarkup(
    <ResultCards
      comparison={comparison}
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
      expect(words(margin)).toContain("Sem custo conhecido no período.");
      expect(margin).not.toContain("%");
      expect(margin).not.toContain("data-kpi-value");

      const result = card(markup, "result-kpi-result");
      expect(words(result)).toContain("—");
      expect(words(result)).toContain("estimativa incompleta");
      expect(words(result)).toContain(
        "Sem custo conhecido: o resultado não dá para estimar."
      );
      expect(result).not.toContain("R$");
      expect(result).not.toContain("data-kpi-value");
      // no chip, no curve, no keyboard reading of a curve (the sales card, beside it, has all three)
      expect(result).not.toContain("data-kpi-delta=");
      expect(result).not.toContain("data-kpi-spark");
      expect(result).not.toContain('type="range"');
      expect(result).not.toContain("vs. ");
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
    expect(words(margin)).toContain("Contribuição sobre as vendas líquidas.");
    expect(words(margin)).not.toContain("Sem custo conhecido");
    const result = card(markup, "result-kpi-result");
    expect(words(result)).toContain("estimativa incompleta");
    expect(words(result)).toContain("3 de 25 dias sem custo informado");
    expect(words(result)).toContain("R$");
    expect(words(result)).not.toContain("Sem custo conhecido");
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
      expect(words(result)).toContain("25 de 25 dias sem custo informado");
      expect(words(result)).toContain("R$");
      expect(result).toContain("data-kpi-value");
      expect(words(result)).not.toContain("Sem custo conhecido");
      expect(result).not.toContain("data-kpi-spark");
      const margin = card(markup, "result-kpi-margin");
      expect(margin).toContain("%");
      expect(words(margin)).not.toContain("Sem custo conhecido");
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
      "Sem custo conhecido: o resultado não dá para estimar."
    );
    expect(words(card(markup, "result-kpi-margin"))).toContain(
      "Sem custo conhecido no período."
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
    expect(words(sales)).toContain("vs. 1 a 25/09");
    const ticket = card(markup, "result-kpi-ticket");
    expect(words(ticket)).toContain("+25,0%");
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
    expect(words(result)).toContain("+R$ 250,00");
  });

  it("the chip of the Resultado stays as the summary's days give it, whatever the sales read says", () => {
    const withSales = cards(october([]), SEPTEMBER, SEPTEMBER_SALES);
    const without = cards(october([]), SEPTEMBER, null);
    expect(card(withSales, "result-kpi-result")).toBe(
      card(without, "result-kpi-result")
    );
  });
});
