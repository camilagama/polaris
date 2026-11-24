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

const PLAIN_HEADING = /<h2[^>]*>Comprovante<\/h2>/;
const HEADING_WITH_ID = /<h2[^>]*id="home-goal"[^>]*>Meta<\/h2>/;
const GROWING_CONTENT = /class="[^"]*\bgrow\b[^"]*" data-slot="card-content"/;
const ANY_GROW = /\bgrow\b/;
const PLAIN_REGION = /<div[^>]*aria-labelledby="([^"]+)"[^>]*role="region"/;

describe("Block variant plain", () => {
  it("com título é uma região nomeada pelo h2, sem a moldura de fora", () => {
    const html = renderToStaticMarkup(
      <Block
        action={<button type="button">Imprimir</button>}
        description="Pago em 2 vezes."
        title="Comprovante"
        variant="plain"
      >
        corpo
      </Block>
    );
    const labelled = PLAIN_REGION.exec(html)?.[1];
    expect(labelled).toBeDefined();
    expect(html).toContain(`id="${labelled}"`);
    expect(html).toMatch(PLAIN_HEADING);
    expect(html).toContain('data-slot="block-header"');
    expect(html).toContain("Pago em 2 vezes.");
    expect(html).toContain("Imprimir");
    expect(html).toContain("corpo");
    expect(html).toContain('data-slot="card"');
    expect(html).not.toContain('data-slot="card-frame"');
    expect(html).not.toContain("md:bg-muted");
  });

  it("sem título não há região nem h2, e o conteúdo e a ação continuam", () => {
    const html = renderToStaticMarkup(
      <Block action={<button type="button">Copiar</button>} variant="plain">
        resumo
      </Block>
    );
    expect(html).not.toContain('role="region"');
    expect(html).not.toContain("<h2");
    expect(html).toContain("resumo");
    expect(html).toContain("Copiar");
  });

  it("sem título nem nada além do conteúdo não desenha a linha do cabeçalho", () => {
    const html = renderToStaticMarkup(<Block variant="plain">só isto</Block>);
    expect(html).not.toContain('data-slot="card-header"');
    expect(html).toContain("só isto");
  });

  it("headingId dá o id ao h2 que nomeia a região, no lugar do gerado", () => {
    const html = renderToStaticMarkup(
      <Block headingId="home-goal" title="Meta" variant="plain">
        corpo
      </Block>
    );
    expect(html).toContain('aria-labelledby="home-goal"');
    expect(html).toMatch(HEADING_WITH_ID);
  });

  it("compact tira o piso de 36 px do cabeçalho e deixa o corpo crescer; sem ele, nenhum dos dois", () => {
    const compact = renderToStaticMarkup(
      <Block compact title="Meta" variant="plain">
        corpo
      </Block>
    );
    const regular = renderToStaticMarkup(
      <Block title="Meta" variant="plain">
        corpo
      </Block>
    );
    expect(compact).toContain("md:min-h-0");
    expect(compact).toMatch(GROWING_CONTENT);
    expect(regular).not.toContain("md:min-h-0");
    expect(regular).not.toMatch(ANY_GROW);
  });

  it("o título só se omite no plain: sem ele e sem o nome da região, não compila", () => {
    const named = (
      <Block aria-labelledby="titulo">
        <BlockHeader id="titulo" title="Vendas" />
      </Block>
    );
    // @ts-expect-error a framed block is a named region: it needs `aria-labelledby`, the title is only left out by `variant="plain"`
    const unnamed = <Block>sem título</Block>;
    // @ts-expect-error the framed block has no header props of its own: `title` is a prop of `variant="plain"`
    const stray = <Block aria-labelledby="titulo" title="Vendas" />;
    const plain = <Block variant="plain">sem título</Block>;
    expect([named, unnamed, stray, plain]).toHaveLength(4);
  });
});
