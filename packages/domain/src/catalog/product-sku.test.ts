import { describe, expect, it } from "vitest";
import { normalizeProductVariantSku } from "./product";

describe("product variant SKU rules", () => {
  it("trims external whitespace and preserves the entered case", () => {
    expect(normalizeProductVariantSku("  sku-AbC  ")).toBe("sku-AbC");
  });

  it("treats null and blank values as no SKU", () => {
    expect(normalizeProductVariantSku(null)).toBeNull();
    expect(normalizeProductVariantSku(" \t\n ")).toBeNull();
  });

  it("does not impose an undocumented maximum length", () => {
    const sku = "SKU-".concat("A".repeat(1024));

    expect(normalizeProductVariantSku(sku)).toBe(sku);
  });
});
