import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TitleLine } from "./screen-title";

const BACK = { href: "/sales/history", label: "Voltar para o histórico" };
const WORD_ON_SCREEN = />\s*Voltar/;

describe("TitleLine with back", () => {
  it("draws the arrow before the title, as a link named for the list, with no word on screen", () => {
    const html = renderToStaticMarkup(
      <TitleLine back={BACK}>
        <h1>Detalhe da venda</h1>
      </TitleLine>
    );
    expect(html.indexOf("data-back")).toBeLessThan(html.indexOf("<h1"));
    expect(html).toContain('aria-label="Voltar para o histórico"');
    expect(html).toContain('href="/sales/history"');
    expect(html).not.toMatch(WORD_ON_SCREEN);
    expect(html).toContain('aria-hidden="true"');
  });

  it("draws nothing before the title without it", () => {
    const html = renderToStaticMarkup(
      <TitleLine>
        <h1>Produtos</h1>
      </TitleLine>
    );
    expect(html).not.toContain("data-back");
  });

  it("keeps the action after the title, so the arrow is the first control and the action the one after the title", () => {
    const html = renderToStaticMarkup(
      <TitleLine action={<button type="button">Novo</button>} back={BACK}>
        <h1>Detalhe</h1>
      </TitleLine>
    );
    expect(html.indexOf("data-back")).toBeLessThan(html.indexOf("<h1"));
    expect(html.indexOf("<h1")).toBeLessThan(html.indexOf("<button"));
  });
});
