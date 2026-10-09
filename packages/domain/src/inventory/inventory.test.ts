import { describe, expect, it } from "vitest";
import {
  InsufficientStockError,
  InventoryQuantityLimitError,
  InvalidStockMovementError,
  projectInventoryQuantity,
  validateStockMovementType,
} from "./inventory";

describe("inventory quantity projection", () => {
  it("applies a signed integer delta", () => {
    expect(projectInventoryQuantity(0, 12)).toBe(12);
    expect(projectInventoryQuantity(12, -5)).toBe(7);
    expect(projectInventoryQuantity(12, -12)).toBe(0);
  });

  it("rejects a delta that would make the balance negative", () => {
    expect(() => projectInventoryQuantity(3, -4)).toThrow(
      InsufficientStockError
    );
  });

  it("rejects zero and non-integer movements", () => {
    expect(() => projectInventoryQuantity(0, 0)).toThrow(
      InvalidStockMovementError
    );
    expect(() => projectInventoryQuantity(1, 0.5)).toThrow(
      InvalidStockMovementError
    );
  });

  it("rejects quantities outside PostgreSQL integer range", () => {
    expect(() => projectInventoryQuantity(2_147_483_647, 1)).toThrow(
      InventoryQuantityLimitError
    );
    expect(() => projectInventoryQuantity(-1, 1)).toThrow(
      InvalidStockMovementError
    );
  });

  it("requires movement direction to match its named operation", () => {
    expect(() => validateStockMovementType("receipt", 2)).not.toThrow();
    expect(() => validateStockMovementType("receipt", -2)).toThrow(
      InvalidStockMovementError
    );
    expect(() => validateStockMovementType("sale", 2)).toThrow(
      InvalidStockMovementError
    );
    expect(() =>
      validateStockMovementType("inventory_count", -2)
    ).not.toThrow();
  });
});
