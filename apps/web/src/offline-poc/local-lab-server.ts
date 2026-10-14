import type {
  SaleListEntryReadModel,
  SyncChangeReadModel,
} from "@polaris/contracts";
import {
  type BootstrapCollectionName,
  type BootstrapPageRequest,
  type BootstrapSource,
  type LocalRows,
  localRowKey,
} from "../offline/bootstrap";

const AT = "2026-10-14T12:00:00.000Z";
const uuid = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

type AnyRow = LocalRows[BootstrapCollectionName];

/**
 * A synthetic server for the browser gate: deterministic data, a change log and
 * a switch that makes one collection fail, so the lab can prove an interrupted
 * bootstrap. Nothing here is real data.
 */
export class LabServer implements BootstrapSource {
  private readonly rows: Record<BootstrapCollectionName, Map<string, AnyRow>> =
    {
      categories: new Map(),
      customers: new Map(),
      inventory: new Map(),
      products: new Map(),
      variants: new Map(),
    };
  private readonly sales: SaleListEntryReadModel[] = [];
  private readonly changes: SyncChangeReadModel[] = [];
  failOn: BootstrapCollectionName | null = null;

  constructor(seed: {
    categories: number;
    customers: number;
    products: number;
  }) {
    for (let n = 1; n <= seed.categories; n += 1) {
      this.put("categories", {
        archivedAt: null,
        deletedAt: null,
        id: uuid(n),
        name: `Categoria ${n}`,
        updatedAt: AT,
      });
    }
    for (let n = 1; n <= seed.products; n += 1) {
      this.put("products", {
        archivedAt: null,
        categoryId: null,
        deletedAt: null,
        description: null,
        id: uuid(1000 + n),
        name: `Produto ${n}`,
        updatedAt: AT,
        version: 1,
      });
      this.put("variants", {
        id: uuid(2000 + n),
        isDefault: true,
        listPrice: n % 2 === 0 ? "59.90" : null,
        position: null,
        productId: uuid(1000 + n),
        sku: `SKU-${n}`,
        values: [],
      });
      this.put("inventory", {
        productId: uuid(1000 + n),
        quantity: n * 3,
        updatedAt: AT,
        variantId: uuid(2000 + n),
        version: 1,
      });
    }
    for (let n = 1; n <= seed.customers; n += 1) {
      this.put("customers", {
        archivedAt: null,
        email: null,
        id: uuid(3000 + n),
        name: `Cliente ${n}`,
        notes: null,
        phone: "+55 11 90000-0000",
        updatedAt: AT,
        version: 1,
      });
    }
    for (let n = 1; n <= 3; n += 1) {
      this.sales.push({
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
    }
  }

  private put<K extends BootstrapCollectionName>(
    collection: K,
    row: LocalRows[K]
  ) {
    this.rows[collection].set(localRowKey(collection, row), row);
  }

  private log(entityType: SyncChangeReadModel["entityType"], entityId: string) {
    this.changes.push({ entityId, entityType, seq: this.changes.length + 1 });
  }

  renameFirstProduct(name: string) {
    const id = uuid(1001);
    const row = this.rows.products.get(id) as LocalRows["products"];
    this.put("products", { ...row, name, version: row.version + 1 });
    this.log("product", id);
  }

  addCategory(name: string) {
    const id = uuid(500 + this.rows.categories.size);
    this.put("categories", {
      archivedAt: null,
      deletedAt: null,
      id,
      name,
      updatedAt: AT,
    });
    this.log("category", id);
  }

  removeFirstCustomer() {
    const id = uuid(3001);
    this.rows.customers.delete(id);
    this.log("customer", id);
  }

  getCursor() {
    return Promise.resolve(String(this.changes.length));
  }

  page<K extends BootstrapCollectionName>(
    collection: K,
    request: BootstrapPageRequest
  ) {
    if (this.failOn === collection) {
      return Promise.reject(new Error(`falha simulada em ${collection}`));
    }
    const all = [...this.rows[collection].values()] as LocalRows[K][];
    const keyOf = (row: LocalRows[K]) => localRowKey(collection, row);
    if (request.ids) {
      const wanted = new Set(request.ids);
      return Promise.resolve({
        nextAfterId: null,
        rows: all.filter((row) =>
          collection === "variants"
            ? wanted.has((row as LocalRows["variants"]).productId)
            : wanted.has(keyOf(row))
        ),
      });
    }
    const sorted = all.sort((left, right) =>
      keyOf(left).localeCompare(keyOf(right))
    );
    const afterId = request.afterId ?? "";
    const rest = afterId
      ? sorted.filter((row) => keyOf(row) > afterId)
      : sorted;
    const limit = request.limit ?? 200;
    const rows = rest.slice(0, limit);
    const last = rows.at(-1);
    return Promise.resolve({
      nextAfterId: rest.length > limit && last ? keyOf(last) : null,
      rows,
    });
  }

  pull(cursor: string, limit: number) {
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
    return Promise.resolve(this.sales);
  }
}
