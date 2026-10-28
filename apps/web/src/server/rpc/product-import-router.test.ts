import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import {
  PRODUCT_IMPORT_BATCH_MAX_ROWS,
  type ProductImportRowInput,
  type ProductImportRowResult,
} from "@polaris/contracts";
import { TenantAuthorizationError } from "@polaris/db/tenant-transaction";
import { EntitlementLimitReachedError } from "@polaris/domain/billing/entitlements";
import { ProductIdConflictError } from "@polaris/domain/catalog/product";
import { InventoryCostLimitError } from "@polaris/domain/inventory/inventory-cost";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServerApp } from "../app";
import type { WorkerBindings } from "../environment";
import {
  type CreateProductWithOpeningStockDependencies,
  createProductWithOpeningStock,
} from "../use-cases/create-product-with-opening-stock";
import { createRpcRouter } from "./router";

const testBindings = {
  BETTER_AUTH_BASE_URL: "https://polaris.example.invalid",
  BETTER_AUTH_SECRET: "a".repeat(32),
  HYPERDRIVE: { connectionString: "postgresql://test.invalid/neondb" },
  ONBOARDING_HYPERDRIVE: {
    connectionString: "postgresql://onboarding.invalid/neondb",
  },
} satisfies WorkerBindings;

const organizationId = "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0";
const importId = "0199c2d0-0000-7000-8000-00000000f001";
const identity = {
  capability: "product:create",
  organizationId,
  role: "owner",
  userId: "verified-session-user",
};
const today = "2026-10-27";

interface StoredProduct {
  archived: boolean;
  categoryId: string | null;
  deleted: boolean;
  description: string | null;
  listPrice: string | null;
  name: string;
  variantId: string;
}

interface Movement {
  commandId: string;
  occurredOn: string;
  quantity: number;
  unitCost: string | null;
  variantId: string;
}

interface Data {
  movements: Movement[];
  products: Map<string, StoredProduct>;
}

function copy(data: Data): Data {
  return {
    movements: data.movements.map((movement) => ({ ...movement })),
    products: new Map(
      [...data.products].map(([id, product]) => [id, { ...product }])
    ),
  };
}

/** The key the database compares names by: case and repeated spaces do not count. */
const nameKey = (name: string) =>
  name.replace(/\s+/g, " ").trim().toLowerCase();

/** The repositories of one creation over the data a transaction staged. */
function repositoriesOver(
  staged: Data,
  options: { failStockOf?: string; limit?: number },
  tried: string[]
): CreateProductWithOpeningStockDependencies {
  const productOfVariant = (variantId: string) =>
    [...staged.products.values()].find(
      (product) => product.variantId === variantId
    );
  const recordMovement = (movement: Movement) => {
    if (productOfVariant(movement.variantId)?.name === options.failStockOf) {
      return Promise.reject(new InventoryCostLimitError());
    }
    staged.movements.push(movement);
    return Promise.resolve({});
  };
  return {
    createProduct: ((
      _transaction: unknown,
      _identity: unknown,
      input: {
        categoryId?: string | null;
        defaultVariantId?: string;
        description?: string | null;
        id?: string;
        listPrice?: string | null;
        name: string;
      }
    ) => {
      tried.push(input.name);
      const live = [...staged.products.values()].filter(
        (product) => !product.deleted
      ).length;
      if (options.limit !== undefined && live >= options.limit) {
        return Promise.reject(
          new EntitlementLimitReachedError("variants.active.max", options.limit)
        );
      }
      const id = input.id ?? "generated";
      if (staged.products.has(id)) {
        return Promise.reject(new ProductIdConflictError());
      }
      staged.products.set(id, {
        archived: false,
        categoryId: input.categoryId ?? null,
        deleted: false,
        description: input.description ?? null,
        listPrice: input.listPrice ?? null,
        name: input.name,
        variantId: input.defaultVariantId ?? `${id}-variant`,
      });
      return Promise.resolve({
        archivedAt: null,
        categoryId: input.categoryId ?? null,
        createdAt: new Date(),
        deletedAt: null,
        description: input.description ?? null,
        id,
        name: input.name,
        organizationId,
        updatedAt: new Date(),
        version: 1,
      });
    }) as never,
    inventoryCount: ((
      _transaction: unknown,
      _identity: unknown,
      input: {
        commandId: string;
        occurredOn: string;
        physicalQuantity: number;
        variantId: string;
      }
    ) =>
      recordMovement({
        commandId: input.commandId,
        occurredOn: input.occurredOn,
        quantity: input.physicalQuantity,
        unitCost: null,
        variantId: input.variantId,
      })) as never,
    readProductCreation: ((
      _transaction: unknown,
      _identity: unknown,
      input: { productId: string }
    ) => {
      const product = staged.products.get(input.productId);
      if (!product) {
        return Promise.resolve(null);
      }
      const first = staged.movements.find(
        (movement) => movement.variantId === product.variantId
      );
      return Promise.resolve({
        opening: first
          ? { quantity: first.quantity, unitCost: first.unitCost }
          : null,
        product: {
          categoryId: product.categoryId,
          description: product.description,
          id: input.productId,
          name: product.name,
          version: 1,
        },
        variant: {
          id: product.variantId,
          listPrice: product.listPrice,
          sku: null,
        },
      });
    }) as never,
    receiveStock: ((
      _transaction: unknown,
      _identity: unknown,
      input: {
        commandId: string;
        occurredOn: string;
        quantity: number;
        unitCost: string;
        variantId: string;
      }
    ) =>
      recordMovement({
        commandId: input.commandId,
        occurredOn: input.occurredOn,
        quantity: input.quantity,
        unitCost: input.unitCost,
        variantId: input.variantId,
      })) as never,
  };
}

/**
 * An in-memory stand-in for the database with the property the import relies on: what a transaction wrote is kept
 * only if it ends without an error (each row is a transaction of its own). The real use cases run over it: the
 * import's and the one of `product.create`.
 */
function createStore(
  options: {
    /** The session or the membership is refused at this transaction (1 is the first). */
    failTransaction?: number;
    /** The stock of the product with this name fails after the product was written. */
    failStockOf?: string;
    /** The plan's room: a new product past it is refused. */
    limit?: number;
  } = {}
) {
  let committed: Data = { movements: [], products: new Map() };
  let staged: Data | null = null;
  const tried: string[] = [];
  const lockedNames: string[] = [];
  const capabilities: string[] = [];
  let transactions = 0;

  const stagedData = () => {
    if (!staged) {
      throw new Error("outside a transaction");
    }
    return staged;
  };

  const router = createRpcRouter({
    // the router hands its repositories to the use case; this one runs over the staged data instead
    createProductWithOpeningStock: ((
      transaction: never,
      authorized: never,
      input: never
    ) =>
      createProductWithOpeningStock(
        transaction,
        authorized,
        input,
        repositoriesOver(stagedData(), options, tried)
      )) as never,
    findExistingProductNames: ((
      _transaction: unknown,
      _identity: unknown,
      names: string[]
    ) => {
      const held = new Set(
        [...committed.products.values()]
          .filter((product) => !product.deleted)
          .map((product) => nameKey(product.name))
      );
      return Promise.resolve(names.filter((name) => held.has(nameKey(name))));
    }) as never,
    importProductBatch: {
      lockProductNameAndFindProducts: ((
        _transaction: unknown,
        _identity: unknown,
        name: string
      ) => {
        lockedNames.push(name);
        return Promise.resolve(
          [...stagedData().products]
            .filter(
              ([, product]) =>
                !product.deleted && nameKey(product.name) === nameKey(name)
            )
            .map(([id]) => id)
        );
      }) as never,
      organizationToday: (() => Promise.resolve(today)) as never,
    },
    withTenantRequestContext: ((input: {
      capability: string;
      operation: (transaction: unknown, id: typeof identity) => unknown;
    }) => {
      capabilities.push(input.capability);
      return input.operation({}, identity);
    }) as never,
    withTenantRequestSequence: ((input: {
      capability: string;
      operation: (
        inTransaction: (
          operation: (transaction: unknown, id: typeof identity) => unknown
        ) => Promise<unknown>
      ) => Promise<unknown>;
    }) =>
      input.operation(async (operation) => {
        capabilities.push(input.capability);
        transactions += 1;
        if (transactions === options.failTransaction) {
          throw new TenantAuthorizationError("tenant_access_denied");
        }
        staged = copy(committed);
        try {
          const result = await operation({}, identity);
          committed = staged;
          return result;
        } finally {
          staged = null;
        }
      })) as never,
  });

  const app = createServerApp({ rpcRouter: router });
  const link = new RPCLink({
    fetch: (request) => Promise.resolve(app.fetch(request, testBindings)),
    headers: { origin: "https://polaris.example.invalid" },
    method: "POST",
    url: new URL("/rpc", "https://polaris.example.invalid"),
  });
  const client = createORPCClient(link) as unknown as {
    product: {
      importBatch: (
        input: unknown
      ) => Promise<{ results: ProductImportRowResult[] }>;
      namesExisting: (input: unknown) => Promise<{ names: string[] }>;
    };
  };

  return {
    capabilities,
    client,
    /** What was committed: products, variants (one default per product) and stock movements. */
    counts: () => ({
      movements: committed.movements.length,
      products: committed.products.size,
      variants: new Set(
        [...committed.products.values()].map((product) => product.variantId)
      ).size,
    }),
    get data() {
      return committed;
    },
    lockedNames,
    seed: (id: string, product: Partial<StoredProduct> & { name: string }) => {
      committed.products.set(id, {
        archived: false,
        categoryId: null,
        deleted: false,
        description: null,
        listPrice: null,
        variantId: `${id}-variant`,
        ...product,
      });
    },
    tried,
  };
}

let idCounter = 0;
const nextId = () => {
  idCounter += 1;
  return `0199c2d0-0000-7000-8000-${String(idCounter).padStart(12, "0")}`;
};

function importRow(
  rowNumber: number,
  name: string,
  extra: Partial<ProductImportRowInput> = {}
): ProductImportRowInput {
  return {
    categoryId: null,
    description: null,
    initialStock: { commandId: nextId(), quantity: 3, unitCost: "12.50" },
    listPrice: "59.90",
    name,
    productId: nextId(),
    rowNumber,
    variantId: nextId(),
    ...extra,
  };
}

const batch = (rows: ProductImportRowInput[]) => ({
  importId,
  organizationId,
  rows,
});

/** The contract takes one row per call: the rows of a file go one call each, in order, as the client sends them. */
async function importEach(
  store: ReturnType<typeof createStore>,
  rows: ProductImportRowInput[]
) {
  const results: ProductImportRowResult[] = [];
  for (const row of rows) {
    // biome-ignore lint/performance/noAwaitInLoops: one call at a time, the next only after the answer
    const answer = await store.client.product.importBatch(batch([row]));
    results.push(...answer.results);
  }
  return { results };
}

async function rpcError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { code?: string; data?: { reason?: string } };
  }
  throw new Error("expected the call to fail");
}

describe("product.importBatch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates each row with its variant and opening stock, under product:create, dated today", async () => {
    const store = createStore();
    const rows = [
      importRow(2, "Camiseta"),
      importRow(3, "Boné", { initialStock: null, listPrice: null }),
      importRow(4, "Meia", {
        initialStock: { commandId: nextId(), quantity: 5, unitCost: null },
      }),
    ];

    const { results } = await importEach(store, rows);

    expect(results).toEqual([
      { productId: rows[0]?.productId, rowNumber: 2, status: "created" },
      { productId: rows[1]?.productId, rowNumber: 3, status: "created" },
      { productId: rows[2]?.productId, rowNumber: 4, status: "created" },
    ]);
    expect(store.counts()).toEqual({ movements: 2, products: 3, variants: 3 });
    expect(store.data.movements.map((movement) => movement.occurredOn)).toEqual(
      [today, today]
    );
    // the quantity with no cost opens the stock with the cost unknown
    expect(store.data.movements[1]?.unitCost).toBeNull();
    // one transaction per row, each authorized for product:create
    expect(store.capabilities).toEqual([
      "product:create",
      "product:create",
      "product:create",
    ]);
  });

  it("AC-4: a row whose stock fails leaves nothing of itself and does not stop the others", async () => {
    const store = createStore({ failStockOf: "Meio" });
    const rows = [
      importRow(2, "Antes"),
      importRow(3, "Meio"),
      importRow(4, "Depois"),
    ];

    const { results } = await importEach(store, rows);

    expect(results.map((result) => result.status)).toEqual([
      "created",
      "invalid",
      "created",
    ]);
    expect(results[1]).toEqual({
      field: "unitCost",
      reason: "invalid_unit_cost",
      rowNumber: 3,
      status: "invalid",
    });
    // the product of the failed row was rolled back with its stock: entered = products = variants = movements
    expect(store.counts()).toEqual({ movements: 2, products: 2, variants: 2 });
    expect([...store.data.products.values()].map((p) => p.name)).toEqual([
      "Antes",
      "Depois",
    ]);
  });

  it("AC-5: sending the same rows again repeats them and writes nothing twice", async () => {
    const store = createStore();
    const rows = [importRow(2, "Camiseta"), importRow(3, "Boné")];

    await importEach(store, rows);
    const before = store.counts();
    // the answer was lost: the client sends the same rows, with the same IDs
    const { results } = await importEach(store, rows);

    expect(results).toEqual([
      { productId: rows[0]?.productId, rowNumber: 2, status: "repeated" },
      { productId: rows[1]?.productId, rowNumber: 3, status: "repeated" },
    ]);
    expect(store.counts()).toEqual(before);
  });

  it("AC-5: the repeat of a row that filled the plan is still a repeat", async () => {
    const store = createStore({ limit: 1 });
    const rows = [importRow(2, "Camiseta")];

    await store.client.product.importBatch(batch(rows));
    const { results } = await store.client.product.importBatch(batch(rows));

    expect(results).toEqual([
      { productId: rows[0]?.productId, rowNumber: 2, status: "repeated" },
    ]);
    expect(store.counts().products).toBe(1);
  });

  it("the same IDs with other data are a conflict, not a repeat", async () => {
    const store = createStore();
    const first = importRow(2, "Camiseta");
    await store.client.product.importBatch(batch([first]));

    const { results } = await store.client.product.importBatch(
      batch([{ ...first, listPrice: "10.00" }])
    );

    expect(results).toEqual([
      { reason: "product_create_conflict", rowNumber: 2, status: "conflict" },
    ]);
    expect(store.counts().products).toBe(1);
  });

  it("skips a name the store already has, archived too, without case or repeated spaces; a deleted one does not count", async () => {
    const store = createStore();
    store.seed("0199c2d0-0000-7000-8000-0000000a0001", {
      name: "Camiseta Azul",
    });
    store.seed("0199c2d0-0000-7000-8000-0000000a0002", {
      archived: true,
      name: "Boné",
    });
    store.seed("0199c2d0-0000-7000-8000-0000000a0003", {
      deleted: true,
      name: "Meia",
    });

    const { results } = await importEach(store, [
      importRow(2, "camiseta   azul"),
      importRow(3, "BONÉ"),
      importRow(4, "Meia"),
    ]);

    expect(results.map((result) => result.status)).toEqual([
      "exists_by_name",
      "exists_by_name",
      "created",
    ]);
    // nothing was tried for the skipped rows
    expect(store.tried).toEqual(["Meia"]);
  });

  it("a name repeated in the same file enters once: the later row is skipped", async () => {
    const store = createStore();

    const first = await importEach(store, [
      importRow(2, "Camiseta"),
      importRow(3, "camiseta"),
    ]);
    const next = await importEach(store, [importRow(9, "CAMISETA")]);

    expect(first.results.map((result) => result.status)).toEqual([
      "created",
      "exists_by_name",
    ]);
    expect(next.results.map((result) => result.status)).toEqual([
      "exists_by_name",
    ]);
    expect(store.counts().products).toBe(1);
  });

  it("AC-6: a row past the plan's limit is limit_reached and creates nothing", async () => {
    const store = createStore({ limit: 2 });
    const rows = [1, 2, 3].map((n) => importRow(n + 1, `Produto ${n}`));

    const { results } = await importEach(store, rows);

    expect(results.map((result) => result.status)).toEqual([
      "created",
      "created",
      "limit_reached",
    ]);
    expect(store.tried).toEqual(["Produto 1", "Produto 2", "Produto 3"]);
    expect(store.counts().products).toBe(2);
  });

  it.each([
    ["U+0000", "Bolsa\u0000azul"],
    ["U+202E", "Bolsa\u202Eazul"],
    ["U+2066", "Bolsa\u2066azul"],
  ])(
    "a name with %s is a refused row, never a fault of the slice, and never reaches a query",
    async (_label, name) => {
      const store = createStore();

      const { results } = await importEach(store, [
        importRow(2, name),
        importRow(3, "Boné"),
      ]);

      expect(results).toEqual([
        {
          field: "name",
          reason: "invalid_product_name",
          rowNumber: 2,
          status: "invalid",
        },
        expect.objectContaining({ rowNumber: 3, status: "created" }),
      ]);
      expect(store.lockedNames).toEqual(["Boné"]);
    }
  );

  it("a description with a forbidden character, or an invalid price, is a refused row with its field", async () => {
    const store = createStore();

    const { results } = await importEach(store, [
      importRow(2, "A", { description: "texto\u202Einvertido" }),
      importRow(3, "B", { listPrice: "12,345" }),
    ]);

    expect(results).toEqual([
      {
        field: "description",
        reason: "invalid_product_description",
        rowNumber: 2,
        status: "invalid",
      },
      {
        field: "listPrice",
        reason: "invalid_variant_list_price",
        rowNumber: 3,
        status: "invalid",
      },
    ]);
    expect(store.counts().products).toBe(0);
  });

  it("keeps a formula or HTML as the text it came as", async () => {
    const store = createStore();

    await store.client.product.importBatch(
      batch([
        importRow(2, '=HYPERLINK("x")', { description: "<script>x</script>" }),
      ])
    );

    const [stored] = store.data.products.values();
    expect(stored?.name).toBe('=HYPERLINK("x")');
    expect(stored?.description).toBe("<script>x</script>");
  });

  it("a refusal of the session or the membership answers the call whole, and writes nothing", async () => {
    const store = createStore({ failTransaction: 2 });
    const [first, second] = [importRow(2, "A"), importRow(3, "B")];

    await store.client.product.importBatch(batch([first]));
    const error = await rpcError(
      store.client.product.importBatch(batch([second]))
    );

    expect(error.code).toBe("FORBIDDEN");
    // the first row stays (its call ended); sending the second again is a new call
    expect(store.counts().products).toBe(1);
  });

  it("takes one row per call: two rows are refused whole and one is created", async () => {
    const store = createStore();
    const [one, two] = [importRow(2, "A"), importRow(3, "B")];

    expect(PRODUCT_IMPORT_BATCH_MAX_ROWS).toBe(1);
    const refused = await rpcError(
      store.client.product.importBatch(batch([one, two]))
    );
    expect(refused.code).toBe("BAD_REQUEST");
    expect(store.counts().products).toBe(0);

    const { results } = await store.client.product.importBatch(batch([one]));
    expect(results.map((result) => result.status)).toEqual(["created"]);
    expect(store.counts().products).toBe(1);
  });

  it.each([
    [
      "more rows than a call carries",
      () =>
        batch(
          Array.from({ length: PRODUCT_IMPORT_BATCH_MAX_ROWS + 1 }, (_, i) =>
            importRow(i + 2, `P${i}`)
          )
        ),
    ],
    ["no row", () => batch([])],
    [
      "a field the contract does not know",
      () => batch([{ ...importRow(2, "A"), sku: "X" } as never]),
    ],
    [
      "a field of the call the contract does not know",
      () => ({ ...batch([importRow(2, "A")]), file: "a;b" }),
    ],
    [
      "a row whose product and variant IDs are the same",
      () => {
        const one = importRow(2, "A");
        return batch([{ ...one, variantId: one.productId }]);
      },
    ],
    [
      "a name longer than the one of product.create",
      () => batch([importRow(2, "n".repeat(201))]),
    ],
    [
      "a description longer than the one of product.create",
      () => batch([importRow(2, "A", { description: "d".repeat(5001) })]),
    ],
    [
      "a quantity that is not a whole number",
      () =>
        batch([
          importRow(2, "A", {
            initialStock: {
              commandId: nextId(),
              quantity: 1.5,
              unitCost: null,
            },
          }),
        ]),
    ],
  ])(
    "refuses the whole call for %s, and writes nothing",
    async (_label, input) => {
      const store = createStore();

      const error = await rpcError(store.client.product.importBatch(input()));

      expect(error.code).toBe("BAD_REQUEST");
      expect(store.counts().products).toBe(0);
      expect(store.capabilities).toEqual([]);
    }
  );

  it("AC-7: the log of a call has counts and opaque IDs, never a name, a value or a description", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const store = createStore({ limit: 1 });
    const hostile = importRow(2, "=cmd|' /C calc'!A0 Segredo", {
      description: "<img src=x onerror=alert(1)> descrição secreta",
      listPrice: "987654.32",
    });

    await importEach(store, [
      hostile,
      importRow(3, "Outro"),
      importRow(4, "Bolsa\u0000"),
    ]);

    const lines = [...info.mock.calls, ...log.mock.calls]
      .map((call) => JSON.stringify(call))
      .filter((text) => text.includes("product_import_batch"));
    expect(lines).toHaveLength(3);
    const parsed = lines.map((line) => JSON.parse(line)[0]);
    for (const entry of parsed) {
      expect(entry).toMatchObject({
        event: "product_import_batch",
        importId,
        organizationId,
        rows: 1,
      });
    }
    expect(parsed.map((entry) => entry.created)).toEqual([1, 0, 0]);
    expect(parsed.map((entry) => entry.limit_reached)).toEqual([0, 1, 0]);
    expect(parsed.map((entry) => entry.invalid)).toEqual([0, 0, 1]);
    const everything = [...info.mock.calls, ...log.mock.calls]
      .map((call) => JSON.stringify(call))
      .join("\n");
    for (const secret of ["Segredo", "calc", "secreta", "onerror", "987654"]) {
      expect(everything).not.toContain(secret);
    }
  });
});

describe("product.namesExisting", () => {
  it("answers the names the store already has, under catalog:read", async () => {
    const store = createStore();
    store.seed("0199c2d0-0000-7000-8000-0000000b0001", {
      name: "Camiseta Azul",
    });
    store.seed("0199c2d0-0000-7000-8000-0000000b0002", {
      archived: true,
      name: "Boné",
    });

    const { names } = await store.client.product.namesExisting({
      names: ["camiseta  azul", "Boné", "Meia"],
      organizationId,
    });

    expect(names).toEqual(["camiseta  azul", "Boné"]);
    expect(store.capabilities).toEqual(["catalog:read"]);
  });

  it("never asks about a name no product can hold", async () => {
    const store = createStore();
    store.seed("0199c2d0-0000-7000-8000-0000000b0003", { name: "Bolsa" });

    const { names } = await store.client.product.namesExisting({
      names: ["Bolsa\u0000", "Bol\u202Esa", "   ", "Bolsa"],
      organizationId,
    });

    expect(names).toEqual(["Bolsa"]);
  });

  it("refuses more names than a file has rows", async () => {
    const store = createStore();

    const error = await rpcError(
      store.client.product.namesExisting({
        names: Array.from({ length: 501 }, (_, i) => `P${i}`),
        organizationId,
      })
    );

    expect(error.code).toBe("BAD_REQUEST");
  });
});
