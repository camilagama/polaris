import { ProductDeletedError } from "@polaris/domain/catalog/product";
import {
  InsufficientStockError,
  InventoryOccurredInFutureError,
  InventoryVariantNotFoundError,
  InventoryVersionConflictError,
} from "@polaris/domain/inventory/inventory";
import { InventoryCostUnavailableError } from "@polaris/domain/inventory/inventory-cost";
import { describe, expect, it, vi } from "vitest";
import { InvalidSyncPayloadError } from "../push";
import {
  createStockCountHandler,
  createStockReceiveHandler,
  createStockWriteOffHandler,
} from "./stock-commands";

const variantId = "0199c2d0-0000-7000-8000-0000000000b2";
const commandId = "0199c2d0-0000-7000-8000-0000000000a1";
const identity = {
  capability: "sync:push",
  organizationId: "org-1",
  role: "owner",
  userId: "user-1",
};
const adjusting = { ...identity, capability: "inventory:adjust" };
const balance = { balance: { quantity: 9, version: 4 } };

describe("stock.receive handler", () => {
  const receive = {
    occurredOn: "2026-10-14",
    quantity: 5,
    unitCost: "8.5",
    variantId,
  };

  it("declares its type and the inventory capability", () => {
    const handler = createStockReceiveHandler();
    expect(handler.type).toBe("stock.receive");
    expect(handler.capability).toBe("inventory:adjust");
  });

  it("refuses payloads the repository would refuse", () => {
    const handler = createStockReceiveHandler();
    const bad: unknown[] = [
      null,
      [],
      {},
      { ...receive, variantId: "nope" },
      { ...receive, quantity: "5" },
      { ...receive, quantity: 0 },
      { ...receive, quantity: 1.5 },
      { ...receive, unitCost: "abc" },
      { ...receive, unitCost: 8.5 },
      { ...receive, occurredOn: "2026-02-30" },
    ];
    for (const payload of bad) {
      expect(() => handler.parse(payload)).toThrow(InvalidSyncPayloadError);
    }
  });

  it("receives under the inventory identity with the command ID, and returns the balance", async () => {
    const receiveStock = vi.fn(() => Promise.resolve(balance));
    const handler = createStockReceiveHandler({
      receiveStock: receiveStock as never,
    });
    const result = await handler.execute(
      {} as never,
      identity,
      handler.parse(receive),
      { baseVersion: null, commandId }
    );
    expect(receiveStock).toHaveBeenCalledWith({}, adjusting, {
      commandId,
      commandVersion: 1,
      occurredOn: "2026-10-14",
      quantity: 5,
      requestId: commandId,
      unitCost: "8.5",
      variantId,
    });
    expect(result).toEqual({ quantity: 9, variantId, version: 4 });
  });

  it("names the refusals for the device, and nothing else", () => {
    const { classify } = createStockReceiveHandler();
    expect(classify(new InventoryOccurredInFutureError())).toBe(
      "inventory_date_in_future"
    );
    expect(classify(new InventoryVariantNotFoundError())).toBe(
      "variant_not_found"
    );
    expect(classify(new ProductDeletedError())).toBe("product_deleted");
    expect(classify(new Error("db down"))).toBeNull();
  });
});

describe("stock.write_off handler", () => {
  const writeOff = {
    occurredOn: "2026-10-14",
    quantity: 2,
    reasonCode: "damaged",
    variantId,
  };

  it("takes a reason code, a note only when given, and needs a note for 'other'", () => {
    const handler = createStockWriteOffHandler();
    expect(handler.parse(writeOff)).toEqual({ ...writeOff, reasonNote: null });
    expect(
      handler.parse({
        ...writeOff,
        reasonCode: "other",
        reasonNote: "Enchente",
      })
    ).toMatchObject({ reasonCode: "other", reasonNote: "Enchente" });
    for (const payload of [
      { ...writeOff, reasonCode: "other" },
      { ...writeOff, reasonCode: "because" },
      { ...writeOff, quantity: 0 },
      { ...writeOff, reasonNote: 5 },
    ]) {
      expect(() => handler.parse(payload)).toThrow(InvalidSyncPayloadError);
    }
  });

  it("writes off under the inventory identity", async () => {
    const writeOffStock = vi.fn(() => Promise.resolve(balance));
    const handler = createStockWriteOffHandler({
      writeOffStock: writeOffStock as never,
    });
    await handler.execute({} as never, identity, handler.parse(writeOff), {
      baseVersion: null,
      commandId,
    });
    expect(writeOffStock).toHaveBeenCalledWith({}, adjusting, {
      commandId,
      commandVersion: 1,
      occurredOn: "2026-10-14",
      quantity: 2,
      reasonCode: "damaged",
      reasonNote: null,
      requestId: commandId,
      variantId,
    });
  });

  it("refuses a write-off that would leave negative stock, with its own code", () => {
    expect(
      createStockWriteOffHandler().classify(new InsufficientStockError())
    ).toBe("insufficient_stock");
  });
});

describe("stock.count handler", () => {
  const count = { occurredOn: "2026-10-14", physicalQuantity: 7, variantId };

  it("accepts a physical quantity of zero and an optional valuation cost", () => {
    const handler = createStockCountHandler();
    expect(handler.parse({ ...count, physicalQuantity: 0 })).toMatchObject({
      physicalQuantity: 0,
      valuationUnitCost: null,
    });
    expect(handler.parse({ ...count, valuationUnitCost: "3" })).toMatchObject({
      valuationUnitCost: "3",
    });
    for (const payload of [
      { ...count, physicalQuantity: -1 },
      { ...count, physicalQuantity: 1.2 },
      { ...count, physicalQuantity: 0, valuationUnitCost: "3" },
      { ...count, valuationUnitCost: "abc" },
    ]) {
      expect(() => handler.parse(payload)).toThrow(InvalidSyncPayloadError);
    }
  });

  it("counts against the base version the device sent", async () => {
    const inventoryCount = vi.fn(() => Promise.resolve(balance));
    const handler = createStockCountHandler({
      inventoryCount: inventoryCount as never,
    });
    await handler.execute({} as never, identity, handler.parse(count), {
      baseVersion: 3,
      commandId,
    });
    expect(inventoryCount).toHaveBeenCalledWith({}, adjusting, {
      commandId,
      commandVersion: 1,
      expectedVersion: 3,
      occurredOn: "2026-10-14",
      physicalQuantity: 7,
      requestId: commandId,
      valuationUnitCost: null,
      variantId,
    });
  });

  it("refuses a count that carries no base version, before touching stock", async () => {
    const inventoryCount = vi.fn();
    const handler = createStockCountHandler({
      inventoryCount: inventoryCount as never,
    });
    await expect(
      handler.execute({} as never, identity, handler.parse(count), {
        baseVersion: null,
        commandId,
      })
    ).rejects.toBeInstanceOf(InvalidSyncPayloadError);
    expect(inventoryCount).not.toHaveBeenCalled();
    expect(handler.classify(new InvalidSyncPayloadError())).toBe(
      "invalid_payload"
    );
  });

  it("names a stale count and a missing cost", () => {
    const { classify } = createStockCountHandler();
    expect(classify(new InventoryVersionConflictError())).toBe(
      "inventory_version_conflict"
    );
    expect(classify(new InventoryCostUnavailableError())).toBe(
      "inventory_cost_unavailable"
    );
  });
});
