import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { NearLimitView } from "./limit-help-model";
import { type FreeableLine, NearLimitNotice } from "./limit-help";

vi.mock("../lib/orpc", () => ({ orpcClient: {} }));

const near: NearLimitView = {
  freeableProducts: 0,
  kind: "near",
  proMax: null,
  usage: { max: 50, subject: "variants", used: 47 },
};
const reached: NearLimitView = {
  freeableProducts: 0,
  kind: "reached",
  proMax: null,
  usage: { max: 50, subject: "images", used: 50 },
};
const draw = (
  view: NearLimitView | null,
  hidden = false,
  freeable: FreeableLine = "hidden"
) =>
  renderToStaticMarkup(
    <NearLimitNotice freeable={freeable} hidden={hidden} view={view} />
  );

describe("a linha de aviso do limite perto", () => {
  it("perto: o uso do servidor e 'Conhecer o Pro' no fim da frase, como link para a Assinatura", () => {
    const markup = draw(near);
    expect(markup).toContain("Você usa 47 de 50 variantes no plano Free.");
    expect(markup).toContain('href="/configuracoes?aba=assinatura"');
    expect(markup.indexOf("no plano Free.")).toBeLessThan(
      markup.indexOf("Conhecer o Pro")
    );
    expect(markup.endsWith("Conhecer o Pro</a></p>")).toBe(true);
  });

  it("com o limite do Pro na leitura, 'No Pro: até 2.000 variantes.' vem antes do link; sem ele, a frase não existe", () => {
    const withPro = draw({ ...near, proMax: 2000 });
    expect(withPro).toContain(
      "Você usa 47 de 50 variantes no plano Free. No Pro: até 2.000 variantes. "
    );
    expect(withPro.indexOf("No Pro:")).toBeLessThan(
      withPro.indexOf("Conhecer o Pro")
    );
    expect(draw(near)).not.toContain("No Pro:");
  });

  it("no limite: diz que chegou, sem prometer nada sobre as vendas", () => {
    const markup = draw(reached);
    expect(markup).toContain(
      "Você chegou ao limite de 50 imagens do plano Free."
    );
    expect(markup).not.toContain("vendas");
  });

  it("é texto de apoio: sem alerta, sem ícone e sem fundo", () => {
    const markup = draw(near);
    expect(markup).not.toContain("role=");
    expect(markup).not.toContain("<svg");
    const paragraph = markup.slice(0, markup.indexOf("<a "));
    expect(paragraph).not.toContain("bg-");
    expect(paragraph).not.toContain("border");
  });

  it("sem aviso a mostrar, ou com a recusa na tela, não desenha nada", () => {
    expect(draw(null)).toBe("");
    expect(draw(near, true)).toBe("");
  });
});

describe("a segunda linha: produtos arquivados sem estoque", () => {
  const withFreeable = (count: number): NearLimitView => ({
    ...near,
    freeableProducts: count,
  });

  it("é um parágrafo à parte, depois do aviso, com o link 'Ver arquivados' para Produtos em Arquivados", () => {
    const markup = draw(withFreeable(3), false, "link");
    expect(markup.match(/<p /g)).toHaveLength(2);
    expect(markup).toContain(
      "Você tem 3 produtos arquivados sem estoque. Excluir libera vaga."
    );
    expect(markup).toContain('href="/products?arquivados=1"');
    expect(markup.indexOf("Conhecer o Pro")).toBeLessThan(
      markup.indexOf("Ver arquivados")
    );
    expect(markup).not.toContain("role=");
  });

  it("com 1 o texto vai ao singular, pela contagem e não pelo limite", () => {
    expect(draw(withFreeable(1), false, "link")).toContain(
      "Você tem 1 produto arquivado sem estoque. Excluir libera vaga."
    );
    expect(
      draw(
        { ...withFreeable(1), usage: { max: 1, subject: "variants", used: 1 } },
        false,
        "link"
      )
    ).toContain("Você tem 1 produto arquivado sem estoque.");
    expect(draw(withFreeable(2), false, "link")).toContain(
      "2 produtos arquivados sem estoque"
    );
  });

  it("em Arquivados a linha fica sem o link", () => {
    const markup = draw(withFreeable(3), false, "plain");
    expect(markup).toContain("Você tem 3 produtos arquivados sem estoque.");
    expect(markup).not.toContain("Ver arquivados");
    expect(markup).not.toContain("arquivados=1");
  });

  it("sem arquivados sem estoque, ou onde a tela não pede a linha, o aviso é o mesmo de antes", () => {
    expect(draw(withFreeable(0), false, "link")).toBe(draw(near));
    expect(draw(withFreeable(3))).toBe(draw(near));
  });

  it("some com o aviso", () => {
    expect(draw(withFreeable(3), true, "link")).toBe("");
    expect(draw(null, false, "link")).toBe("");
  });
});
