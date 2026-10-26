import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PeriodChain, PeriodQuality } from "./dashboard-model";
import { PartsBar } from "./parts-bar";

/**
 * "Para onde vão os custos" (AC-12, T399-3): with no cost of the goods known (`cogsCoverageOf` "none") neither the bar
 * nor its track is drawn, the goods read "—" with "sem custo conhecido", the fees and the expenses keep their values and
 * a line says why; a partial and a full cost stay as they were.
 */

const chain: PeriodChain = {
  anticipationFees: "10.00",
  cogs: "0.00",
  commercialSurcharges: "0.00",
  contributionMargin: "0.00",
  discounts: "0.00",
  estimatedOperatingResult: "0.00",
  grossProfit: "0.00",
  grossSales: "0.00",
  linkedExpenses: "61.55",
  netSales: "0.00",
  operatingExpenses: "1735.40",
  processingFees: "98.20",
  returns: "0.00",
};

function quality(itemLinesWithUnknownCost: number): PeriodQuality {
  return {
    anticipationFeesUnknown: 0,
    itemLines: 25,
    itemLinesWithUnknownCost,
    level: itemLinesWithUnknownCost > 0 ? "partial" : "complete",
    linkedExpenses: 1,
    missing: itemLinesWithUnknownCost > 0 ? ["unknown_cost"] : [],
    operatingExpenses: 2,
    processingFeesUnknown: 0,
    salesCount: 25,
  };
}

/** The words of a piece of markup, read tag by tag. */
function words(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const LINE = "Sem o custo das mercadorias, a divisão dos custos não aparece.";

describe("the parts of the cost", () => {
  it("with no cost of the goods known draws no bar, says the goods have no known cost and keeps the other parts", () => {
    const markup = renderToStaticMarkup(
      <PartsBar chain={chain} quality={quality(25)} />
    );
    expect(markup).not.toContain("data-parts-bar");
    expect(markup).not.toContain("bg-muted");
    const text = words(markup);
    expect(text).toContain("Mercadorias—sem valorsem custo conhecido");
    expect(text).not.toContain("incompleto");
    expect(text).toContain("TaxasR$ 108,20");
    expect(text).toContain("DespesasR$ 1.796,95");
    expect(text).toContain(LINE);
  });

  it("with a partial cost of the goods draws the bar and marks the goods incomplete, as before", () => {
    const markup = renderToStaticMarkup(
      <PartsBar chain={{ ...chain, cogs: "1712.40" }} quality={quality(3)} />
    );
    expect(markup).toContain("data-parts-bar");
    const text = words(markup);
    expect(text).toContain("MercadoriasR$ 1.712,40incompleto");
    expect(text).not.toContain("sem custo conhecido");
    expect(text).not.toContain(LINE);
  });

  it("with every cost of the goods known draws the bar with no mark", () => {
    const markup = renderToStaticMarkup(
      <PartsBar chain={{ ...chain, cogs: "1712.40" }} quality={quality(0)} />
    );
    expect(markup).toContain("data-parts-bar");
    expect(words(markup)).not.toContain("incompleto");
    expect(words(markup)).not.toContain(LINE);
  });
});
