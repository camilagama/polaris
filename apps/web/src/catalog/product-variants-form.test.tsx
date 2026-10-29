import type { ProductReadModel } from "@polaris/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StaticOrganizationProvider } from "../lib/current-organization";
import { ProductVariantConfigurationForm } from "./product-variants-form";
import { ProductVariantSkuSection } from "./product-variant-sku-section";
import { emptyConfigurationDraft } from "./product-variants-model";

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

function draw(
  sku: string | null,
  draft = { ...emptyConfigurationDraft, selectedOptions: ["color" as const] }
) {
  return renderToStaticMarkup(
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
}

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
