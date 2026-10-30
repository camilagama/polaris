import { describe, expect, it } from "vitest";
import {
  MAX_PRODUCT_VARIANT_SKU_LENGTH,
  normalizeProductVariantSku,
  ProductVariantSkuError,
} from "./product";

describe("product variant SKU rules", () => {
  it("trims external whitespace and preserves the entered case", () => {
    expect(normalizeProductVariantSku("  sku-AbC  ")).toBe("sku-AbC");
  });

  it("treats null and blank values as no SKU", () => {
    expect(normalizeProductVariantSku(null)).toBeNull();
    expect(normalizeProductVariantSku(" \t\n ")).toBeNull();
  });

  it("accepts 64 code points after the trim and refuses 65", () => {
    expect(MAX_PRODUCT_VARIANT_SKU_LENGTH).toBe(64);
    expect(normalizeProductVariantSku(` ${"A".repeat(64)} `)).toBe(
      "A".repeat(64)
    );
    expect(() => normalizeProductVariantSku("A".repeat(65))).toThrow(
      ProductVariantSkuError
    );
  });

  it("counts code points, not UTF-16 units", () => {
    const emoji = "\u{1F600}";

    expect(normalizeProductVariantSku(emoji.repeat(64))).toBe(emoji.repeat(64));
    expect(() => normalizeProductVariantSku(emoji.repeat(65))).toThrow(
      ProductVariantSkuError
    );
  });
});
