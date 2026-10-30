import type { InventoryBalanceEntryReadModel } from "@polaris/contracts";
import { describe, expect, it } from "vitest";
import {
  retarget,
  type StockTarget,
  stockTarget,
  targetBalanceText,
} from "./stock-target";

const NOW = new Date(2026, 9, 29, 12, 0);
// built from local parts: the text is the device's time zone, whatever it is
const moved = new Date(2026, 9, 14, 9, 0).toISOString();

function target(overrides: Partial<StockTarget> = {}): StockTarget {
  return {
    archived: false,
    movingAverageCost: "62.400000",
    productName: "Calça jeans",
    quantity: 5,
    updatedAt: moved,
    variantId: "v1",
    variantText: "42",
    version: 1,
    ...overrides,
  };
}

describe("targetBalanceText", () => {
  it("says the balance, the average cost and the last movement", () => {
    expect(targetBalanceText(target(), NOW)).toBe(
      "Saldo atual: 5 · custo médio R$ 62,40 · último movimento 14/10 09:00"
    );
  });

  it("writes the year of a movement from another year", () => {
    expect(
      targetBalanceText(
        target({ updatedAt: new Date(2025, 9, 14, 9, 0).toISOString() }),
        NOW
      )
    ).toBe(
      "Saldo atual: 5 · custo médio R$ 62,40 · último movimento 14/10/2025 09:00"
    );
  });

  it("writes the year across New Year's Eve, by the device's own calendar", () => {
    const afterMidnight = new Date(2026, 0, 1, 0, 30);
    expect(
      targetBalanceText(
        target({ updatedAt: new Date(2025, 11, 31, 23, 30).toISOString() }),
        afterMidnight
      )
    ).toContain("último movimento 31/12/2025 23:30");
    expect(
      targetBalanceText(
        target({ updatedAt: new Date(2026, 0, 1, 0, 10).toISOString() }),
        afterMidnight
      )
    ).toContain("último movimento 01/01 00:10");
  });

  it("says an unknown cost and a variant that never moved", () => {
    expect(
      targetBalanceText(
        target({ movingAverageCost: null, updatedAt: null }),
        NOW
      )
    ).toBe("Saldo atual: 5 · custo médio desconhecido · sem movimentos");
  });

  it("says no date it does not have", () => {
    expect(targetBalanceText(target({ updatedAt: undefined }), NOW)).toBe(
      "Saldo atual: 5 · custo médio R$ 62,40"
    );
    expect(targetBalanceText(target({ updatedAt: "not a date" }), NOW)).toBe(
      "Saldo atual: 5 · custo médio R$ 62,40"
    );
  });

  it("is the device's balance without a connection, with no cost and no date", () => {
    expect(targetBalanceText(target({ costUnavailable: true }), NOW)).toBe(
      "Saldo do aparelho: 5 · custo médio só com conexão"
    );
  });

  it("thousands in the balance", () => {
    expect(targetBalanceText(target({ quantity: 1234 }), NOW)).toContain(
      "Saldo atual: 1.234 ·"
    );
  });
});

describe("the target of the panel", () => {
  const entry = {
    movingAverageCost: "1.000000",
    productName: "P",
    productStatus: "active",
    quantity: 2,
    updatedAt: moved,
    values: [],
    isDefaultVariant: true,
    variantId: "v1",
    version: 1,
  } as unknown as InventoryBalanceEntryReadModel;

  it("takes the date of the list", () => {
    expect(stockTarget(entry).updatedAt).toBe(moved);
  });

  it("loses the date when a newer balance replaces it: the balance read has none", () => {
    const next = retarget(stockTarget(entry), {
      movingAverageCost: "2.000000",
      quantity: 7,
      variantId: "v1",
      version: 2,
    });
    expect(next).not.toHaveProperty("updatedAt");
    expect(next.quantity).toBe(7);
  });
});
