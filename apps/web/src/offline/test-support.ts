import type {
  LocalCustomerReadModel,
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
  variantKeysOfProducts() {
    return Promise.resolve([]);
  }
  writeMeta(meta: LocalSyncMeta) {
    this.meta = meta;
    return Promise.resolve();
  }
  customer(id: string) {
    return this.data.customers.get(id) as LocalCustomerReadModel | undefined;
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
