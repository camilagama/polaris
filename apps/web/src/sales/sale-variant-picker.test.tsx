import type { InventoryBalanceEntryReadModel } from "@polaris/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { VariantOptionText } from "./sale-variant-picker";
import { pickerOptions } from "./sale-variant-picker-model";

vi.mock("../lib/orpc", () => ({ orpcClient: {} }));

function entry(
  n: number,
  overrides: Partial<InventoryBalanceEntryReadModel> = {}
): InventoryBalanceEntryReadModel {
  return {
    isDefaultVariant: false,
    listPrice: null,
    movingAverageCost: "12.340000",
    productId: "11111111-1111-4111-8111-111111111111",
    productName: "Camiseta Polaris",
    productStatus: "active",
    quantity: 3,
    sku: `CAM-${n}`,
    updatedAt: "2026-10-09T12:00:00.000Z",
    values: [
      { optionName: "color", optionValueName: "Azul" },
      { optionName: "size", optionValueName: "M" },
    ],
    variantId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    version: 2,
    ...overrides,
  };
}

const render = (entries: readonly InventoryBalanceEntryReadModel[]) =>
  pickerOptions(entries)
    .map((option) =>
      renderToStaticMarkup(
        <VariantOptionText key={option.id} option={option} />
      )
    )
    .join("");

describe("VariantOptionText", () => {
  it.each([
    ["with a known cost", entry(1)],
    ["with the cost unknown", entry(2, { movingAverageCost: null })],
    ["without balance", entry(3, { quantity: 0 })],
    ["with a zero cost", entry(4, { movingAverageCost: "0.000000" })],
  ])("never shows the average cost of a variant %s", (_name, variant) => {
    const html = render([variant]);
    expect(html.toLowerCase()).not.toContain("custo");
    expect(html).not.toContain("12,34");
    expect(html).toContain("Camiseta Polaris");
  });

  it("keeps the balance and the SKU on every option", () => {
    const html = render([entry(1), entry(3, { quantity: 0 })]);
    expect(html).toContain("Saldo 3");
    expect(html).toContain("Sem saldo");
    expect(html).toContain("CAM-1");
  });
});
