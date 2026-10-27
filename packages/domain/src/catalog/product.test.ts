import { describe, expect, it } from "vitest";
import {
  deriveProductLifecycle,
  InvalidVariantListPriceError,
  normalizeProductDescription,
  normalizeProductName,
  normalizeVariantListPrice,
  ProductDescriptionError,
  ProductLifecycleError,
  ProductNameError,
  transitionProductLifecycle,
} from "./product";

describe("product rules", () => {
  it("trims a product name and rejects blank input", () => {
    expect(normalizeProductName("  Bolsa  ")).toBe("Bolsa");
    expect(() => normalizeProductName("  \t ")).toThrow(ProductNameError);
  });

  it("treats blank optional descriptions as absent", () => {
    expect(normalizeProductDescription("  ")).toBeNull();
    expect(normalizeProductDescription("  Tecido natural  ")).toBe(
      "Tecido natural"
    );
    expect(normalizeProductDescription(null)).toBeNull();
  });

  it("derives active, archived, and terminal deleted lifecycle states", () => {
    expect(deriveProductLifecycle(null, null)).toBe("active");
    expect(deriveProductLifecycle(new Date(), null)).toBe("archived");
    expect(deriveProductLifecycle(new Date(), new Date())).toBe("deleted");
  });

  it("supports reversible archive and restore before terminal deletion", () => {
    expect(transitionProductLifecycle("active", "archive")).toEqual({
      changed: true,
      lifecycle: "archived",
    });
    expect(transitionProductLifecycle("archived", "archive")).toEqual({
      changed: false,
      lifecycle: "archived",
    });
    expect(transitionProductLifecycle("archived", "restore")).toEqual({
      changed: true,
      lifecycle: "active",
    });
    expect(transitionProductLifecycle("active", "restore")).toEqual({
      changed: false,
      lifecycle: "active",
    });
    expect(transitionProductLifecycle("active", "delete")).toEqual({
      changed: true,
      lifecycle: "deleted",
    });
    expect(transitionProductLifecycle("archived", "delete")).toEqual({
      changed: true,
      lifecycle: "deleted",
    });
    expect(transitionProductLifecycle("deleted", "delete")).toEqual({
      changed: false,
      lifecycle: "deleted",
    });
    expect(() => transitionProductLifecycle("deleted", "restore")).toThrow(
      ProductLifecycleError
    );
    expect(() => transitionProductLifecycle("deleted", "archive")).toThrow(
      ProductLifecycleError
    );
  });
});

describe("product text limits", () => {
  it("bounds name and description", () => {
    expect(normalizeProductName("n".repeat(200))).toHaveLength(200);
    expect(() => normalizeProductName("n".repeat(201))).toThrow(
      ProductNameError
    );
    expect(normalizeProductDescription("d".repeat(5000))).toHaveLength(5000);
    expect(() => normalizeProductDescription("d".repeat(5001))).toThrow(
      ProductDescriptionError
    );
  });
});

describe("forbidden characters in product text", () => {
  // the control characters but the tab and the line breaks (U+0000 PostgreSQL refuses in text) and the
  // controls that turn the direction of the text
  const forbidden = [
    "\u0000",
    "\u0001",
    "\u0008",
    "\u000B",
    "\u000C",
    "\u000E",
    "\u001B",
    "\u001F",
    "\u007F",
    "\u202A",
    "\u202B",
    "\u202C",
    "\u202D",
    "\u202E",
    "\u2066",
    "\u2067",
    "\u2068",
    "\u2069",
    // the marks of the direction, through the Unicode class Bidi_Control
    "\u061C",
    "\u200E",
    "\u200F",
  ];

  it.each(forbidden)("refuses %j in a name and in a description", (char) => {
    expect(() => normalizeProductName(`Bolsa${char}azul`)).toThrow(
      ProductNameError
    );
    expect(() => normalizeProductDescription(`Lona${char}forte`)).toThrow(
      ProductDescriptionError
    );
  });

  it.each(["\u200B", "\u200C\u200D", " \u2060 ", "\uFEFF", "\u200B \u200B"])(
    "refuses a name of only characters of zero width (%j)",
    (name) => {
      expect(() => normalizeProductName(name)).toThrow(ProductNameError);
    }
  );

  it("keeps a character of zero width inside a name that shows something", () => {
    // the joiner of an emoji, and a break opportunity inside a long word
    expect(normalizeProductName("Bolsa \u{1F469}\u200D\u{1F4BB}")).toBe(
      "Bolsa \u{1F469}\u200D\u{1F4BB}"
    );
    expect(normalizeProductName("\u200BBolsa")).toBe("\u200BBolsa");
    expect(normalizeProductDescription("\u200B")).toBe("\u200B");
  });

  it.each(["\t", "\n", "\r"])(
    "refuses %j inside a name, which is one line",
    (char) => {
      expect(() => normalizeProductName(`Bolsa${char}azul`)).toThrow(
        ProductNameError
      );
    }
  );

  it("keeps the neighbours of the forbidden ranges and the text as it came", () => {
    expect(normalizeProductName("Bolsa \u202F \u2029 \u2065 \u2070 x")).toBe(
      "Bolsa \u202F \u2029 \u2065 \u2070 x"
    );
    // a formula or HTML is text: nothing is neutralized on the way in
    expect(normalizeProductName("=SOMA(A1)")).toBe("=SOMA(A1)");
    expect(normalizeProductName("<script>x</script>")).toBe(
      "<script>x</script>"
    );
    expect(normalizeProductDescription("linha 1\nlinha 2\tfim")).toBe(
      "linha 1\nlinha 2\tfim"
    );
  });
});

describe("variant list price", () => {
  it("is optional and normalized to two decimals", () => {
    expect(normalizeVariantListPrice(null)).toBeNull();
    expect(normalizeVariantListPrice(undefined)).toBeNull();
    expect(normalizeVariantListPrice(" 49.9 ")).toBe("49.90");
    expect(normalizeVariantListPrice("0")).toBe("0.00");
    expect(normalizeVariantListPrice("1200")).toBe("1200.00");
    expect(normalizeVariantListPrice("007.50")).toBe("7.50");
  });

  it("rejects negatives, extra decimals, notation and huge amounts", () => {
    for (const price of [
      "-1",
      "1.234",
      "abc",
      "",
      " ",
      "1e3",
      "1,50",
      "$5",
      "1234567890123456",
      ".5",
    ]) {
      expect(() => normalizeVariantListPrice(price)).toThrow(
        InvalidVariantListPriceError
      );
    }
  });
});
