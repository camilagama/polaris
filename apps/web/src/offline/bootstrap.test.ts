import type {
  SaleListEntryReadModel,
  SyncChangeReadModel,
} from "@polaris/contracts";
import { describe, expect, it } from "vitest";
import {
  type BootstrapCollectionName,
  type BootstrapSource,
  bootstrapLocalStore,
  isLocalStoreReady,
  type LocalRows,
  type LocalSyncMeta,
  type LocalWriter,
  localRowKey,
  pullLocalChanges,
} from "./bootstrap";

const AT = "2026-10-14T12:00:00.000Z";
const uuid = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

type Row = LocalRows[BootstrapCollectionName];

/** A server whose collections and change log can be edited between calls. */
class FakeServer implements BootstrapSource {
  collections: Record<BootstrapCollectionName, Map<string, Row>> = {
    categories: new Map(),
    customers: new Map(),
    inventory: new Map(),
    products: new Map(),
    variants: new Map(),
  };
  sales: SaleListEntryReadModel[] = [];
  changes: SyncChangeReadModel[] = [];
  pageCalls: Array<{
    collection: string;
    ids?: string[];
    afterId?: string | null;
  }> = [];
  pullCalls: string[] = [];
  salesCalls = 0;
  failOnPage: BootstrapCollectionName | null = null;
  onPage: (() => void) | null = null;

  put<K extends BootstrapCollectionName>(collection: K, row: LocalRows[K]) {
    this.collections[collection].set(localRowKey(collection, row), row);
  }

  change(entityType: SyncChangeReadModel["entityType"], entityId: string) {
    this.changes.push({ entityId, entityType, seq: this.changes.length + 1 });
  }

  getCursor() {
    return Promise.resolve(String(this.changes.length));
  }

  page<K extends BootstrapCollectionName>(
    collection: K,
    request: { afterId?: string | null; ids?: string[]; limit?: number }
  ) {
    this.pageCalls.push({ collection, ...request });
    if (this.failOnPage === collection) {
      return Promise.reject(new Error("network down"));
    }
    this.onPage?.();
    const all = [...this.collections[collection].values()] as LocalRows[K][];
    const keyOf = (row: LocalRows[K]) => localRowKey(collection, row);
    if (request.ids) {
      const wanted = new Set(request.ids);
      const rows = all.filter((row) =>
        collection === "variants"
          ? wanted.has((row as LocalRows["variants"]).productId)
          : wanted.has(keyOf(row))
      );
      return Promise.resolve({ nextAfterId: null, rows });
    }
    const sorted = all.sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
    const start = request.afterId
      ? sorted.findIndex((row) => keyOf(row) > (request.afterId ?? ""))
      : 0;
    const from = start < 0 ? sorted.length : start;
    const limit = request.limit ?? 200;
    const rows = sorted.slice(from, from + limit);
    const last = rows.at(-1);
    return Promise.resolve({
      nextAfterId: from + limit < sorted.length && last ? keyOf(last) : null,
      rows,
    });
  }

  pull(cursor: string, limit: number) {
    this.pullCalls.push(cursor);
    const after = Number(cursor);
    const batch = this.changes.filter((change) => change.seq > after);
    const page = batch.slice(0, limit);
    return Promise.resolve({
      changes: page,
      hasMore: batch.length > limit,
      nextCursor: String(page.at(-1)?.seq ?? after),
    });
  }

  recentSales() {
    this.salesCalls += 1;
    return Promise.resolve(this.sales);
  }
}

class FakeWriter implements LocalWriter {
  data: Record<BootstrapCollectionName | "recentSales", Map<string, unknown>> =
    {
      categories: new Map(),
      customers: new Map(),
      inventory: new Map(),
      products: new Map(),
      recentSales: new Map(),
      variants: new Map(),
    };
  meta: LocalSyncMeta | null = null;
  metaHistory: LocalSyncMeta["status"][] = [];

  keys(collection: BootstrapCollectionName) {
    return Promise.resolve([...this.data[collection].keys()]);
  }
  readMeta() {
    return Promise.resolve(this.meta);
  }
  remove(collection: BootstrapCollectionName | "recentSales", keys: string[]) {
    for (const key of keys) {
      this.data[collection].delete(key);
    }
    return Promise.resolve();
  }
  replaceRecentSales(rows: SaleListEntryReadModel[]) {
    this.data.recentSales = new Map(rows.map((row) => [row.id, row]));
    return Promise.resolve();
  }
  upsert<K extends BootstrapCollectionName>(
    collection: K,
    rows: LocalRows[K][]
  ) {
    for (const row of rows) {
      this.data[collection].set(localRowKey(collection, row), row);
    }
    return Promise.resolve();
  }
  variantKeysOfProducts(productIds: string[]) {
    const wanted = new Set(productIds);
    return Promise.resolve(
      [...this.data.variants.values()]
        .filter((row) => wanted.has((row as LocalRows["variants"]).productId))
        .map((row) => (row as LocalRows["variants"]).id)
    );
  }
  writeMeta(meta: LocalSyncMeta) {
    this.meta = meta;
    this.metaHistory.push(meta.status);
    return Promise.resolve();
  }
  count(collection: BootstrapCollectionName | "recentSales") {
    return this.data[collection].size;
  }
}

const category = (n: number) => ({
  archivedAt: null,
  deletedAt: null,
  id: uuid(n),
  name: `Categoria ${n}`,
  updatedAt: AT,
});
const product = (n: number, name = `Produto ${n}`) => ({
  archivedAt: null,
  categoryId: null,
  deletedAt: null,
  description: null,
  id: uuid(1000 + n),
  name,
  updatedAt: AT,
  version: 1,
});
const variant = (n: number, productN: number) => ({
  id: uuid(2000 + n),
  isDefault: true,
  listPrice: null,
  position: null,
  productId: uuid(1000 + productN),
  sku: null,
  values: [],
});
const balance = (n: number, productN: number, quantity: number) => ({
  productId: uuid(1000 + productN),
  quantity,
  updatedAt: AT,
  variantId: uuid(2000 + n),
  version: 1,
});
const customer = (n: number) => ({
  archivedAt: null,
  email: null,
  id: uuid(3000 + n),
  name: `Cliente ${n}`,
  notes: null,
  phone: "+55 11 90000-0000",
  updatedAt: AT,
  version: 1,
});
const sale = (n: number): SaleListEntryReadModel => ({
  cancelledAt: null,
  confirmedAt: AT,
  customerId: null,
  customerName: null,
  hasReturns: false,
  id: uuid(4000 + n),
  itemCount: 1,
  occurredAt: AT,
  occurredOn: "2026-10-14",
  paymentMethod: "pix",
  status: "confirmed",
  totalDue: "19.90",
});

function seededServer() {
  const server = new FakeServer();
  for (let n = 1; n <= 5; n += 1) {
    server.put("categories", category(n));
  }
  for (let n = 1; n <= 3; n += 1) {
    server.put("products", product(n));
    server.put("variants", variant(n, n));
    server.put("inventory", balance(n, n, 10 * n));
  }
  for (let n = 1; n <= 2; n += 1) {
    server.put("customers", customer(n));
  }
  server.sales = [sale(1), sale(2)];
  return server;
}

describe("bootstrapLocalStore", () => {
  it("loads every collection page by page and ends ready at the cursor", async () => {
    const server = seededServer();
    const writer = new FakeWriter();
    const result = await bootstrapLocalStore(server, writer, { pageSize: 2 });

    expect(result.counts).toEqual({
      categories: 5,
      customers: 2,
      inventory: 3,
      products: 3,
      recentSales: 2,
      variants: 3,
    });
    expect(writer.count("categories")).toBe(5);
    expect(writer.count("recentSales")).toBe(2);
    expect(writer.meta).toMatchObject({
      cursor: "0",
      status: "ready",
      version: 1,
    });
    expect(isLocalStoreReady(writer.meta)).toBe(true);
    // pages of two over five categories: three calls with the keyset position moving
    const categoryCalls = server.pageCalls.filter(
      (call) => call.collection === "categories"
    );
    expect(categoryCalls).toHaveLength(3);
    expect(categoryCalls[0]?.afterId ?? null).toBeNull();
    expect(categoryCalls[1]?.afterId).toBe(uuid(2));
    expect(categoryCalls[2]?.afterId).toBe(uuid(4));
  });

  it("records the cursor before reading and keeps the store 'bootstrapping' until done", async () => {
    const server = seededServer();
    const writer = new FakeWriter();
    await bootstrapLocalStore(server, writer);
    expect(writer.metaHistory[0]).toBe("bootstrapping");
    expect(writer.metaHistory.at(-1)).toBe("ready");
    expect(
      writer.metaHistory.filter((status) => status === "ready")
    ).toHaveLength(1);
  });

  it("drops local rows the server no longer has", async () => {
    const server = seededServer();
    const writer = new FakeWriter();
    await bootstrapLocalStore(server, writer);
    server.collections.categories.delete(uuid(2));
    server.collections.customers.clear();
    await bootstrapLocalStore(server, writer);
    expect(writer.count("categories")).toBe(4);
    expect(writer.count("customers")).toBe(0);
  });

  it("applies changes that land while the snapshot is read (nothing is missed)", async () => {
    const server = seededServer();
    const writer = new FakeWriter();
    let injected = false;
    server.onPage = () => {
      if (injected) {
        return;
      }
      injected = true;
      // a product is renamed and a category added after the cursor was recorded
      server.put("products", product(2, "Renomeado"));
      server.change("product", uuid(1002));
      server.put("categories", category(9));
      server.change("category", uuid(9));
    };
    const result = await bootstrapLocalStore(server, writer);

    expect(result.cursor).toBe("2");
    expect(writer.data.products.get(uuid(1002))).toMatchObject({
      name: "Renomeado",
    });
    expect(writer.count("categories")).toBe(6);
  });

  it("leaves an interrupted run marked 'bootstrapping' and finishes on the next run", async () => {
    const server = seededServer();
    const writer = new FakeWriter();
    server.failOnPage = "inventory";
    await expect(bootstrapLocalStore(server, writer)).rejects.toThrow(
      "network down"
    );
    expect(writer.meta?.status).toBe("bootstrapping");
    expect(isLocalStoreReady(writer.meta)).toBe(false);

    server.failOnPage = null;
    await bootstrapLocalStore(server, writer);
    expect(isLocalStoreReady(writer.meta)).toBe(true);
    expect(writer.count("inventory")).toBe(3);
  });
});

describe("pullLocalChanges", () => {
  async function readyStore() {
    const server = seededServer();
    const writer = new FakeWriter();
    await bootstrapLocalStore(server, writer);
    server.pageCalls = [];
    server.salesCalls = 0;
    return { server, writer };
  }

  it("re-reads changed entities, drops vanished ones and advances the cursor", async () => {
    const { server, writer } = await readyStore();
    server.put("categories", { ...category(1), name: "Nova" });
    server.change("category", uuid(1));
    server.collections.customers.delete(uuid(3001));
    server.change("customer", uuid(3001));
    server.put("inventory", balance(1, 1, 99));
    server.change("inventory_balance", uuid(2001));

    const cursor = await pullLocalChanges(server, writer, "0");

    expect(cursor).toBe("3");
    expect(writer.data.categories.get(uuid(1))).toMatchObject({ name: "Nova" });
    expect(writer.data.customers.has(uuid(3001))).toBe(false);
    expect(writer.data.inventory.get(uuid(2001))).toMatchObject({
      quantity: 99,
    });
    expect(writer.meta).toMatchObject({ cursor: "3", status: "ready" });
  });

  it("re-reads variants by product and removes variants that disappeared", async () => {
    const { server, writer } = await readyStore();
    server.collections.variants.delete(uuid(2002));
    server.put("variants", { ...variant(7, 2), listPrice: "59.90" });
    server.change("product", uuid(1002));

    await pullLocalChanges(server, writer, "0");

    expect(writer.data.variants.has(uuid(2002))).toBe(false);
    expect(writer.data.variants.get(uuid(2007))).toMatchObject({
      listPrice: "59.90",
    });
    expect(writer.count("variants")).toBe(3);
    const variantCall = server.pageCalls.find(
      (call) => call.collection === "variants"
    );
    expect(variantCall?.ids).toEqual([uuid(1002)]);
  });

  it("refreshes the recent sales window once however many sales changed", async () => {
    const { server, writer } = await readyStore();
    server.sales = [sale(3), sale(2), sale(1)];
    for (const n of [1, 2, 3]) {
      server.change("sale", uuid(4000 + n));
    }
    await pullLocalChanges(server, writer, "0", { pullLimit: 2 });
    expect(server.salesCalls).toBe(1);
    expect(writer.count("recentSales")).toBe(3);
  });

  it("ignores payment profiles and does not call the server for them", async () => {
    const { server, writer } = await readyStore();
    server.change("payment_profile", uuid(5000));
    await pullLocalChanges(server, writer, "0");
    expect(server.pageCalls).toHaveLength(0);
    expect(writer.meta?.cursor).toBe("1");
  });

  it("reads ids in chunks of 200", async () => {
    const { server, writer } = await readyStore();
    for (let n = 100; n < 100 + 450; n += 1) {
      server.put("categories", category(n));
      server.change("category", uuid(n));
    }
    await pullLocalChanges(server, writer, "0", { pullLimit: 500 });
    const idCalls = server.pageCalls.filter(
      (call) => call.collection === "categories" && call.ids
    );
    expect(idCalls.map((call) => call.ids?.length)).toEqual([200, 200, 50]);
    expect(writer.count("categories")).toBe(5 + 450);
  });

  it("keeps a ready store ready while it catches up", async () => {
    const { server, writer } = await readyStore();
    server.put("categories", category(8));
    server.change("category", uuid(8));
    await pullLocalChanges(server, writer, "0");
    expect(writer.metaHistory.at(-1)).toBe("ready");
  });
});

describe("isLocalStoreReady", () => {
  it("needs a complete snapshot of this store version", () => {
    const ready: LocalSyncMeta = {
      bootstrappedAt: AT,
      cursor: "5",
      status: "ready",
      updatedAt: AT,
      version: 1,
    };
    expect(isLocalStoreReady(ready)).toBe(true);
    expect(isLocalStoreReady(null)).toBe(false);
    expect(isLocalStoreReady({ ...ready, status: "bootstrapping" })).toBe(
      false
    );
    expect(isLocalStoreReady({ ...ready, cursor: null })).toBe(false);
  });
});
