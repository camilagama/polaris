import type { ProductReadModel } from "@polaris/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ProductVariantConfigurationForm } from "./product-variants-form";
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

function draw(sku: string | null) {
  return renderToStaticMarkup(
    <ProductVariantConfigurationForm
      configuration={configuration(sku)}
      draft={{ ...emptyConfigurationDraft, selectedOptions: ["color"] }}
      onConfigured={noop}
      onConflict={noop}
      onDraftChange={noop}
      onSkuCleared={noop}
      organizationId="o1"
      product={{ id: "p1" } as ProductReadModel}
    />
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
