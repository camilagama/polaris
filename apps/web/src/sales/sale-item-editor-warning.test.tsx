import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ItemDraft } from "./sale-form-model";
import { ItemEditor } from "./sale-item-editor";

vi.mock("../lib/orpc", () => ({ orpcClient: {} }));

const variantId = "22222222-2222-4222-8222-222222222222";
const item: ItemDraft = {
  chargedUnitPrice: "10,00",
  draftId: "d1",
  label: "Caneca esmaltada",
  listedUnitPrice: "10,00",
  productId: "11111111-1111-4111-8111-111111111111",
  quantity: "2",
  variantId,
};
const noop = () => undefined;
const WARNING = "Só há 1 no estoque.";
const STATUS_LINE = /<p [^>]*role="status"[^>]*>[\s\S]*?<\/p>/;
const SIXTEEN_PX = /class="[^"]*\bsize-4\b/;
const SVG = /<svg\b[^>]*>/;

function render(): string {
  return renderToStaticMarkup(
    <ItemEditor
      canAdjustStock={false}
      canRemove={false}
      errors={{}}
      index={0}
      item={item}
      localSearch={undefined}
      onChange={noop}
      onPick={noop}
      onRemove={noop}
      organizationId="org"
      priceHint={null}
      stock={{}}
      stockWarning={WARNING}
      summaryLine={undefined}
    />
  );
}

describe("o triângulo do aviso de estoque da linha do item", () => {
  it("tem 16 px e fica na primeira linha do texto, sem margem de ajuste", () => {
    const warning = render().match(STATUS_LINE)?.[0] ?? "";
    expect(warning).toContain(WARNING);
    const icon = warning.match(SVG)?.[0] ?? "";
    expect(icon).toMatch(SIXTEEN_PX);
    expect(icon).not.toContain("size-3.5");
    expect(icon).not.toContain("mt-0.5");
  });
});
