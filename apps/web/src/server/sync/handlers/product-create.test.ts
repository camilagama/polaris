import {
  ProductCategoryUnavailableError,
  ProductIdConflictError,
  ProductNameError,
  ProductVariantSkuConflictError,
} from "@polaris/domain/catalog/product";
import { InventoryOccurredInFutureError } from "@polaris/domain/inventory/inventory";
import { InvalidUnitCostError } from "@polaris/domain/inventory/inventory-cost";
import { describe, expect, it, vi } from "vitest";
import { ProductCreateConflictError } from "../../use-cases/create-product-with-opening-stock";
import { InvalidSyncPayloadError } from "../push";
import { createProductCreateHandler } from "./product-create";

const productId = "0199c2d0-0000-7000-8000-0000000000b1";
const variantId = "0199c2d0-0000-7000-8000-0000000000b2";
const categoryId = "0199c2d0-0000-7000-8000-0000000000b3";
const commandId = "0199c2d0-0000-7000-8000-0000000000a1";
const identity = {
  capability: "sync:push",
  organizationId: "org-1",
  role: "owner",
  userId: "user-1",
};

function handlerWith(
  createProduct = vi.fn(() => Promise.resolve({ id: productId, version: 1 })),
  receiveStock = vi.fn(() => Promise.resolve({})),
  inventoryCount = vi.fn(() => Promise.resolve({}))
) {
  return {
    createProduct,
    handler: createProductCreateHandler({
      createProduct: createProduct as never,
      inventoryCount: inventoryCount as never,
      receiveStock: receiveStock as never,
    }),
    inventoryCount,
    receiveStock,
  };
}

const minimal = { name: "Camiseta", productId, variantId };
const stock = { occurredOn: "2026-10-14", quantity: 5, unitCost: "12.5" };

describe("product.create handler", () => {
  it("declares its type and capability", () => {
    const { handler } = handlerWith();
    expect(handler.type).toBe("product.create");
    expect(handler.capability).toBe("product:create");
  });

  it("asks for inventory:adjust only when opening stock is sent", () => {
    const { handler } = handlerWith();
    const plain = handler.parse(minimal);
    const withStock = handler.parse({ ...minimal, initialStock: stock });
    expect(handler.extraCapabilities?.(plain)).toEqual([]);
    expect(handler.extraCapabilities?.(withStock)).toEqual([
      "inventory:adjust",
    ]);
  });

  it("fills optional fields with null", () => {
    const { handler } = handlerWith();
    expect(handler.parse(minimal)).toEqual({
      categoryId: null,
      description: null,
      initialStock: null,
      listPrice: null,
      name: "Camiseta",
      productId,
      sku: null,
      variantId,
    });
  });

  it("refuses payloads the command cannot take", () => {
    const { handler } = handlerWith();
    const bad: unknown[] = [
      null,
      "x",
      [],
      {},
      { ...minimal, productId: "nope" },
      { ...minimal, variantId: undefined },
      { ...minimal, name: 3 },
      { ...minimal, name: "   " },
      { ...minimal, name: "x".repeat(300) },
      { ...minimal, categoryId: "nope" },
      { ...minimal, sku: 4 },
      { ...minimal, listPrice: "12,50" },
      { ...minimal, initialStock: "x" },
      { ...minimal, initialStock: { ...stock, quantity: "5" } },
      { ...minimal, initialStock: { ...stock, quantity: 0 } },
      { ...minimal, initialStock: { ...stock, quantity: 1.5 } },
      { ...minimal, initialStock: { ...stock, unitCost: "abc" } },
      { ...minimal, initialStock: { ...stock, occurredOn: "14/10/2026" } },
    ];
    for (const payload of bad) {
      expect(() => handler.parse(payload)).toThrow(InvalidSyncPayloadError);
    }
  });

  it("creates the product with the device's IDs and no stock when none was sent", async () => {
    const { createProduct, handler, receiveStock } = handlerWith();
    const payload = handler.parse({
      ...minimal,
      categoryId,
      description: "Algodão",
      listPrice: "49.90",
      sku: "CAM-01",
    });
    const result = await handler.execute({} as never, identity, payload, {
      baseVersion: null,
      commandId,
    });
    expect(createProduct).toHaveBeenCalledWith({}, identity, {
      categoryId,
      defaultVariantId: variantId,
      description: "Algodão",
      id: productId,
      listPrice: "49.90",
      name: "Camiseta",
      requestId: commandId,
      sku: "CAM-01",
    });
    expect(receiveStock).not.toHaveBeenCalled();
    expect(result).toEqual({
      initialQuantity: 0,
      productId,
      variantId,
      version: 1,
    });
  });

  it("receives the opening stock in the same transaction, as an inventory adjustment", async () => {
    const { handler, receiveStock } = handlerWith();
    const payload = handler.parse({ ...minimal, initialStock: stock });
    const transaction = {} as never;
    const result = await handler.execute(transaction, identity, payload, {
      baseVersion: null,
      commandId,
    });
    expect(receiveStock).toHaveBeenCalledWith(
      transaction,
      { ...identity, capability: "inventory:adjust" },
      {
        commandId,
        commandVersion: 1,
        occurredOn: "2026-10-14",
        quantity: 5,
        requestId: commandId,
        unitCost: "12.500000",
        variantId,
      }
    );
    expect(result).toMatchObject({ initialQuantity: 5 });
  });

  it("opens the stock as a count from zero when the cost is unknown (a receipt always carries a cost)", async () => {
    const { handler, inventoryCount, receiveStock } = handlerWith();
    const payload = handler.parse({
      ...minimal,
      initialStock: { ...stock, unitCost: null },
    });
    const transaction = {} as never;
    const result = await handler.execute(transaction, identity, payload, {
      baseVersion: null,
      commandId,
    });
    expect(receiveStock).not.toHaveBeenCalled();
    expect(inventoryCount).toHaveBeenCalledWith(
      transaction,
      { ...identity, capability: "inventory:adjust" },
      {
        commandId,
        commandVersion: 1,
        expectedVersion: 0,
        occurredOn: "2026-10-14",
        physicalQuantity: 5,
        requestId: commandId,
        valuationUnitCost: null,
        variantId,
      }
    );
    expect(result).toMatchObject({ initialQuantity: 5 });
  });

  it("still asks for inventory:adjust when the cost is unknown", () => {
    const { handler } = handlerWith();
    const payload = handler.parse({
      ...minimal,
      initialStock: { ...stock, unitCost: null },
    });
    expect(handler.extraCapabilities?.(payload)).toEqual(["inventory:adjust"]);
  });

  it("refuses an unknown cost with a quantity the ledger would refuse", () => {
    const { handler } = handlerWith();
    for (const quantity of [0, -1, 1.5, 2_147_483_648]) {
      expect(() =>
        handler.parse({
          ...minimal,
          initialStock: { ...stock, quantity, unitCost: null },
        })
      ).toThrow(InvalidSyncPayloadError);
    }
  });

  it("does not take the stock if the product was refused", async () => {
    const { handler, receiveStock } = handlerWith(
      vi.fn(() => Promise.reject(new ProductVariantSkuConflictError()))
    );
    const payload = handler.parse({ ...minimal, initialStock: stock });
    await expect(
      handler.execute({} as never, identity, payload, {
        baseVersion: null,
        commandId,
      })
    ).rejects.toBeInstanceOf(ProductVariantSkuConflictError);
    expect(receiveStock).not.toHaveBeenCalled();
  });

  it("classifies the expected refusals, and nothing else", () => {
    const { handler } = handlerWith();
    expect(handler.classify(new ProductIdConflictError())).toBe(
      "product_id_conflict"
    );
    expect(handler.classify(new ProductCreateConflictError())).toBe(
      "product_id_conflict"
    );
    expect(handler.classify(new ProductVariantSkuConflictError())).toBe(
      "sku_conflict"
    );
    expect(handler.classify(new ProductCategoryUnavailableError())).toBe(
      "category_unavailable"
    );
    expect(handler.classify(new InventoryOccurredInFutureError())).toBe(
      "inventory_date_in_future"
    );
    expect(handler.classify(new ProductNameError())).toBe("invalid_payload");
    expect(handler.classify(new InvalidUnitCostError())).toBe(
      "invalid_payload"
    );
    expect(handler.classify(new Error("db down"))).toBeNull();
  });
});
