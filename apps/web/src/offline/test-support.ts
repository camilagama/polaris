import type {
  LocalCustomerReadModel,
  LocalInventoryReadModel,
  LocalProductReadModel,
  LocalVariantReadModel,
  PushCommandReadModel,
  PushResultReadModel,
  SaleListEntryReadModel,
  SyncChangeReadModel,
} from "@polaris/contracts";
import type {
  BootstrapCollectionName,
  BootstrapSource,
  LocalRows,
  LocalSyncMeta,
  LocalWriter,
} from "./bootstrap";
import { localRowKey } from "./bootstrap";

/** In-memory local collections, for the tests of the offline modules. */
export class FakeWriter implements LocalWriter {
  readonly data: Record<
    BootstrapCollectionName | "recentSales",
    Map<string, unknown>
  > = {
    categories: new Map(),
    customers: new Map(),
    inventory: new Map(),
    products: new Map(),
    recentSales: new Map(),
    variants: new Map(),
  };
  meta: LocalSyncMeta | null = null;

  inventoryRow(variantId: string) {
    return Promise.resolve(this.stock(variantId));
  }
  variantRow(variantId: string) {
    return Promise.resolve(this.variant(variantId));
  }
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
  rows<K extends BootstrapCollectionName>(collection: K) {
    return Promise.resolve([
      ...this.data[collection].values(),
    ] as LocalRows[K][]);
  }
  variantKeysOfProducts(productIds: string[]) {
    return Promise.resolve(
      [...this.data.variants.values()]
        .map((row) => row as LocalVariantReadModel)
        .filter((row) => productIds.includes(row.productId))
        .map((row) => row.id)
    );
  }
  writeMeta(meta: LocalSyncMeta) {
    this.meta = meta;
    return Promise.resolve();
  }
  customer(id: string) {
    return this.data.customers.get(id) as LocalCustomerReadModel | undefined;
  }
  product(id: string) {
    return this.data.products.get(id) as LocalProductReadModel | undefined;
  }
  variant(id: string) {
    return this.data.variants.get(id) as LocalVariantReadModel | undefined;
  }
  stock(variantId: string) {
    return this.data.inventory.get(variantId) as
      | LocalInventoryReadModel
      | undefined;
  }
}

/**
 * A synthetic server for `customer.create`: idempotent by command ID, optionally
 * losing a response (the work is done but the device never hears of it) or
 * refusing, and exposing its customers through the change log.
 */
export class FakeCustomerServer implements BootstrapSource {
  readonly customers = new Map<string, LocalCustomerReadModel>();
  readonly outcomes = new Map<string, PushResultReadModel>();
  readonly changes: SyncChangeReadModel[] = [];
  executions = 0;
  requests = 0;
  /** How many upcoming responses are lost after the server did the work. */
  lostResponses = 0;
  rejectCode: string | null = null;

  push = (input: { commands: PushCommandReadModel[] }) => {
    this.requests += 1;
    const results: PushResultReadModel[] = [];
    let blocked = false;
    for (const command of input.commands) {
      if (blocked) {
        results.push({
          code: null,
          commandId: command.commandId,
          replayed: false,
          result: null,
          status: "not_processed",
        });
        continue;
      }
      const seen = this.outcomes.get(command.commandId);
      if (seen) {
        const replay = { ...seen, replayed: true };
        results.push(replay);
        blocked = replay.status !== "accepted";
        continue;
      }
      this.executions += 1;
      let outcome: PushResultReadModel;
      if (this.rejectCode) {
        outcome = {
          code: this.rejectCode,
          commandId: command.commandId,
          replayed: false,
          result: null,
          status: "rejected",
        };
      } else {
        const payload = command.payload as {
          customerId: string;
          name: string;
          phone: string | null;
          email: string | null;
          notes: string | null;
        };
        this.customers.set(payload.customerId, {
          archivedAt: null,
          email: payload.email,
          id: payload.customerId,
          name: payload.name,
          notes: payload.notes,
          phone: payload.phone,
          updatedAt: "2026-10-14T13:00:00.000Z",
          version: 1,
        });
        this.changes.push({
          entityId: payload.customerId,
          entityType: "customer",
          seq: this.changes.length + 1,
        });
        outcome = {
          code: null,
          commandId: command.commandId,
          replayed: false,
          result: { customerId: payload.customerId, version: 1 },
          status: "accepted",
        };
      }
      this.outcomes.set(command.commandId, outcome);
      results.push(outcome);
      blocked = outcome.status !== "accepted";
    }
    if (this.lostResponses > 0) {
      this.lostResponses -= 1;
      return Promise.reject(new Error("network lost the response"));
    }
    return Promise.resolve({ results });
  };

  getCursor() {
    return Promise.resolve(String(this.changes.length));
  }
  page<K extends BootstrapCollectionName>(
    collection: K,
    request: { ids?: string[] }
  ) {
    const rows =
      collection === "customers"
        ? [...this.customers.values()].filter(
            (row) => !request.ids || request.ids.includes(row.id)
          )
        : [];
    return Promise.resolve({
      nextAfterId: null,
      rows: rows as unknown as LocalRows[K][],
    });
  }
  pull(cursor: string, limit: number) {
    const after = Number(cursor);
    const batch = this.changes
      .filter((change) => change.seq > after)
      .slice(0, limit);
    return Promise.resolve({
      changes: batch,
      hasMore: false,
      nextCursor: String(batch.at(-1)?.seq ?? after),
    });
  }
  recentSales() {
    return Promise.resolve([]);
  }
}

/**
 * A synthetic server for `product.create`: atomic (a refusal stores nothing),
 * idempotent by command ID, unique by product ID and by SKU (case-insensitive,
 * like the database), exposing what it created through the change log.
 */
export class FakeCatalogServer implements BootstrapSource {
  readonly products = new Map<string, LocalProductReadModel>();
  readonly variants = new Map<string, LocalVariantReadModel>();
  readonly inventory = new Map<string, LocalInventoryReadModel>();
  readonly outcomes = new Map<string, PushResultReadModel>();
  readonly changes: SyncChangeReadModel[] = [];
  executions = 0;
  requests = 0;
  lostResponses = 0;

  private refuse(commandId: string, code: string): PushResultReadModel {
    return {
      code,
      commandId,
      replayed: false,
      result: null,
      status: "rejected",
    };
  }

  private execute(command: PushCommandReadModel): PushResultReadModel {
    const payload = command.payload as {
      categoryId: string | null;
      description: string | null;
      initialStock: { quantity: number } | null;
      listPrice: string | null;
      name: string;
      productId: string;
      sku: string | null;
      variantId: string;
    };
    if (this.products.has(payload.productId)) {
      return this.refuse(command.commandId, "product_id_conflict");
    }
    const sku = payload.sku?.toLowerCase() ?? null;
    if (
      sku !== null &&
      [...this.variants.values()].some(
        (variant) => variant.sku?.toLowerCase() === sku
      )
    ) {
      return this.refuse(command.commandId, "sku_conflict");
    }
    const at = "2026-10-14T13:00:00.000Z";
    this.products.set(payload.productId, {
      archivedAt: null,
      categoryId: payload.categoryId,
      deletedAt: null,
      description: payload.description,
      id: payload.productId,
      name: payload.name,
      updatedAt: at,
      version: 1,
    });
    this.variants.set(payload.variantId, {
      id: payload.variantId,
      isDefault: true,
      listPrice: payload.listPrice,
      position: null,
      productId: payload.productId,
      sku: payload.sku,
      values: [],
    });
    this.changes.push({
      entityId: payload.productId,
      entityType: "product",
      seq: this.changes.length + 1,
    });
    if (payload.initialStock) {
      this.inventory.set(payload.variantId, {
        productId: payload.productId,
        quantity: payload.initialStock.quantity,
        updatedAt: at,
        variantId: payload.variantId,
        version: 1,
      });
      this.changes.push({
        entityId: payload.variantId,
        entityType: "inventory_balance",
        seq: this.changes.length + 1,
      });
    }
    return {
      code: null,
      commandId: command.commandId,
      replayed: false,
      result: { productId: payload.productId, variantId: payload.variantId },
      status: "accepted",
    };
  }

  push = (input: { commands: PushCommandReadModel[] }) => {
    this.requests += 1;
    const results: PushResultReadModel[] = [];
    let blocked = false;
    for (const command of input.commands) {
      if (blocked) {
        results.push({
          code: null,
          commandId: command.commandId,
          replayed: false,
          result: null,
          status: "not_processed",
        });
        continue;
      }
      const seen = this.outcomes.get(command.commandId);
      if (seen) {
        results.push({ ...seen, replayed: true });
        blocked = seen.status !== "accepted";
        continue;
      }
      this.executions += 1;
      const outcome = this.execute(command);
      this.outcomes.set(command.commandId, outcome);
      results.push(outcome);
      blocked = outcome.status !== "accepted";
    }
    if (this.lostResponses > 0) {
      this.lostResponses -= 1;
      return Promise.reject(new Error("network lost the response"));
    }
    return Promise.resolve({ results });
  };

  getCursor() {
    return Promise.resolve(String(this.changes.length));
  }
  page<K extends BootstrapCollectionName>(
    collection: K,
    request: { ids?: string[] }
  ) {
    const wanted = (id: string) => !request.ids || request.ids.includes(id);
    let rows: unknown[] = [];
    if (collection === "products") {
      rows = [...this.products.values()].filter((row) => wanted(row.id));
    } else if (collection === "variants") {
      // variants are asked for by the IDs of their products
      rows = [...this.variants.values()].filter((row) => wanted(row.productId));
    } else if (collection === "inventory") {
      rows = [...this.inventory.values()].filter((row) =>
        wanted(row.variantId)
      );
    }
    return Promise.resolve({
      nextAfterId: null,
      rows: rows as LocalRows[K][],
    });
  }
  pull(cursor: string, limit: number) {
    const after = Number(cursor);
    const batch = this.changes
      .filter((change) => change.seq > after)
      .slice(0, limit);
    return Promise.resolve({
      changes: batch,
      hasMore: false,
      nextCursor: String(batch.at(-1)?.seq ?? after),
    });
  }
  recentSales() {
    return Promise.resolve([]);
  }
}

/**
 * A synthetic server for the stock commands: idempotent by command ID, refusing
 * a write-off below zero and a count made against a stale balance version, like
 * the real ledger. Every movement moves the balance version by one.
 */
export class FakeStockServer implements BootstrapSource {
  readonly balances = new Map<string, LocalInventoryReadModel>();
  readonly outcomes = new Map<string, PushResultReadModel>();
  readonly changes: SyncChangeReadModel[] = [];
  executions = 0;
  requests = 0;
  lostResponses = 0;

  /** Puts a balance on the server (and nowhere else). */
  seed(variantId: string, quantity: number, version: number) {
    this.balances.set(variantId, {
      productId: "0199c2d0-0000-7000-8000-0000000000f1",
      quantity,
      updatedAt: "2026-10-14T12:00:00.000Z",
      variantId,
      version,
    });
  }

  private refuse(commandId: string, code: string): PushResultReadModel {
    return {
      code,
      commandId,
      replayed: false,
      result: null,
      status: "rejected",
    };
  }

  private execute(command: PushCommandReadModel): PushResultReadModel {
    if (command.type === "sale.confirm") {
      return this.executeSale(command);
    }
    const payload = command.payload as {
      physicalQuantity?: number;
      quantity?: number;
      variantId: string;
    };
    const current = this.balances.get(payload.variantId);
    const quantity = current?.quantity ?? 0;
    const version = current?.version ?? 0;
    let next: number;
    if (command.type === "stock.receive") {
      next = quantity + (payload.quantity ?? 0);
    } else if (command.type === "stock.write_off") {
      next = quantity - (payload.quantity ?? 0);
      if (next < 0) {
        return this.refuse(command.commandId, "insufficient_stock");
      }
    } else if (command.type === "stock.count") {
      if (version !== command.baseVersion) {
        return this.refuse(command.commandId, "inventory_version_conflict");
      }
      next = payload.physicalQuantity ?? 0;
    } else {
      return this.refuse(command.commandId, "unsupported_command_type");
    }
    this.balances.set(payload.variantId, {
      productId: "0199c2d0-0000-7000-8000-0000000000f1",
      quantity: next,
      updatedAt: "2026-10-14T13:00:00.000Z",
      variantId: payload.variantId,
      version: version + 1,
    });
    this.changes.push({
      entityId: payload.variantId,
      entityType: "inventory_balance",
      seq: this.changes.length + 1,
    });
    return {
      code: null,
      commandId: command.commandId,
      replayed: false,
      result: {
        quantity: next,
        variantId: payload.variantId,
        version: version + 1,
      },
      status: "accepted",
    };
  }

  /** Sales confirmed, by command ID. */
  readonly sales = new Map<string, { saleId: string }>();

  /** A sale takes stock from every line or is refused whole (no partial sale). */
  private executeSale(command: PushCommandReadModel): PushResultReadModel {
    const { items } = command.payload as {
      items: { quantity: number; variantId: string }[];
    };
    const draft = new Map<string, { quantity: number; version: number }>();
    for (const item of items) {
      const held = draft.get(item.variantId) ?? {
        quantity: this.balances.get(item.variantId)?.quantity ?? 0,
        version: this.balances.get(item.variantId)?.version ?? 0,
      };
      if (held.quantity < item.quantity) {
        return this.refuse(command.commandId, "insufficient_stock");
      }
      draft.set(item.variantId, {
        quantity: held.quantity - item.quantity,
        version: held.version + 1,
      });
    }
    for (const [variantId, next] of draft) {
      this.balances.set(variantId, {
        productId: "0199c2d0-0000-7000-8000-0000000000f1",
        quantity: next.quantity,
        updatedAt: "2026-10-14T13:00:00.000Z",
        variantId,
        version: next.version,
      });
      this.changes.push({
        entityId: variantId,
        entityType: "inventory_balance",
        seq: this.changes.length + 1,
      });
    }
    const saleId = `0199c2d0-0000-7000-8000-${String(this.sales.size + 1).padStart(12, "0")}`;
    this.sales.set(command.commandId, { saleId });
    return {
      code: null,
      commandId: command.commandId,
      replayed: false,
      result: { saleId, totalDue: "0.00" },
      status: "accepted",
    };
  }

  push = (input: { commands: PushCommandReadModel[] }) => {
    this.requests += 1;
    const results: PushResultReadModel[] = [];
    let blocked = false;
    for (const command of input.commands) {
      if (blocked) {
        results.push({
          code: null,
          commandId: command.commandId,
          replayed: false,
          result: null,
          status: "not_processed",
        });
        continue;
      }
      const seen = this.outcomes.get(command.commandId);
      if (seen) {
        results.push({ ...seen, replayed: true });
        blocked = seen.status !== "accepted";
        continue;
      }
      this.executions += 1;
      const outcome = this.execute(command);
      this.outcomes.set(command.commandId, outcome);
      results.push(outcome);
      blocked = outcome.status !== "accepted";
    }
    if (this.lostResponses > 0) {
      this.lostResponses -= 1;
      return Promise.reject(new Error("network lost the response"));
    }
    return Promise.resolve({ results });
  };

  getCursor() {
    return Promise.resolve(String(this.changes.length));
  }
  page<K extends BootstrapCollectionName>(
    collection: K,
    request: { ids?: string[] }
  ) {
    const rows =
      collection === "inventory"
        ? [...this.balances.values()].filter(
            (row) => !request.ids || request.ids.includes(row.variantId)
          )
        : [];
    return Promise.resolve({
      nextAfterId: null,
      rows: rows as unknown as LocalRows[K][],
    });
  }
  pull(cursor: string, limit: number) {
    const after = Number(cursor);
    const batch = this.changes
      .filter((change) => change.seq > after)
      .slice(0, limit);
    return Promise.resolve({
      changes: batch,
      hasMore: false,
      nextCursor: String(batch.at(-1)?.seq ?? after),
    });
  }
  recentSales() {
    return Promise.resolve([]);
  }
}
