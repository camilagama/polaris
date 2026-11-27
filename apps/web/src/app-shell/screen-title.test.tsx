import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  SCREEN_TITLE_CLASS,
  SECTION_TITLE_CLASS,
  ScreenTitle,
  TabPanelScope,
  TitleLine,
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

const TITLE_LAST_IN_LINE =
  /^<div class="[^"]*" data-title-line=""><h2\b[^>]*>Assinatura<\/h2><\/div>$/;

const OPENING_TAG = /<(h[12])\s+class="([^"]*)"/;

function titleTag(html: string) {
  const match = OPENING_TAG.exec(html);
  return { classes: (match?.[2] ?? "").split(" "), tag: match?.[1] };
}

describe("ScreenTitle", () => {
  it("fora de aba é o h1 da página, em text-title, e nunca fica só para o leitor de tela, mesmo com tabNamesIt", () => {
    const { classes, tag } = titleTag(
      renderToStaticMarkup(
        <TitleLine tabNamesIt>
          <ScreenTitle>Assinatura</ScreenTitle>
        </TitleLine>
      )
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
          <TitleLine tabNamesIt>
            <ScreenTitle>Assinatura</ScreenTitle>
          </TitleLine>
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
          <TitleLine tabNamesIt>
            <ScreenTitle className="mb-2">Assinatura</ScreenTitle>
          </TitleLine>
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

  it("deixa a palavra única quebrar na coluna, no h1 e no h2", () => {
    const h1 = titleTag(
      renderToStaticMarkup(<ScreenTitle>Configurações</ScreenTitle>)
    );
    const h2 = titleTag(
      renderToStaticMarkup(
        <TabPanelScope>
          <ScreenTitle>Configurações</ScreenTitle>
        </TabPanelScope>
      )
    );
    expect(h1.tag).toBe("h1");
    expect(h2.tag).toBe("h2");
    for (const { classes } of [h1, h2]) {
      expect(classes).toEqual(
        expect.arrayContaining(["min-w-0", "[overflow-wrap:anywhere]"])
      );
    }
  });

  it("a classe exportada do título hifeniza e quebra por letra só em último caso, e é a que o ScreenTitle usa", () => {
    for (const exported of [SCREEN_TITLE_CLASS, SECTION_TITLE_CLASS]) {
      expect(exported.split(" ")).toEqual(
        expect.arrayContaining(["hyphens-auto", "[overflow-wrap:anywhere]"])
      );
    }
    expect(
      titleTag(renderToStaticMarkup(<ScreenTitle>Produtos</ScreenTitle>))
        .classes
    ).toEqual(SCREEN_TITLE_CLASS.split(" "));
    expect(
      titleTag(
        renderToStaticMarkup(
          <TabPanelScope>
            <ScreenTitle>Metas</ScreenTitle>
          </TabPanelScope>
        )
      ).classes
    ).toEqual(SECTION_TITLE_CLASS.split(" "));
  });

  it("leva o texto como filho, uma só vez, e repassa os atributos ao título", () => {
    const html = renderToStaticMarkup(
      <TabPanelScope>
        <TitleLine tabNamesIt>
          <ScreenTitle id="titulo-assinatura">Assinatura</ScreenTitle>
        </TitleLine>
      </TabPanelScope>
    );
    expect(html.split("Assinatura")).toHaveLength(2);
    expect(html).toContain('id="titulo-assinatura"');
    expect(html).toMatch(TITLE_LAST_IN_LINE);
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
        <TabPanelScope>
          <TitleLine tabNamesIt>
            <ScreenTitle>Categorias</ScreenTitle>
          </TitleLine>
        </TabPanelScope>
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
        <TabPanelScope>
          <TitleLine action={<button type="button">Novo</button>} tabNamesIt>
            <ScreenTitle>Produtos</ScreenTitle>
          </TitleLine>
        </TabPanelScope>
      )
    );
    expect(drawn).toContain("min-[47.5rem]:min-h-ctl-md");
    expect(withAction).toContain("min-[47.5rem]:min-h-ctl-md");
    expect(drawn).not.toContain("contents");
    expect(withAction).not.toContain("contents");
  });
});

const OPEN_TITLE = /<h[12] class="([^"]*)"/;

function screenOf(html: string): { drawn: boolean; lineClasses: string[] } {
  const title = (OPEN_TITLE.exec(html)?.[1] ?? "").split(" ");
  return { drawn: !title.includes("sr-only"), lineClasses: lineClasses(html) };
}

describe("TitleLine decide sozinho se o título é só para o leitor de tela", () => {
  const cases = [
    { inTab: true, tabNamesIt: true },
    { inTab: true, tabNamesIt: false },
    { inTab: false, tabNamesIt: true },
    { inTab: false, tabNamesIt: false },
  ];

  it.each(cases)(
    "em aba: $inTab, a aba diz o nome: $tabNamesIt, a linha some da grade se e só se o título não é desenhado",
    ({ inTab, tabNamesIt }) => {
      const line = (
        <TitleLine tabNamesIt={tabNamesIt}>
          <ScreenTitle>Categorias</ScreenTitle>
        </TitleLine>
      );
      const { drawn, lineClasses: classes } = screenOf(
        renderToStaticMarkup(
          inTab ? <TabPanelScope>{line}</TabPanelScope> : line
        )
      );
      expect(drawn).toBe(!(inTab && tabNamesIt));
      expect(classes.includes("contents")).toBe(!drawn);
    }
  );

  it("com ação a linha segue na grade mesmo com o título só para o leitor de tela", () => {
    const html = renderToStaticMarkup(
      <TabPanelScope>
        <TitleLine action={<button type="button">Novo</button>} tabNamesIt>
          <ScreenTitle>Produtos</ScreenTitle>
        </TitleLine>
      </TabPanelScope>
    );
    expect(screenOf(html).drawn).toBe(false);
    expect(screenOf(html).lineClasses).not.toContain("contents");
  });

  it("tela que pode ter ação, sem ação agora: sem caixa no toque e com a altura do botão a partir de 760 px", () => {
    const html = renderToStaticMarkup(
      <TabPanelScope>
        <TitleLine canHaveAction tabNamesIt>
          <ScreenTitle>Produtos</ScreenTitle>
        </TitleLine>
      </TabPanelScope>
    );
    const { drawn, lineClasses: classes } = screenOf(html);
    expect(drawn).toBe(false);
    expect(classes).toContain("contents");
    expect(classes).not.toContain("grid");
    expect(classes).toContain("min-[47.5rem]:flex");
    expect(classes).toContain("min-[47.5rem]:min-h-ctl-md");
  });

  it("o ScreenTitle não aceita a flag: ela só existe no TitleLine", () => {
    const html = renderToStaticMarkup(
      <TabPanelScope>
        {/* @ts-expect-error a flag é do TitleLine */}
        <ScreenTitle tabNamesIt>Assinatura</ScreenTitle>
      </TabPanelScope>
    );
    expect(titleTag(html).classes).not.toContain("sr-only");
  });
});
