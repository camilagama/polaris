import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Block,
  BlockFooter,
  BlockHeader,
  BlockLink,
  BlockPanel,
} from "./block";

function draw() {
  return renderToStaticMarkup(
    <Block aria-labelledby="titulo">
      <BlockHeader id="titulo" title="Vendas" />
      <BlockPanel>conteúdo</BlockPanel>
      <BlockFooter>
        <BlockLink href="/sales">Ver vendas</BlockLink>
      </BlockFooter>
    </Block>
  );
}

const HEADING = /<h2[^>]*id="titulo"[^>]*>Vendas<\/h2>/;
const HIDDEN_FOOT =
  /class="hidden [^"]*md:flex"[^>]*data-slot="card-frame-footer"/;

describe("Block", () => {
  it("é uma região nomeada pelo título, na moldura do Início", () => {
    const html = draw();
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-labelledby="titulo"');
    expect(html).toContain('data-slot="card-frame"');
    expect(html).toMatch(HEADING);
  });

  it("compõe cabeçalho, painel, pé e link com o `CardFrame*`", () => {
    const html = draw();
    for (const slot of [
      "card-frame-header",
      "card-frame-panel",
      "card-frame-footer",
      "card-frame-link",
    ]) {
      expect(html).toContain(`data-slot="${slot}"`);
    }
    expect(html).toContain('href="/sales"');
  });

  it("a moldura só existe a partir de 760 px: abaixo disso é o cartão simples", () => {
    const html = draw();
    expect(html).toContain("md:p-(--frame-gap)");
    expect(html).toContain("md:bg-muted");
    expect(html).toMatch(HIDDEN_FOOT);
  });
});
