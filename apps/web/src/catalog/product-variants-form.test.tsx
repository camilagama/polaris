// @vitest-environment happy-dom
import type { ProductReadModel } from "@polaris/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StaticOrganizationProvider } from "../lib/current-organization";
import { ProductVariantConfigurationForm } from "./product-variants-form";
import { ProductVariantSkuSection } from "./product-variant-sku-section";
import {
  emptyConfigurationDraft,
  type VariantConfigurationDraft,
} from "./product-variants-model";

vi.mock("../lib/orpc", () => ({ orpcClient: {} }));

const noop = () => undefined;
const configuration = (sku: string | null) => ({
  configured: false as const,
  options: [],
  productId: "p1",
  productVersion: 1,
  variants: [
    {
      id: "v1",
      isDefault: true,
      listPrice: null,
      position: null,
      sku,
      values: [],
      version: 1,
    },
  ],
});

afterEach(cleanup);

const formOf = (
  sku: string | null,
  draft: VariantConfigurationDraft = {
    ...emptyConfigurationDraft,
    selectedOptions: ["color"],
  }
) => (
  <StaticOrganizationProvider
    organization={{ id: "o1", name: "Loja", role: "owner", timezone: "UTC" }}
  >
    <ProductVariantConfigurationForm
      configuration={configuration(sku)}
      draft={draft}
      onConfigured={noop}
      onConflict={noop}
      onDraftChange={noop}
      onSkuCleared={noop}
      organizationId="o1"
      product={{ id: "p1" } as ProductReadModel}
    />
  </StaticOrganizationProvider>
);

function draw(
  sku: string | null,
  draft: VariantConfigurationDraft = {
    ...emptyConfigurationDraft,
    selectedOptions: ["color"],
  }
) {
  return renderToStaticMarkup(formOf(sku, draft));
}

const show = (
  sku: string | null,
  draft: VariantConfigurationDraft = {
    ...emptyConfigurationDraft,
    selectedOptions: ["color"],
  }
) => render(formOf(sku, draft));

describe("warning of the SKU of the default variant", () => {
  it("the button that clears it names the SKU that will be erased", () => {
    const markup = draw("ABC-123");
    expect(markup).toContain(
      "Limpe o SKU da variante padrão antes de configurar opções"
    );
    expect(markup).toContain(
      "Limpar SKU &quot;ABC-123&quot; da variante padrão"
    );
    expect(markup).not.toContain(">Limpar SKU da variante padrão<");
  });

  it("without a SKU there is no warning and no button", () => {
    expect(draw(null)).not.toContain("Limpar SKU");
  });
});

const drawValues = (colorLines: string) =>
  draw(null, {
    ...emptyConfigurationDraft,
    selectedOptions: ["color"],
    valueLines: { ...emptyConfigurationDraft.valueLines, color: colorLines },
  });

describe("the error of the values of an option", () => {
  it("says the count over the limit as a polite status, so each key does not interrupt the reader", () => {
    const markup = drawValues(`Azul\n${"a".repeat(81)}`);
    expect(markup).toContain('role="status"');
    expect(markup).toContain("A linha 2 tem 81.");
    expect(markup).not.toContain('role="alert"');
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain(
      'aria-describedby="product-variant-values-color-error'
    );
  });

  it("keeps the other errors of the values as an alert", () => {
    const markup = drawValues("Azul\nazul");
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Remova valores repetidos nesta opção.");
    expect(markup).not.toContain('role="status"');
  });
});

describe("the error of the SKU over the limit", () => {
  it("is a polite status with the count, and the field and the button point to it", () => {
    const markup = renderToStaticMarkup(
      <ProductVariantSkuSection
        configuration={configuration("A".repeat(71))}
        onConflict={noop}
        onUpdated={noop}
        organizationId="o1"
        productId="p1"
      />
    );
    expect(markup).toContain("Use até 64 caracteres. Agora são 71.");
    expect(markup).toContain('role="status"');
    expect(markup).not.toContain('role="alert"');
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain('aria-disabled="true"');
  });
});

describe("Adicionar todas as combinações", () => {
  it("names on the button how many combinations it adds, and reads nothing before the tap", () => {
    const markup = draw(null, {
      ...emptyConfigurationDraft,
      selectedOptions: ["size", "color"],
      valueLines: {
        ...emptyConfigurationDraft.valueLines,
        color: "Preta\nBranca\nAzul",
        size: "P\nM\nG\nGG",
      },
    });
    expect(markup).toContain("Adicionar todas as combinações (12)");
    expect(markup).toContain(
      'nada é salvo antes de "Salvar variantes"'.replaceAll('"', "&quot;")
    );
  });

  it("is off, without a count, while an option has no values", () => {
    show(null);
    const addAll = screen.getByRole("button", {
      name: "Adicionar todas as combinações",
    });
    expect((addAll as HTMLButtonElement).disabled).toBe(true);
  });
});

const ADD_ALL = /^Adicionar todas as combinações/;
const ADD_ROW = { name: "Adicionar combinação" };

describe("Adicionar combinação, the last row of the list", () => {
  const withOptions = {
    ...emptyConfigurationDraft,
    selectedOptions: ["color" as const],
    valueLines: { ...emptyConfigurationDraft.valueLines, color: "Azul" },
  };
  const order = (node: Node) =>
    [...document.body.querySelectorAll("*")].indexOf(node as Element);
  const follows = (before: Node, after: Node) => order(before) < order(after);

  it("is a button, outside the list, and sits right under the empty-list sentence", () => {
    show(null, withOptions);
    const sentence = screen.getByText("Nenhuma combinação adicionada.");
    const row = screen.getByRole("button", ADD_ROW);
    expect(row.getAttribute("type")).toBe("button");
    expect(row.closest("ol")).toBeNull();
    expect(follows(sentence, row)).toBe(true);
    expect(sentence.parentElement).toBe(row.parentElement);
    expect(sentence.nextElementSibling).toBe(row);
  });

  it("stays after the last combination and before the other actions", () => {
    show(null, {
      ...withOptions,
      variants: [{ values: { color: "Azul" } }],
    });
    const list = screen.getByRole("list");
    const row = screen.getByRole("button", ADD_ROW);
    const addAll = screen.getByRole("button", {
      name: ADD_ALL,
    });
    expect(follows(list, row)).toBe(true);
    expect(list.contains(row)).toBe(false);
    expect(follows(row, addAll)).toBe(true);
    expect(list.nextElementSibling).toBe(row);
  });

  it("is off, as before, while an option has no values", () => {
    show(null);
    expect(
      (screen.getByRole("button", ADD_ROW) as HTMLButtonElement).disabled
    ).toBe(true);
  });
});

describe("each combination of the list", () => {
  const withRows = {
    ...emptyConfigurationDraft,
    selectedOptions: ["color" as const],
    valueLines: { ...emptyConfigurationDraft.valueLines, color: "Azul" },
    variants: [{ values: { color: "Azul" } }, { values: { color: "Azul" } }],
  };

  it("is a field group named by its badge, so the reader says which combination the fields belong to", () => {
    show(null, withRows);
    for (const number of [1, 2]) {
      const group = screen.getByRole("group", {
        name: `Combinação ${number}`,
      });
      expect(group.getAttribute("data-slot")).toBe("field-group");
      expect(group.tagName).toBe("FIELDSET");
    }
  });
});
