import { describe, expect, it } from "vitest";
import { InventoryQuantityLimitError } from "./inventory";
import {
  InvalidInventoryCountInputError,
  normalizeInventoryCountInput,
  UnsupportedInventoryCountCommandVersionError,
} from "./inventory-count";
import { InvalidUnitCostError } from "./inventory-cost";

const validInput = {
  commandId: "0199c2d0-0000-7000-8000-000000000003",
  commandVersion: 1,
  expectedVersion: 0,
  occurredOn: "2026-10-09",
  physicalQuantity: 3,
  variantId: "0199c2d0-0000-7000-8000-000000000002",
};

describe("inventoryCount command input", () => {
  it("normalizes a versioned command and optional valuation cost", () => {
    expect(
      normalizeInventoryCountInput({
        ...validInput,
        commandId: validInput.commandId.toUpperCase(),
        valuationUnitCost: " 12.34 ",
        variantId: validInput.variantId.toUpperCase(),
      })
    ).toEqual({
      ...validInput,
      valuationUnitCost: "12.340000",
    });
  });

  it("accepts a zero physical count and an optional valuation cost only for positive stock", () => {
    expect(
      normalizeInventoryCountInput({ ...validInput, physicalQuantity: 0 })
        .physicalQuantity
    ).toBe(0);
    expect(() =>
      normalizeInventoryCountInput({
        ...validInput,
        physicalQuantity: 0,
        valuationUnitCost: "1.00",
      })
    ).toThrow(InvalidInventoryCountInputError);
  });

  it("rejects invalid identity, version, date, and quantity", () => {
    expect(() =>
      normalizeInventoryCountInput({ ...validInput, commandId: "not-a-uuid" })
    ).toThrow(InvalidInventoryCountInputError);
    expect(() =>
      normalizeInventoryCountInput({ ...validInput, expectedVersion: -1 })
    ).toThrow(InvalidInventoryCountInputError);
    expect(() =>
      normalizeInventoryCountInput({ ...validInput, expectedVersion: 1.5 })
    ).toThrow(InvalidInventoryCountInputError);
    expect(() =>
      normalizeInventoryCountInput({ ...validInput, occurredOn: "2026-02-29" })
    ).toThrow(InvalidInventoryCountInputError);
    expect(() =>
      normalizeInventoryCountInput({ ...validInput, physicalQuantity: -1 })
    ).toThrow(InvalidInventoryCountInputError);
    expect(() =>
      normalizeInventoryCountInput({
        ...validInput,
        physicalQuantity: 2_147_483_648,
      })
    ).toThrow(InventoryQuantityLimitError);
  });

  it("rejects invalid optional cost and unsupported command versions", () => {
    expect(() =>
      normalizeInventoryCountInput({
        ...validInput,
        valuationUnitCost: "1.1234567",
      })
    ).toThrow(InvalidUnitCostError);
    expect(() =>
      normalizeInventoryCountInput({ ...validInput, commandVersion: 2 })
    ).toThrow(UnsupportedInventoryCountCommandVersionError);
  });
});
