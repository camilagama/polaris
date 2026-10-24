import { describe, expect, it } from "vitest";
import { InventoryQuantityLimitError } from "./inventory";
import { InvalidInventoryCountInputError } from "./inventory-count";
import { InvalidUnitCostError } from "./inventory-cost";
import { normalizeOpeningStockInput } from "./opening-stock";
import { InvalidReceiveStockInputError } from "./receive-stock";

const base = {
  commandId: "0199C2D0-0000-7000-8000-0000000000A1",
  occurredOn: "2026-10-24",
  quantity: 5,
  unitCost: "12.5" as string | null,
  variantId: "0199c2d0-0000-7000-8000-0000000000b2",
};

describe("normalizeOpeningStockInput", () => {
  it("normalizes a stock with a cost the way a receipt does", () => {
    expect(normalizeOpeningStockInput(base)).toEqual({
      commandId: "0199c2d0-0000-7000-8000-0000000000a1",
      occurredOn: "2026-10-24",
      quantity: 5,
      unitCost: "12.500000",
      variantId: "0199c2d0-0000-7000-8000-0000000000b2",
    });
  });

  it("keeps a cost of zero as a cost", () => {
    expect(
      normalizeOpeningStockInput({ ...base, unitCost: "0" }).unitCost
    ).toBe("0.000000");
  });

  it("takes an unknown cost as null, validating the same quantity, date and IDs", () => {
    expect(normalizeOpeningStockInput({ ...base, unitCost: null })).toEqual({
      commandId: "0199c2d0-0000-7000-8000-0000000000a1",
      occurredOn: "2026-10-24",
      quantity: 5,
      unitCost: null,
      variantId: "0199c2d0-0000-7000-8000-0000000000b2",
    });
  });

  it("refuses a quantity below 1 or that is not whole, with or without cost", () => {
    for (const unitCost of ["1", null]) {
      for (const quantity of [0, -1, 1.5, Number.NaN]) {
        expect(() =>
          normalizeOpeningStockInput({ ...base, quantity, unitCost })
        ).toThrow(InvalidReceiveStockInputError);
      }
    }
  });

  it("refuses a quantity above the limit of the ledger", () => {
    for (const unitCost of ["1", null]) {
      expect(() =>
        normalizeOpeningStockInput({
          ...base,
          quantity: 2_147_483_648,
          unitCost,
        })
      ).toThrow(InventoryQuantityLimitError);
    }
    expect(
      normalizeOpeningStockInput({ ...base, quantity: 2_147_483_647 }).quantity
    ).toBe(2_147_483_647);
  });

  it("refuses a bad date or ID, and a cost that is not an amount", () => {
    expect(() =>
      normalizeOpeningStockInput({ ...base, occurredOn: "2026-13-40" })
    ).toThrow(InvalidReceiveStockInputError);
    expect(() =>
      normalizeOpeningStockInput({
        ...base,
        occurredOn: "2026-13-40",
        unitCost: null,
      })
    ).toThrow(InvalidInventoryCountInputError);
    expect(() =>
      normalizeOpeningStockInput({ ...base, unitCost: null, variantId: "nope" })
    ).toThrow(InvalidInventoryCountInputError);
    expect(() =>
      normalizeOpeningStockInput({ ...base, unitCost: "1,5" })
    ).toThrow(InvalidUnitCostError);
  });
});
