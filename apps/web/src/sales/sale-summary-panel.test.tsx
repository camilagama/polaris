import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FeePreview } from "./sale-form-model";
import { FeePreviewDetails } from "./sale-summary-panel";

const PREVIEW: FeePreview = {
  anticipation: { text: "não solicitada", tone: "not_applicable" },
  processing: { text: "2,5% (R$ 2,50)", tone: "known" },
  profileText: "Maquininha",
  ruleMatched: true,
  ruleText: "Crédito à vista",
  settlementText: "30 dias",
};

const LIVE_REGION = /<div aria-atomic="true" aria-live="polite"[^>]*>/;

describe("FeePreviewDetails (P-4)", () => {
  it("põe os valores da prévia numa região viva e atômica, para o leitor de tela anunciar a troca de perfil", () => {
    const html = renderToStaticMarkup(<FeePreviewDetails preview={PREVIEW} />);
    expect(html).toMatch(LIVE_REGION);
    // the values are inside the region, not beside it
    const region = html.slice(html.search(LIVE_REGION));
    expect(region).toContain("Maquininha");
    expect(region).toContain("Taxa de processamento");
    expect(region).toContain("30 dias");
  });

  it("a região já existe antes de haver prévia, para que o primeiro cálculo também seja anunciado", () => {
    const html = renderToStaticMarkup(<FeePreviewDetails preview={null} />);
    expect(html).toMatch(LIVE_REGION);
    expect(html).toContain("Complete itens, pagamento e perfil");
    expect(html).not.toContain("<dl");
  });
});
