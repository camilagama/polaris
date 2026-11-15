import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { NearLimitView } from "./limit-help-model";
import { NearLimitNotice } from "./limit-help";

vi.mock("../lib/orpc", () => ({ orpcClient: {} }));

const near: NearLimitView = {
  kind: "near",
  usage: { max: 50, subject: "variants", used: 47 },
};
const reached: NearLimitView = {
  kind: "reached",
  usage: { max: 50, subject: "images", used: 50 },
};
const draw = (view: NearLimitView | null, hidden = false) =>
  renderToStaticMarkup(<NearLimitNotice hidden={hidden} view={view} />);

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
