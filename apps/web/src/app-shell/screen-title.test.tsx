import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ScreenTitle,
  TabPanelScope,
  TitleLine,
  useTitleHidden,
} from "./screen-title";

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

const OPENING_TAG = /<(h[12])\s+class="([^"]*)"/;

function titleTag(html: string) {
  const match = OPENING_TAG.exec(html);
  return { classes: (match?.[2] ?? "").split(" "), tag: match?.[1] };
}

describe("ScreenTitle", () => {
  it("fora de aba é o h1 da página, em text-title, e nunca fica só para o leitor de tela, mesmo com tabNamesIt", () => {
    const { classes, tag } = titleTag(
      renderToStaticMarkup(<ScreenTitle tabNamesIt>Assinatura</ScreenTitle>)
    );
    expect(tag).toBe("h1");
    expect(classes).toContain("text-title");
    expect(classes).not.toContain("text-section");
    expect(classes).not.toContain("sr-only");
  });

  it("em aba é um h2 de seção, em text-section, desenhado quando a aba não diz o nome da tela", () => {
    const { classes, tag } = titleTag(
      renderToStaticMarkup(
        <TabPanelScope>
          <ScreenTitle>Metas</ScreenTitle>
        </TabPanelScope>
      )
    );
    expect(tag).toBe("h2");
    expect(classes).toContain("text-section");
    expect(classes).not.toContain("text-title");
    expect(classes).not.toContain("sr-only");
  });

  it("em aba o título fica só para o leitor de tela quando a aba já o diz", () => {
    const { classes, tag } = titleTag(
      renderToStaticMarkup(
        <TabPanelScope>
          <ScreenTitle tabNamesIt>Assinatura</ScreenTitle>
        </TabPanelScope>
      )
    );
    expect(tag).toBe("h2");
    expect(classes).toContain("text-section");
    expect(classes).toContain("sr-only");
  });

  it("soma a className do chamador sem tirar o sr-only nem o tamanho do título", () => {
    const hidden = titleTag(
      renderToStaticMarkup(
        <TabPanelScope>
          <ScreenTitle className="mb-2" tabNamesIt>
            Assinatura
          </ScreenTitle>
        </TabPanelScope>
      )
    );
    expect(hidden.classes).toEqual(
      expect.arrayContaining(["text-section", "sr-only", "mb-2"])
    );
    const standalone = titleTag(
      renderToStaticMarkup(<ScreenTitle className="mb-2">Produtos</ScreenTitle>)
    );
    expect(standalone.classes).toEqual(
      expect.arrayContaining(["text-title", "mb-2"])
    );
  });

  it("leva o texto como filho, uma só vez, e repassa os atributos ao título", () => {
    const html = renderToStaticMarkup(
      <TabPanelScope>
        <ScreenTitle id="titulo-assinatura" tabNamesIt>
          Assinatura
        </ScreenTitle>
      </TabPanelScope>
    );
    expect(html.split("Assinatura")).toHaveLength(2);
    expect(html).toContain('id="titulo-assinatura"');
    expect(html.endsWith(">Assinatura</h2>")).toBe(true);
  });
});

const LINE_TAG = /<div class="([^"]*)" data-title-line=""/;

function lineClasses(html: string) {
  return (LINE_TAG.exec(html)?.[1] ?? "").split(" ");
}

describe("TitleLine with a title only for a screen reader", () => {
  it("takes no room in the grid of the page when it has no action", () => {
    const classes = lineClasses(
      renderToStaticMarkup(
        <TitleLine titleHidden>
          <h2 className="sr-only">Categorias</h2>
        </TitleLine>
      )
    );
    expect(classes).toEqual(["contents"]);
  });

  it("keeps the height of a control when the title is drawn or when there is an action", () => {
    const drawn = lineClasses(
      renderToStaticMarkup(
        <TitleLine>
          <h2>Seus dados</h2>
        </TitleLine>
      )
    );
    const withAction = lineClasses(
      renderToStaticMarkup(
        <TitleLine action={<button type="button">Novo</button>} titleHidden>
          <h2 className="sr-only">Produtos</h2>
        </TitleLine>
      )
    );
    expect(drawn).toContain("min-[47.5rem]:min-h-ctl-md");
    expect(withAction).toContain("min-[47.5rem]:min-h-ctl-md");
    expect(drawn).not.toContain("contents");
    expect(withAction).not.toContain("contents");
  });
});

function HiddenProbe({ tabNamesIt }: { tabNamesIt: boolean }) {
  return <p>{String(useTitleHidden(tabNamesIt))}</p>;
}

describe("useTitleHidden", () => {
  it("is true only in a tab that names the screen, as ScreenTitle draws it for a screen reader", () => {
    const inTab = (tabNamesIt: boolean) =>
      renderToStaticMarkup(
        <TabPanelScope>
          <HiddenProbe tabNamesIt={tabNamesIt} />
        </TabPanelScope>
      );
    expect(inTab(true)).toBe("<p>true</p>");
    expect(inTab(false)).toBe("<p>false</p>");
    expect(renderToStaticMarkup(<HiddenProbe tabNamesIt />)).toBe(
      "<p>false</p>"
    );
  });
});
