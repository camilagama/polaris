import { describe, expect, it } from "vitest";
import {
  CategoryLifecycleError,
  deriveCategoryLifecycle,
  normalizeCategoryName,
  transitionCategoryLifecycle,
} from "./category";

describe("catalog category rules", () => {
  it("trims category names and counts Unicode code points", () => {
    expect(normalizeCategoryName("  Escritório  ")).toBe("Escritório");
    expect(normalizeCategoryName("📚".repeat(100))).toBe("📚".repeat(100));
  });

  it("rejects empty names and names longer than 100 code points", () => {
    expect(() => normalizeCategoryName(" \t ")).toThrow(
      "invalid_category_name"
    );
    expect(() => normalizeCategoryName("x".repeat(101))).toThrow(
      "invalid_category_name"
    );
  });

  it("derives a deleted tombstone before considering its archived timestamp", () => {
    expect(deriveCategoryLifecycle(null, null)).toBe("active");
    expect(deriveCategoryLifecycle(new Date(), null)).toBe("archived");
    expect(deriveCategoryLifecycle(new Date(), new Date())).toBe("deleted");
  });

  it("archives and restores categories without changing a deleted tombstone", () => {
    expect(transitionCategoryLifecycle("active", "archive")).toEqual({
      changed: true,
      lifecycle: "archived",
    });
    expect(transitionCategoryLifecycle("archived", "restore")).toEqual({
      changed: true,
      lifecycle: "active",
    });
    expect(() => transitionCategoryLifecycle("deleted", "restore")).toThrow(
      CategoryLifecycleError
    );
  });

  it("is idempotent for repeated lifecycle commands and never hard-deletes", () => {
    expect(transitionCategoryLifecycle("archived", "archive")).toEqual({
      changed: false,
      lifecycle: "archived",
    });
    expect(transitionCategoryLifecycle("deleted", "delete")).toEqual({
      changed: false,
      lifecycle: "deleted",
    });
    expect(transitionCategoryLifecycle("active", "delete")).toEqual({
      changed: true,
      lifecycle: "deleted",
    });
  });
});
