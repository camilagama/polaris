import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FeePreview, SplitEvaluation } from "./sale-form-model";

const state = vi.hoisted(() => ({ hidden: false }));

vi.mock("@/lib/hidden-values", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hidden-values")>()),
  useHiddenValues: () => [state.hidden, () => undefined],
}));

const { FeePreviewDetails, Money, partsSentence } = await import(
  "./sale-summary-panel"
);

const PREVIEW: FeePreview = {
  anticipation: { text: "não solicitada", tone: "not_applicable" },
  feeCents: 250n,
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
    expect(html).not.toContain("<dl");
  });

  it("sem prévia, nem título nem explicação: o Resumo só mostra o que já foi escolhido", () => {
    const html = renderToStaticMarkup(<FeePreviewDetails preview={null} />);
    expect(html).not.toContain("Prévia de taxas e prazo");
    expect(html).not.toContain("O servidor recalcula");
    expect(html).not.toContain("aria-labelledby");
  });
});

describe("the amounts of the Resumo, with Esconder valores", () => {
  beforeEach(() => {
    state.hidden = false;
  });

  it("writes the total as it is while the values show", () => {
    const total = renderToStaticMarkup(<Money text="R$ 229,90" />);
    expect(total).toContain("229,90");
  });

  it("masks the total of the receipt and says 'valor escondido' to a screen reader", () => {
    state.hidden = true;
    const html = renderToStaticMarkup(<Money text="R$ 229,90" />);
    expect(html).not.toContain("229");
    expect(html).toContain("R$ ••••");
    expect(html).toContain("valor escondido");
  });

  it("masks the amount of the fee in the preview and keeps its percent and words", () => {
    state.hidden = true;
    const html = renderToStaticMarkup(<FeePreviewDetails preview={PREVIEW} />);
    expect(html).not.toContain("2,50");
    expect(html).toContain("2,5% (<span");
    expect(html).toContain("R$ ••••");
    expect(html).toContain("valor escondido");
  });

  it("writes the fee of the preview as it is while the values show", () => {
    const html = renderToStaticMarkup(<FeePreviewDetails preview={PREVIEW} />);
    expect(html).toContain("2,5% (<span");
    expect(html).toContain("R$ 2,50");
  });
});

describe("a frase falada das partes", () => {
  const split = (settlementText: string) =>
    ({
      feesTotal: null,
      partPreviews: [{ ...PREVIEW, settlementText }, null],
    }) as unknown as SplitEvaluation;

  it("diz 'prazo' antes do valor conhecido, que na tela vem sem o rótulo", () => {
    expect(
      partsSentence(split("30 dias (estimativa, não é a data de liquidação)"))
    ).toBe(
      "Parte 1: taxa 2,5% (R$ 2,50), prazo 30 dias (estimativa, não é a data de liquidação)."
    );
  });

  it("não repete 'prazo' quando o prazo é desconhecido", () => {
    expect(partsSentence(split("prazo desconhecido — não é zero"))).toBe(
      "Parte 1: taxa 2,5% (R$ 2,50), prazo desconhecido — não é zero."
    );
  });
});
