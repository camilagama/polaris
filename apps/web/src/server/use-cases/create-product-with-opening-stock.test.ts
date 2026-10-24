import { EntitlementLimitReachedError } from "@polaris/domain/billing/entitlements";
import {
  ProductIdConflictError,
  ProductNameError,
} from "@polaris/domain/catalog/product";
import { InvalidUnitCostError } from "@polaris/domain/inventory/inventory-cost";
import { InvalidReceiveStockInputError } from "@polaris/domain/inventory/receive-stock";
import { describe, expect, it, vi } from "vitest";
import {
  type CreateProductWithOpeningStockDependencies,
  type CreateProductWithOpeningStockInput,
  createProductWithOpeningStock,
  ProductCreateConflictError,
} from "./create-product-with-opening-stock";

// A role the central map does not give `inventory:adjust`: the real map has only "owner", which holds everything.
vi.mock("@polaris/domain/authorization/capabilities", () => ({
  hasCapabilityForRole: (role: string, capability: string) =>
    role === "owner" || (role === "seller" && capability === "product:create"),
}));

const productId = "0199c2d0-0000-7000-8000-0000000000b1";
const variantId = "0199c2d0-0000-7000-8000-0000000000b2";
const commandId = "0199c2d0-0000-7000-8000-0000000000a1";
const otherCommandId = "0199c2d0-0000-7000-8000-0000000000a2";
const today = "2026-10-24";

const owner = {
  capability: "product:create",
  organizationId: "org-1",
  role: "owner",
  userId: "user-1",
};
const seller = { ...owner, role: "seller" };

interface Movement {
  commandId: string;
  movementType: "inventory_count" | "receipt";
  quantity: number;
  unitCost: string | null;
}

interface Data {
  audit: string[];
  movements: Movement[];
  products: Map<
    string,
    {
      categoryId: string | null;
      description: string | null;
      listPrice: string | null;
      name: string;
      organizationId: string;
      sku: string | null;
      variantId: string;
    }
  >;
}

/**
 * An in-memory stand-in for the database with the two properties the use case relies on: what a transaction wrote
 * is kept only if it ends without an error (the rollback of ADR 0035), and transactions of one store run one after
 * the other (a second insert of the same ID waits for the first to commit, and then meets it).
 */
function createStore(options: { failStock?: boolean; limit?: number } = {}) {
  let committed: Data = { audit: [], movements: [], products: new Map() };
  let queue: Promise<unknown> = Promise.resolve();
  const writes = vi.fn();

  function copy(data: Data): Data {
    return {
      audit: [...data.audit],
      movements: data.movements.map((movement) => ({ ...movement })),
      products: new Map(
        [...data.products].map(([id, row]) => [id, { ...row }])
      ),
    };
  }

  function dependenciesFor(
    staged: Data
  ): CreateProductWithOpeningStockDependencies {
    return {
      createProduct: ((
        _tx: unknown,
        identity: { organizationId: string },
        input: {
          categoryId?: string | null;
          defaultVariantId?: string;
          description?: string | null;
          id?: string;
          listPrice?: string | null;
          name: string;
          sku?: string | null;
        }
      ) => {
        if (
          options.limit !== undefined &&
          staged.products.size >= options.limit
        ) {
          return Promise.reject(
            new EntitlementLimitReachedError(
              "variants.active.max",
              options.limit
            )
          );
        }
        const id = input.id ?? "generated-product";
        const existing = staged.products.get(id);
        if (existing) {
          return Promise.reject(new ProductIdConflictError());
        }
        writes("product", id);
        staged.products.set(id, {
          categoryId: input.categoryId ?? null,
          description: input.description ?? null,
          listPrice: input.listPrice ?? null,
          name: input.name,
          organizationId: identity.organizationId,
          sku: input.sku ?? null,
          variantId: input.defaultVariantId ?? "generated-variant",
        });
        staged.audit.push("product.created");
        return Promise.resolve({ id, name: input.name, version: 1 });
      }) as never,
      inventoryCount: ((_tx: unknown, _identity: unknown, input: never) => {
        const count = input as {
          commandId: string;
          expectedVersion: number;
          physicalQuantity: number;
          valuationUnitCost: string | null;
        };
        if (options.failStock) {
          return Promise.reject(new Error("stock_insert_failed"));
        }
        writes("count", count.commandId);
        staged.movements.push({
          commandId: count.commandId,
          movementType: "inventory_count",
          quantity: count.physicalQuantity,
          unitCost: null,
        });
        staged.audit.push("inventory.movement_recorded");
        return Promise.resolve({});
      }) as never,
      readProductCreation: ((
        _tx: unknown,
        identity: { organizationId: string },
        input: { productId: string }
      ) => {
        const row = staged.products.get(input.productId);
        if (!row || row.organizationId !== identity.organizationId) {
          return Promise.resolve(null);
        }
        const [first] = staged.movements;
        return Promise.resolve({
          opening: first
            ? { quantity: first.quantity, unitCost: first.unitCost }
            : null,
          product: {
            categoryId: row.categoryId,
            description: row.description,
            id: input.productId,
            name: row.name,
            version: 1,
          },
          variant: {
            id: row.variantId,
            listPrice: row.listPrice,
            sku: row.sku,
          },
        });
      }) as never,
      receiveStock: ((_tx: unknown, _identity: unknown, input: never) => {
        const receipt = input as {
          commandId: string;
          quantity: number;
          unitCost: string;
        };
        if (options.failStock) {
          return Promise.reject(new Error("stock_insert_failed"));
        }
        writes("receipt", receipt.commandId);
        staged.movements.push({
          commandId: receipt.commandId,
          movementType: "receipt",
          quantity: receipt.quantity,
          unitCost: receipt.unitCost,
        });
        staged.audit.push("inventory.movement_recorded");
        return Promise.resolve({});
      }) as never,
    };
  }

  function run<T>(
    identity: typeof owner,
    input: CreateProductWithOpeningStockInput,
    occurredOn = today
  ): Promise<T> {
    const attempt = queue.then(async () => {
      const staged = copy(committed);
      const result = await createProductWithOpeningStock(
        {} as never,
        identity,
        input,
        occurredOn,
        dependenciesFor(staged)
      );
      committed = staged;
      return result as T;
    });
    queue = attempt.catch(() => undefined);
    return attempt;
  }

  return {
    get data() {
      return committed;
    },
    run,
    writes,
  };
}

const named = {
  name: "Camiseta",
  productId,
  variantId,
} satisfies CreateProductWithOpeningStockInput;
const withStock = {
  ...named,
  initialStock: { commandId, quantity: 5, unitCost: "12.5" },
} satisfies CreateProductWithOpeningStockInput;
const withoutCost = {
  ...named,
  initialStock: { commandId, quantity: 5, unitCost: null },
} satisfies CreateProductWithOpeningStockInput;

describe("createProductWithOpeningStock", () => {
  describe("one transaction", () => {
    it("creates only the product when there is no stock", async () => {
      const store = createStore();
      const result = await store.run<{ initialQuantity: number }>(owner, named);
      expect(result.initialQuantity).toBe(0);
      expect(store.data.products.size).toBe(1);
      expect(store.data.movements).toEqual([]);
    });

    it("records a receipt with the cost when the cost is known", async () => {
      const store = createStore();
      await store.run(owner, withStock);
      expect(store.data.movements).toEqual([
        {
          commandId,
          movementType: "receipt",
          quantity: 5,
          unitCost: "12.500000",
        },
      ]);
    });

    it("records a count from zero, without cost, when the cost is unknown", async () => {
      const store = createStore();
      await store.run(owner, withoutCost);
      expect(store.data.movements).toEqual([
        {
          commandId,
          movementType: "inventory_count",
          quantity: 5,
          unitCost: null,
        },
      ]);
    });

    it("keeps a cost of zero as a known cost", async () => {
      const store = createStore();
      await store.run(owner, {
        ...named,
        initialStock: { commandId, quantity: 2, unitCost: "0" },
      });
      expect(store.data.movements).toEqual([
        {
          commandId,
          movementType: "receipt",
          quantity: 2,
          unitCost: "0.000000",
        },
      ]);
    });

    it("leaves no product, variant, balance, movement or audit event when the stock fails", async () => {
      const store = createStore({ failStock: true });
      await expect(store.run(owner, withStock)).rejects.toThrow(
        "stock_insert_failed"
      );
      expect(store.data.products.size).toBe(0);
      expect(store.data.movements).toEqual([]);
      expect(store.data.audit).toEqual([]);
      // the failure of the count, the other way to open the stock, undoes it just the same
      await expect(store.run(owner, withoutCost)).rejects.toThrow(
        "stock_insert_failed"
      );
      expect(store.data.products.size).toBe(0);
      expect(store.data.audit).toEqual([]);
    });

    it("validates the stock before the first write", async () => {
      const store = createStore();
      const bad = [
        { commandId, quantity: 0, unitCost: "1" },
        { commandId, quantity: 1.5, unitCost: "1" },
        { commandId, quantity: 2_147_483_648, unitCost: null },
        { commandId, quantity: 1, unitCost: "abc" },
        { commandId: "nope", quantity: 1, unitCost: null },
      ];
      for (const initialStock of bad) {
        // biome-ignore lint/performance/noAwaitInLoops: each probe is verified on its own
        await expect(
          store.run(owner, { ...named, initialStock })
        ).rejects.toBeInstanceOf(Error);
      }
      await expect(
        store.run(owner, withStock, "2026-13-40")
      ).rejects.toBeInstanceOf(InvalidReceiveStockInputError);
      await expect(
        store.run(owner, { ...withStock, name: "   " })
      ).rejects.toBeInstanceOf(ProductNameError);
      expect(store.writes).not.toHaveBeenCalled();
    });

    it("names the cost error of a stock it refuses", async () => {
      const store = createStore();
      await expect(
        store.run(owner, {
          ...named,
          initialStock: { commandId, quantity: 1, unitCost: "1,5" },
        })
      ).rejects.toBeInstanceOf(InvalidUnitCostError);
    });
  });

  describe("capabilities", () => {
    it("writes nothing, not even the product, for a role without inventory:adjust", async () => {
      const store = createStore();
      await expect(store.run(seller, withStock)).rejects.toMatchObject({
        code: "capability_denied",
      });
      await expect(store.run(seller, withoutCost)).rejects.toMatchObject({
        code: "capability_denied",
      });
      expect(store.writes).not.toHaveBeenCalled();
      expect(store.data.products.size).toBe(0);
    });

    it("lets that role create a product without stock", async () => {
      const store = createStore();
      await store.run(seller, named);
      expect(store.data.products.size).toBe(1);
    });

    it("refuses a role that has neither capability", async () => {
      const store = createStore();
      await expect(
        store.run({ ...owner, role: "guest" }, named)
      ).rejects.toMatchObject({ code: "capability_denied" });
      expect(store.writes).not.toHaveBeenCalled();
    });
  });

  describe("a repeat (the answer of the first try was lost)", () => {
    it("returns the stored product, writing nothing, when everything is equal", async () => {
      const store = createStore();
      await store.run(owner, withStock);
      const writesBefore = store.writes.mock.calls.length;
      const again = await store.run<{ repeated: boolean }>(owner, withStock);
      expect(again.repeated).toBe(true);
      expect(store.writes.mock.calls.length).toBe(writesBefore);
      expect(store.data.products.size).toBe(1);
      expect(store.data.movements).toHaveLength(1);
    });

    it("is equal when both have no stock", async () => {
      const store = createStore();
      await store.run(owner, named);
      const again = await store.run<{ repeated: boolean }>(owner, named);
      expect(again.repeated).toBe(true);
    });

    it("is equal when the cost is the same and unknown on both", async () => {
      const store = createStore();
      await store.run(owner, withoutCost);
      const again = await store.run<{ repeated: boolean }>(owner, withoutCost);
      expect(again.repeated).toBe(true);
      expect(store.data.movements).toHaveLength(1);
    });

    it("is equal under another command ID with the same stock, and the movement stays the recorded one", async () => {
      const store = createStore();
      await store.run(owner, withStock);
      const again = await store.run<{ repeated: boolean }>(owner, {
        ...withStock,
        initialStock: { ...withStock.initialStock, commandId: otherCommandId },
      });
      expect(again.repeated).toBe(true);
      expect(store.data.movements).toHaveLength(1);
      expect(store.data.movements[0]?.commandId).toBe(commandId);
    });

    it("never calls the stock commands on a repeat, and answers a conflict with the reason", async () => {
      const store = createStore();
      await store.run(owner, withStock);
      const callsBefore = store.writes.mock.calls.length;
      const conflicts = [
        { ...withStock, name: "Outra" },
        { ...withStock, listPrice: "9.90" },
        { ...withStock, categoryId: "0199c2d0-0000-7000-8000-0000000000c1" },
        {
          ...withStock,
          initialStock: { ...withStock.initialStock, quantity: 6 },
        },
        {
          ...withStock,
          initialStock: { ...withStock.initialStock, unitCost: "13" },
        },
        {
          ...withStock,
          initialStock: { ...withStock.initialStock, unitCost: null },
        },
        named,
        {
          ...withStock,
          initialStock: {
            ...withStock.initialStock,
            commandId: otherCommandId,
            quantity: 9,
          },
        },
      ];
      for (const input of conflicts) {
        // biome-ignore lint/performance/noAwaitInLoops: each conflict is verified on its own
        await expect(store.run(owner, input)).rejects.toBeInstanceOf(
          ProductCreateConflictError
        );
      }
      await expect(store.run(owner, withStock)).resolves.toBeDefined();
      expect(store.writes.mock.calls.length).toBe(callsBefore);
    });

    it("is a conflict to send stock now that was not there before", async () => {
      const store = createStore();
      await store.run(owner, named);
      await expect(store.run(owner, withStock)).rejects.toMatchObject({
        code: "product_create_conflict",
      });
    });

    it("compares the price as the amount, not as the text", async () => {
      const store = createStore();
      await store.run(owner, { ...named, listPrice: "49.9" });
      const again = await store.run<{ repeated: boolean }>(owner, {
        ...named,
        listPrice: "49.90",
      });
      expect(again.repeated).toBe(true);
    });

    it("answers the plan's limit as a repeat when the stored product is the one that filled it", async () => {
      const store = createStore({ limit: 1 });
      await store.run(owner, withStock);
      const again = await store.run<{ repeated: boolean }>(owner, withStock);
      expect(again.repeated).toBe(true);
    });

    it("answers the plan's limit as the limit when the product is not stored", async () => {
      const store = createStore({ limit: 1 });
      await store.run(owner, named);
      await expect(
        store.run(owner, {
          ...named,
          productId: "0199c2d0-0000-7000-8000-0000000000d1",
          variantId: "0199c2d0-0000-7000-8000-0000000000d2",
        })
      ).rejects.toBeInstanceOf(EntitlementLimitReachedError);
    });

    it("gives the conflict of today for a product ID that belongs to another store", async () => {
      const store = createStore();
      await store.run(owner, named);
      // the ID is taken, but the row is not this store's to read: it is not told apart from a repeat
      await expect(
        store.run({ ...owner, organizationId: "org-2" }, named)
      ).rejects.toBeInstanceOf(ProductIdConflictError);
    });

    it("lets two concurrent calls with the same product ID write once: one creates, the other repeats", async () => {
      const store = createStore();
      const [first, second] = await Promise.all([
        store.run<{ repeated: boolean }>(owner, withStock),
        store.run<{ repeated: boolean }>(owner, withStock),
      ]);
      expect([first.repeated, second.repeated].sort()).toEqual([false, true]);
      expect(store.data.products.size).toBe(1);
      expect(store.data.movements).toHaveLength(1);
    });

    it("lets two concurrent calls with the same product ID and different data write once and refuse the other", async () => {
      const store = createStore();
      const results = await Promise.allSettled([
        store.run(owner, withStock),
        store.run(owner, {
          ...withStock,
          initialStock: { ...withStock.initialStock, quantity: 7 },
        }),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual([
        "fulfilled",
        "rejected",
      ]);
      const rejected = results.find((result) => result.status === "rejected");
      expect(
        rejected && "reason" in rejected ? rejected.reason : null
      ).toBeInstanceOf(ProductCreateConflictError);
      expect(store.data.movements).toHaveLength(1);
    });
  });
});
