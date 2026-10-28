import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { StoredPeriodSummary } from "../lib/period-summary-cache";
import { ResultChain } from "./result-chain";
import { addDays } from "./result-period";

/**
 * The chain "Como chegamos a este resultado" with no cost of the goods known (`cogsCoverageOf`
 * "none", from the item lines): the subtotals from the CMV on show a dash and "Sem custo conhecido no período.",
 * as the cards do; the CMV itself is a dash with "Nenhum dos N itens vendidos tem custo conhecido." and the
 * bar of the parts is not drawn; the lines of entry keep their values. A partial cost, and every day null with some cost of the
 * goods known or only a fee unknown (cases a/b), stay as they were.
 */

function summary(
  unknown: readonly number[],
  lines = { itemLines: 25, itemLinesWithUnknownCost: unknown.length }
): StoredPeriodSummary {
  return {
    cards: {} as StoredPeriodSummary["cards"],
    chain: {
      anticipationFees: "0.00",
      cogs: "0.00",
      commercialSurcharges: "0.00",
      contributionMargin: "1250.00",
      discounts: "50.00",
      estimatedOperatingResult: "1250.00",
      grossProfit: "1250.00",
      grossSales: "1350.00",
      linkedExpenses: "0.00",
      netSales: "1250.00",
      operatingExpenses: "0.00",
      processingFees: "0.00",
      returns: "50.00",
    },
    daily: Array.from({ length: 31 }, (_, index) => ({
      costs: unknown.includes(index + 1) ? null : "10.00",
      date: addDays("2026-10-01", index),
      netSales: "50.00",
      operatingExpenses: "0.00",
      operatingResult: unknown.includes(index + 1) ? null : "40.00",
      salesCount: 1,
    })),
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

const chain = (value: StoredPeriodSummary) =>
  renderToStaticMarkup(<ResultChain summary={value} />);

/** The markup of the row of a line, from its name to the end of its row. */
function row(markup: string, label: string): string {
  const start = markup.indexOf(label);
  expect(start).toBeGreaterThan(-1);
  return markup.slice(start, markup.indexOf("</tr>", start));
}

/** The words of a piece of markup, read tag by tag. */
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
  value: StoredPeriodSummary,
  cogsCoverage: unknown
): StoredPeriodSummary {
  return { ...value, quality: { ...value.quality, cogsCoverage } };
}

const SUBTOTALS = [
  "(=) Lucro bruto",
  "(=) Margem de contribuição",
  "(=) Resultado operacional estimado",
];

describe("the chain with no cost known", () => {
  for (const [name, value] of [
    [
      "every item line sold has an unknown cost (a copy kept before cogsCoverage)",
      summary(ALL),
    ],
    [
      "every item line sold has an unknown cost, every day with a result",
      summary([], { itemLines: 25, itemLinesWithUnknownCost: 25 }),
    ],
    [
      'every item line sold has an unknown cost, whatever the field says ("full")',
      withCoverage(summary(ALL), "full"),
    ],
  ] as const) {
    it(`${name}: the subtotals from the CMV on are a dash with the note, the entries keep their values`, () => {
      const markup = chain(value);
      for (const label of SUBTOTALS) {
        const text = words(row(markup, label));
        expect(text).toContain("—");
        expect(text).toContain("Sem custo conhecido no período.");
        expect(text).not.toContain("R$");
      }
      expect(words(row(markup, "Vendas brutas"))).toContain("R$ 1.350,00");
      expect(words(row(markup, "(−) Descontos"))).toContain("R$ 50,00");
      expect(words(row(markup, "(−) Devoluções"))).toContain("R$ 50,00");
      expect(words(row(markup, "(=) Vendas líquidas"))).toContain(
        "R$ 1.250,00"
      );
      expect(words(row(markup, "Vendas brutas"))).not.toContain("Sem custo");
      const cogs = words(row(markup, "(−) Custo das mercadorias"));
      expect(cogs).toContain("—");
      expect(cogs).toContain("sem valor");
      expect(cogs).toContain(
        "Nenhum dos 25 itens vendidos tem custo conhecido."
      );
      expect(cogs).not.toContain("R$");
      expect(markup).not.toContain("data-parts-bar");
      expect(words(markup)).toContain(
        "Sem o custo das mercadorias, a divisão dos custos não aparece."
      );
    });
  }

  for (const [name, lines] of [
    ["(a) only a fee unknown, every cost of the goods known", 0],
    ["(b) some cost of the goods known", 3],
  ] as const) {
    it(`every day null, ${name}: every subtotal with its amount, as any partial`, () => {
      const markup = chain(
        withCoverage(
          summary(ALL, { itemLines: 25, itemLinesWithUnknownCost: lines }),
          "none"
        )
      );
      for (const label of SUBTOTALS) {
        const text = words(row(markup, label));
        expect(text).toContain("R$ 1.250,00");
        expect(text).not.toContain("Sem custo conhecido");
      }
      expect(words(row(markup, "(−) Custo das mercadorias"))).toContain(
        "R$ 0,00"
      );
      expect(markup).toContain("data-parts-bar");
    });
  }

  it("3 of 25 days unknown stays as it was: every subtotal with its amount and no such note", () => {
    const markup = chain(summary([5, 12, 22]));
    for (const label of SUBTOTALS) {
      const text = words(row(markup, label));
      expect(text).toContain("R$ 1.250,00");
      expect(text).not.toContain("Sem custo conhecido");
    }
    expect(words(row(markup, "(−) Custo das mercadorias"))).toContain(
      "Não inclui 3 itens sem custo conhecido."
    );
    expect(markup).toContain("data-parts-bar");
    expect(words(markup)).not.toContain("a divisão dos custos não aparece");
  });
});
