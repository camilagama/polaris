import type { ProductReadModel } from "@polaris/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { emptyDraft, ProductForm, productFormHasErrors } from "./product-form";
import { ProductMediaCropField } from "./product-media-crop";

/**
 * The form of a product, drawn without a browser: which fields a new product shows at first sight and which wait
 * under "Mais detalhes". The dialog around it (tabs, buttons, focus, errors in a hidden tab, the retry) is proved in the
 * browser (e2e/products-screen.e2e.ts) and the fields in the model (product-opening-model.test.ts).
 */
const noop = () => undefined;

const product: ProductReadModel = {
  archivedAt: null,
  categoryId: null,
  createdAt: "2026-10-14T12:00:00.000Z",
  deletedAt: null,
  description: "Algodão",
  id: "0199c2d0-0000-7000-8000-000000000021",
  name: "Camiseta",
  organizationId: "org",
  status: "active",
  updatedAt: "2026-10-14T12:00:00.000Z",
  version: 1,
};

function draw(editingProduct: ProductReadModel | null): string {
  return renderToStaticMarkup(
    <ProductForm
      categories={[]}
      categoryRefusal={0}
      draft={{ ...emptyDraft, name: editingProduct?.name ?? "" }}
      editing={editingProduct !== null}
      onChange={noop}
      onSubmit={noop}
      showRequired={false}
    />
  );
}

/** The opening tag that holds `needle` (an attribute of it), as drawn. */
function tagWith(markup: string, needle: string): string {
  const at = markup.indexOf(needle);
  expect(at, `${needle} is in the form`).toBeGreaterThan(-1);
  return markup.slice(markup.lastIndexOf("<", at), markup.indexOf(">", at) + 1);
}

function indexOfText(markup: string, text: string): number {
  const at = markup.indexOf(text);
  expect(at, `"${text}" is in the form`).toBeGreaterThan(-1);
  return at;
}

describe("form of a new product", () => {
  const markup = draw(null);

  it("shows the name, the price, the quantity and the cost, in that order, before the details", () => {
    const order = [
      "Nome do produto",
      "Preço de tabela",
      "Quantos você tem agora",
      "Custo de cada unidade",
      "Mais detalhes",
    ].map((text) => indexOfText(markup, text));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("keeps the category and the description closed under Mais detalhes, still in the page", () => {
    expect(markup).toContain('aria-expanded="false"');
    expect(tagWith(markup, 'data-slot="collapsible-content"')).toContain(
      'hidden=""'
    );
    expect(markup).toContain("Categoria");
    expect(markup).toContain("Descrição");
  });

  it("asks for numbers with the right keyboard, with R$ on the two amounts", () => {
    expect(tagWith(markup, 'id="product-quantity"')).toContain(
      'inputMode="numeric"'
    );
    expect(tagWith(markup, 'id="product-list-price"')).toContain(
      'inputMode="decimal"'
    );
    expect(tagWith(markup, 'id="product-unit-cost"')).toContain(
      'inputMode="decimal"'
    );
    expect(markup.split(">R$<")).toHaveLength(3);
  });

  it("says once what an empty quantity does, and where the variants and the images go", () => {
    expect(markup).toContain("Deixe vazio se ainda não tem estoque.");
    expect(markup).toContain(
      "Variações (cor, tamanho), SKU e fotos ficam nas abas do produto depois de salvar."
    );
  });

  it("is the form the footer of the dialog submits, from any tab", () => {
    expect(tagWith(markup, "<form")).toContain('id="product-form"');
  });
});

describe("Mais detalhes", () => {
  const markup = draw(null);

  it("is named once: the trigger carries the name and the group around it carries none", () => {
    expect(markup.split("Mais detalhes")).toHaveLength(2);
    const group = tagWith(markup, 'data-slot="collapsible"');
    expect(group).toContain('role="none"');
    expect(group).not.toContain("aria-label");
  });
});

describe("the pieces of the dialog of a product", () => {
  it("the form groups its fields with the field group and the field set, not with a div drawn by hand", () => {
    const markup = draw(null);
    expect(markup.split('data-slot="field-set"')).toHaveLength(3);
    const details = tagWith(markup, 'data-slot="collapsible"');
    expect(details.startsWith("<fieldset")).toBe(true);
    expect(details).toContain("rounded-lg border border-border");
  });

  it("the crop of an image holds the picture in the inset block", () => {
    const markup = renderToStaticMarkup(
      <ProductMediaCropField
        adjusting={false}
        announcement=""
        crop={{ height: 1, width: 1, x: 0, y: 0 }}
        dimensions={{ height: 100, width: 100 }}
        disabled={false}
        onKeyDown={noop}
        onPointerCancel={noop}
        onPointerDown={noop}
        onPointerMove={noop}
        onPointerUp={noop}
        onToggleAdjusting={noop}
        onUseFullImage={noop}
        previewUrl="blob:preview"
      />
    );
    expect(markup).toContain('data-slot="inset-block"');
  });
});

describe("form of an edit", () => {
  const markup = draw(product);

  it("has no price, quantity or cost: the stock is not edited here", () => {
    expect(markup).not.toContain("Preço de tabela");
    expect(markup).not.toContain("Quantos você tem agora");
    expect(markup).not.toContain("Custo de cada unidade");
    expect(markup).not.toContain("Variações (cor, tamanho)");
  });

  it("opens the details, where the category and the description are what changes", () => {
    expect(markup).toContain('aria-expanded="true"');
    expect(tagWith(markup, 'data-slot="collapsible-content"')).not.toContain(
      'hidden=""'
    );
  });
});

describe("errors of the data", () => {
  it("a new product needs a name and an opening that reads", () => {
    expect(productFormHasErrors(emptyDraft, false)).toBe(true);
    expect(productFormHasErrors({ ...emptyDraft, name: "Boné" }, false)).toBe(
      false
    );
    expect(
      productFormHasErrors(
        { ...emptyDraft, name: "Boné", quantity: "abc" },
        false
      )
    ).toBe(true);
  });

  it("an edit needs only the name: the stock is not edited there", () => {
    expect(productFormHasErrors({ ...emptyDraft, name: " " }, true)).toBe(true);
    // a name of only characters of zero width shows empty, as the server takes it
    expect(
      productFormHasErrors({ ...emptyDraft, name: "\u200B\u2060" }, true)
    ).toBe(true);
    expect(
      productFormHasErrors(
        { ...emptyDraft, name: "Boné", quantity: "abc" },
        true
      )
    ).toBe(false);
  });
});
