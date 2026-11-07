import { describe, expect, it } from "vitest";
import {
  MAX_PRODUCT_OPTION_VALUE_LENGTH,
  MAX_PRODUCT_VARIANTS,
  normalizeProductVariantConfiguration,
  ProductVariantConfigurationError,
} from "./product";

const colorAndSizeOptions = [
  { name: "color", values: [" Azul ", "PRETO"] },
  { name: "size", values: ["P", "M"] },
] as const;

describe("product variant configuration rules", () => {
  it("trims values, preserves their display case, and accepts explicit subsets", () => {
    const configuration = normalizeProductVariantConfiguration({
      options: colorAndSizeOptions,
      variants: [
        { values: { color: "azul", size: "P" } },
        { values: { color: "PRETO", size: "M" } },
      ],
    });

    expect(configuration).toEqual({
      options: [
        { name: "color", values: ["Azul", "PRETO"] },
        { name: "size", values: ["P", "M"] },
      ],
      variants: [
        { values: { color: "Azul", size: "P" } },
        { values: { color: "PRETO", size: "M" } },
      ],
    });
    expect(configuration.variants).toHaveLength(2);
  });

  it("rejects blank and case-insensitive duplicate values within one option", () => {
    expect(() =>
      normalizeProductVariantConfiguration({
        options: [{ name: "color", values: ["   "] }],
        variants: [{ values: { color: "   " } }],
      })
    ).toThrow(ProductVariantConfigurationError);

    expect(() =>
      normalizeProductVariantConfiguration({
        options: [{ name: "size", values: ["M", " m "] }],
        variants: [{ values: { size: "M" } }],
      })
    ).toThrow(ProductVariantConfigurationError);
  });

  it("rejects selecting the same option more than once", () => {
    expect(() =>
      normalizeProductVariantConfiguration({
        options: [
          { name: "color", values: ["Azul"] },
          { name: "color", values: ["Preto"] },
        ],
        variants: [{ values: { color: "Azul" } }],
      })
    ).toThrow(ProductVariantConfigurationError);
  });

  it("requires exactly one allowed value for every selected option", () => {
    expect(() =>
      normalizeProductVariantConfiguration({
        options: colorAndSizeOptions,
        variants: [{ values: { color: "Azul" } }],
      })
    ).toThrow(ProductVariantConfigurationError);

    expect(() =>
      normalizeProductVariantConfiguration({
        options: [{ name: "color", values: ["Azul"] }],
        variants: [{ values: { color: "Azul", size: "P" } }],
      })
    ).toThrow(ProductVariantConfigurationError);

    expect(() =>
      normalizeProductVariantConfiguration({
        options: [{ name: "color", values: ["Azul"] }],
        variants: [{ values: { color: "Verde" } }],
      })
    ).toThrow(ProductVariantConfigurationError);
  });

  it("rejects duplicate combinations after trimming and case normalization", () => {
    expect(() =>
      normalizeProductVariantConfiguration({
        options: [{ name: "color", values: ["Azul"] }],
        variants: [
          { values: { color: "Azul" } },
          { values: { color: " azul " } },
        ],
      })
    ).toThrow(ProductVariantConfigurationError);
  });

  it("accepts 50 explicit variants and rejects 51", () => {
    const values = Array.from(
      { length: MAX_PRODUCT_VARIANTS },
      (_, index) => `Modelo ${index + 1}`
    );
    const variants = values.map((model) => ({ values: { model } }));

    expect(
      normalizeProductVariantConfiguration({
        options: [{ name: "model", values }],
        variants,
      }).variants
    ).toHaveLength(50);
    expect(() =>
      normalizeProductVariantConfiguration({
        options: [{ name: "model", values: [...values, "Modelo 51"] }],
        variants: [...variants, { values: { model: "Modelo 51" } }],
      })
    ).toThrow(ProductVariantConfigurationError);
  });

  it("accepts an option value of 80 code points after the trim, emojis included, and refuses 81", () => {
    const configure = (value: string) =>
      normalizeProductVariantConfiguration({
        options: [{ name: "model", values: [value] }],
        variants: [{ values: { model: value } }],
      });
    const emoji = "\u{1F600}";

    expect(MAX_PRODUCT_OPTION_VALUE_LENGTH).toBe(80);
    expect(configure(` ${"a".repeat(80)} `).options[0]?.values).toEqual([
      "a".repeat(80),
    ]);
    expect(configure(emoji.repeat(80)).options[0]?.values).toEqual([
      emoji.repeat(80),
    ]);
    expect(() => configure("a".repeat(81))).toThrow(
      ProductVariantConfigurationError
    );
    expect(() => configure(emoji.repeat(81))).toThrow(
      ProductVariantConfigurationError
    );
  });

  it("requires at least one selected option and one explicit combination", () => {
    expect(() =>
      normalizeProductVariantConfiguration({ options: [], variants: [] })
    ).toThrow(ProductVariantConfigurationError);
    expect(() =>
      normalizeProductVariantConfiguration({
        options: [{ name: "model", values: ["A"] }],
        variants: [],
      })
    ).toThrow(ProductVariantConfigurationError);
  });
});
