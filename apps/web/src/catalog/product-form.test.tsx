import type { ProductReadModel } from "@polaris/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { emptyDraft, ProductForm } from "./product-form";

/**
 * The form of a product, drawn without a browser: which fields a new product shows at first sight and which wait
 * under "Mais detalhes". The behavior of the fields (focus, errors, the retry) is proved in the browser
 * (e2e/products-screen.e2e.ts) and in the model (product-opening-model.test.ts).
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
      draft={{ ...emptyDraft, name: editingProduct?.name ?? "" }}
      editingProduct={editingProduct}
      isPending={false}
      onCancel={noop}
      onChange={noop}
      onSubmit={noop}
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
      "Preço de venda",
      "Quantos você tem agora",
      "Custo de cada unidade (opcional)",
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

  it("says once what an empty quantity does, and labels the button for the new product", () => {
    expect(markup).toContain("Deixe vazio se ainda não tem estoque.");
    expect(markup).toContain("Cadastrar produto");
    expect(markup).toContain("Novo produto");
  });
});

describe("form of an edit", () => {
  const markup = draw(product);

  it("has no price, quantity or cost: the stock is not edited here", () => {
    expect(markup).not.toContain("Preço de venda");
    expect(markup).not.toContain("Quantos você tem agora");
    expect(markup).not.toContain("Custo de cada unidade");
    expect(markup).toContain("Editar produto");
    expect(markup).toContain("Salvar alterações");
  });

  it("opens the details, where the category and the description are what changes", () => {
    expect(markup).toContain('aria-expanded="true"');
    expect(tagWith(markup, 'data-slot="collapsible-content"')).not.toContain(
      'hidden=""'
    );
  });
});
