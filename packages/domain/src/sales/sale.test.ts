import { describe, expect, it } from "vitest";
import {
  InvalidSaleSnapshotError,
  normalizeConfirmedSaleSnapshot,
  type SaleItemSnapshotInput,
} from "./sale";

const firstSaleItem: SaleItemSnapshotInput = {
  chargedUnitPrice: "89.9",
  listedUnitPrice: "100",
  productId: "0d7c2c5a-8f04-4f8d-89af-2d2f70ab5e38",
  productLabel: " Camiseta Azul ",
  quantity: 2,
  unitCost: "12.123456",
  variantId: "a34d3091-4ba8-49b0-9a40-e0ab8e0eb016",
};

describe("normalizeConfirmedSaleSnapshot", () => {
  it("normalizes BRL prices to cents and preserves the six-place cost snapshot", () => {
    expect(normalizeConfirmedSaleSnapshot({ items: [firstSaleItem] })).toEqual({
      currency: "BRL",
      items: [
        {
          ...firstSaleItem,
          chargedUnitPrice: "89.90",
          listedUnitPrice: "100.00",
          position: 0,
          productLabel: "Camiseta Azul",
        },
      ],
    });
  });

  it("retains an explicitly unknown cost as null", () => {
    expect(
      normalizeConfirmedSaleSnapshot({
        items: [{ ...firstSaleItem, unitCost: null }],
      }).items[0]?.unitCost
    ).toBeNull();
  });

  it("requires at least one item in a confirmed sale", () => {
    expect(() => normalizeConfirmedSaleSnapshot({ items: [] })).toThrow(
      InvalidSaleSnapshotError
    );
  });

  it("rejects nonpositive or fractional quantities", () => {
    expect(() =>
      normalizeConfirmedSaleSnapshot({
        items: [{ ...firstSaleItem, quantity: 0 }],
      })
    ).toThrow(InvalidSaleSnapshotError);
    expect(() =>
      normalizeConfirmedSaleSnapshot({
        items: [{ ...firstSaleItem, quantity: 1.5 }],
      })
    ).toThrow(InvalidSaleSnapshotError);
  });

  it("rejects negative prices and more than two fractional price digits", () => {
    expect(() =>
      normalizeConfirmedSaleSnapshot({
        items: [{ ...firstSaleItem, chargedUnitPrice: "-0.01" }],
      })
    ).toThrow(InvalidSaleSnapshotError);
    expect(() =>
      normalizeConfirmedSaleSnapshot({
        items: [{ ...firstSaleItem, listedUnitPrice: "100.001" }],
      })
    ).toThrow(InvalidSaleSnapshotError);
  });
});
