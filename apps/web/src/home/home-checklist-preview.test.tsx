import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChecklistBlock,
  NEXT_STEP_ART,
  NEXT_STEP_SUPPORT,
} from "./home-figures";

const MARKUP = /[<>*_`]/;
const ART_TAG = /<svg[^>]*data-skeleton-art[^>]*>/;
const CURRENT_ROW = /<li[^>]*aria-current="step"[\s\S]*?<\/li>/;

const WIDE = "(min-width: 64rem)";

function stubWidth(wide: boolean) {
  vi.stubGlobal("window", {
    matchMedia: (media: string) => ({
      addEventListener: () => undefined,
      matches: wide && media === WIDE,
      removeEventListener: () => undefined,
    }),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function block(
  wide: boolean,
  checklist: { firstProductId: string | null; hasStock: boolean }
) {
  stubWidth(wide);
  return renderToStaticMarkup(<ChecklistBlock checklist={checklist} />);
}

const NO_PRODUCT = { firstProductId: null, hasStock: false } as const;
const NO_STOCK = { firstProductId: "p1", hasStock: false } as const;
const WITH_STOCK = { firstProductId: "p1", hasStock: true } as const;

const hrefs = (html: string) =>
  [...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map((match) => match[1]);

const count = (html: string, text: string) => html.split(text).length - 1;

describe("the sentences of the preview", () => {
  it("are one per next step, simple text, at most 100 characters", () => {
    expect(Object.keys(NEXT_STEP_SUPPORT).sort()).toEqual([
      "product",
      "sale",
      "stock",
    ]);
    for (const sentence of Object.values(NEXT_STEP_SUPPORT)) {
      expect(sentence.length).toBeLessThanOrEqual(100);
      expect(sentence).not.toMatch(MARKUP);
    }
  });

  it("promise nothing the app does not do: the product takes name, price and quantity", () => {
    expect(NEXT_STEP_SUPPORT.product).toBe(
      "Nome, preço e quantidade. Leva um minuto."
    );
    expect(NEXT_STEP_SUPPORT.stock).toBe(
      "Diga quantas unidades você tem para poder vender."
    );
    expect(NEXT_STEP_SUPPORT.sale).toBe(
      "Escolha o produto, a forma de receber e pronto."
    );
  });

  it("each next step has a drawing: the list for the product and its stock, the sale screen for the sale", () => {
    expect(NEXT_STEP_ART).toEqual({
      product: "products",
      sale: "sale",
      stock: "products",
    });
  });
});

describe.each([
  [
    "no product",
    NO_PRODUCT,
    "product",
    ["/products?novo=1", "/products?importar=1"],
  ],
  ["a product with no stock", NO_STOCK, "stock", ["/products?produto=p1"]],
  ["a product with stock", WITH_STOCK, "sale", ["/sales"]],
] as const)("from 1024 px, with %s", (_name, checklist, kind, links) => {
  const html = block(true, checklist);

  it("has the panel of the step of the hour, with its drawing and its sentence", () => {
    expect(html).toContain(`data-step-preview="${kind}"`);
    expect(html).toContain(`data-skeleton-art="${NEXT_STEP_ART[kind]}"`);
    expect(count(html, NEXT_STEP_SUPPORT[kind])).toBe(1);
  });

  it("has one link per destination: the button is in the panel and not repeated", () => {
    expect(hrefs(html)).toEqual([...links]);
  });

  it("puts the panel, and so the button, after the steps in the focus order", () => {
    expect(html.indexOf("</ol>")).toBeGreaterThan(0);
    expect(html.indexOf("data-step-preview")).toBeGreaterThan(
      html.indexOf("</ol>")
    );
    const list = html.slice(0, html.indexOf("</ol>"));
    expect(hrefs(list)).toEqual([]);
  });

  it("draws the picture as decoration outside the focus order, with no pulse and no skeleton class", () => {
    const art = ART_TAG.exec(html)?.[0] ?? "";
    expect(art).toContain('aria-hidden="true"');
    expect(art).toContain('focusable="false"');
    expect(art).not.toContain("animate-pulse");
    expect(html).not.toContain("animate-pulse");
    expect(html).not.toContain('data-slot="skeleton"');
  });

  it("does not fade on the first draw", () => {
    expect(html).not.toContain("animate-in");
  });
});

describe.each([
  [
    "no product",
    NO_PRODUCT,
    "product",
    ["/products?novo=1", "/products?importar=1"],
  ],
  ["a product with no stock", NO_STOCK, "stock", ["/products?produto=p1"]],
  ["a product with stock", WITH_STOCK, "sale", ["/sales"]],
] as const)("under 1024 px, with %s", (_name, checklist, kind, links) => {
  const html = block(false, checklist);

  it("is one column: no panel and no drawing", () => {
    expect(html).not.toContain("data-step-preview");
    expect(html).not.toContain("data-skeleton-art");
  });

  it("writes the sentence once, as the second line of the step of the hour", () => {
    expect(count(html, NEXT_STEP_SUPPORT[kind])).toBe(1);
    const current = CURRENT_ROW.exec(html)?.[0];
    expect(current).toContain(NEXT_STEP_SUPPORT[kind]);
  });

  it("has one link per destination", () => {
    expect(hrefs(html)).toEqual([...links]);
  });
});
