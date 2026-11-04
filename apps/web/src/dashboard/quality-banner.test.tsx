import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PeriodQuality } from "./dashboard-model";
import { QualityBanner } from "./quality-banner";

const partial: PeriodQuality = {
  anticipationFeesUnknown: 0,
  itemLines: 300,
  itemLinesWithUnknownCost: 262,
  level: "partial",
  linkedExpenses: 0,
  missing: ["unknown_cost", "unknown_processing_fee"],
  operatingExpenses: 3,
  processingFeesUnknown: 1272,
  salesCount: 1300,
};

describe("QualityBanner", () => {
  it("a partial estimate is one line with the counts and the way to the list, never hidden", () => {
    const html = renderToStaticMarkup(<QualityBanner quality={partial} />);
    expect(html).toContain('aria-label="Qualidade dos dados"');
    expect(html).toContain(
      "Estimativa incompleta: 262 itens sem custo e 1.272 vendas sem taxa."
    );
    expect(html).toContain("Ver o que falta");
    expect(html).not.toContain("<h");
  });

  it("keeps the reasons and the rule of the unknown in the page, behind the button", () => {
    const html = renderToStaticMarkup(<QualityBanner quality={partial} />);
    expect(html).toContain(
      "262 linhas de itens vendidos sem custo conhecido: o custo delas não entrou no CMV."
    );
    expect(html).toContain("1272 vendas sem taxa de processamento conhecida");
    expect(html).toContain(
      "O que não é conhecido fica de fora das contas, nunca entra como zero."
    );
  });

  it("complete data stay a quiet line with no button", () => {
    const html = renderToStaticMarkup(
      <QualityBanner quality={{ ...partial, level: "complete", missing: [] }} />
    );
    expect(html).toContain("Dados completos para este período");
    expect(html).not.toContain("Ver o que falta");
  });
});
