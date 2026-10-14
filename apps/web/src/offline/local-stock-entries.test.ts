import type {
  LocalInventoryReadModel,
  LocalProductReadModel,
  LocalVariantReadModel,
} from "@polaris/contracts";
import { describe, expect, it } from "vitest";
import {
  filterLocalStockEntries,
  type LocalCatalogRows,
  localStockEntries,
} from "./local-stock-entries";
import type { OutboxCommand } from "./outbox/command";

const AT = "2026-10-14T12:00:00.000Z";
const uuid = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

const product = (
  n: number,
  name: string,
  overrides: Partial<LocalProductReadModel> = {}
): LocalProductReadModel => ({
  archivedAt: null,
  categoryId: null,
  deletedAt: null,
  description: null,
  id: uuid(n),
  name,
  updatedAt: AT,
  version: 1,
  ...overrides,
});
const variant = (
  n: number,
  productN: number,
  overrides: Partial<LocalVariantReadModel> = {}
): LocalVariantReadModel => ({
  id: uuid(n),
  isDefault: true,
  listPrice: "50.00",
  position: null,
  productId: uuid(productN),
  sku: null,
  values: [],
  ...overrides,
});
const stock = (
  variantN: number,
  productN: number,
  quantity: number,
  version = 1
): LocalInventoryReadModel => ({
  productId: uuid(productN),
  quantity,
  updatedAt: AT,
  variantId: uuid(variantN),
  version,
});
const sale = (variantN: number, quantity: number): OutboxCommand =>
  ({
    attempts: 0,
    baseVersion: null,
    commandId: uuid(900 + variantN),
    createdAt: AT,
    deviceId: uuid(1),
    lastAttemptAt: null,
    lease: "x",
    organizationId: "org",
    payload: { items: [{ quantity, variantId: uuid(variantN) }] },
    rejection: null,
    seq: 1,
    status: "pending",
    type: "sale.confirm",
  }) as unknown as OutboxCommand;

function rows(overrides: Partial<LocalCatalogRows> = {}): LocalCatalogRows {
  return {
    commands: [],
    inventory: [stock(11, 1, 5), stock(12, 2, 0), stock(13, 2, 3)],
    products: [
      product(1, "Camiseta"),
      product(2, "Calça Jeans"),
      product(3, "Antiga", { archivedAt: AT }),
      product(4, "Apagada", { deletedAt: AT }),
    ],
    variants: [
      variant(11, 1),
      variant(12, 2, {
        isDefault: false,
        sku: "JEANS-P",
        values: [{ optionName: "Tamanho", optionValueName: "P" }],
      }),
      variant(13, 2, {
        isDefault: false,
        sku: "JEANS-M",
        values: [{ optionName: "Tamanho", optionValueName: "M" }],
      }),
      variant(14, 3),
      variant(15, 4),
    ],
    ...overrides,
  };
}

describe("local stock entries", () => {
  it("joins products, variants and balances, never shows deleted products, and never carries a cost", () => {
    const entries = localStockEntries(rows());
    // by product name, then variant id: Antiga, Calça Jeans (P, M), Camiseta
    expect(entries.map((entry) => entry.variantId)).toEqual([
      uuid(14),
      uuid(12),
      uuid(13),
      uuid(11),
    ]);
    for (const entry of entries) {
      expect(entry.movingAverageCost).toBeNull();
    }
    const archived = entries.find((entry) => entry.variantId === uuid(14));
    expect(archived).toMatchObject({
      productStatus: "archived",
      quantity: 0,
      updatedAt: null,
      version: 0,
    });
  });

  it("counts a queued sale against the balance and moves the version", () => {
    const entries = localStockEntries(rows({ commands: [sale(11, 2)] }));
    expect(entries.find((entry) => entry.variantId === uuid(11))).toMatchObject(
      { quantity: 3, version: 2 }
    );
  });

  it("filters like the server: active only, text over product, option and SKU (accents and case aside), stock, ids and limit", () => {
    const entries = localStockEntries(rows());
    const names = (found: { entries: { variantId: string }[] }) =>
      found.entries.map((entry) => entry.variantId).sort();

    expect(
      names(filterLocalStockEntries(entries, { productStatus: "active" }))
    ).toEqual([uuid(11), uuid(12), uuid(13)].sort());
    expect(
      names(filterLocalStockEntries(entries, { productStatus: "all" }))
    ).toContain(uuid(14));
    expect(
      names(
        filterLocalStockEntries(entries, {
          productStatus: "active",
          query: "calca m",
        })
      )
    ).toEqual([uuid(13)]);
    expect(
      names(
        filterLocalStockEntries(entries, {
          productStatus: "active",
          query: "jeans-p",
        })
      )
    ).toEqual([uuid(12)]);
    expect(
      names(
        filterLocalStockEntries(entries, {
          productStatus: "active",
          stock: "without_stock",
        })
      )
    ).toEqual([uuid(12)]);
    expect(
      names(
        filterLocalStockEntries(entries, {
          productStatus: "all",
          variantIds: [uuid(14), uuid(11)],
        })
      )
    ).toEqual([uuid(11), uuid(14)].sort());
    const limited = filterLocalStockEntries(entries, {
      limit: 2,
      productStatus: "active",
    });
    expect(limited.entries).toHaveLength(2);
    expect(limited.more).toBe(true);
  });
});
