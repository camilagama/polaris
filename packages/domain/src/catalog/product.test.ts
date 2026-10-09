import { describe, expect, it } from "vitest";
import {
  deriveProductLifecycle,
  normalizeProductDescription,
  normalizeProductName,
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

  it("derives and changes the reversible lifecycle", () => {
    expect(deriveProductLifecycle(null)).toBe("active");
    expect(deriveProductLifecycle(new Date())).toBe("archived");
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
  });
});
