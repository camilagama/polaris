import { describe, expect, it } from "vitest";
import {
  deriveProductLifecycle,
  normalizeProductDescription,
  normalizeProductName,
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
