import type { SaleListEntryReadModel } from "@polaris/contracts";
import {
  BrowserCollectionCoordinator,
  createBrowserWASQLitePersistence,
  openBrowserWASQLiteOPFSDatabase,
  persistedCollectionOptions,
} from "@tanstack/browser-db-sqlite-persistence";
import { createCollection } from "@tanstack/db";
import type {
  BootstrapCollectionName,
  LocalRows,
  LocalSyncMeta,
  LocalWriter,
} from "./bootstrap";
import type { LocalNamespace } from "./namespace";
import type { LocalVariantReader } from "./sale-confirm";
import type { LocalInventoryReader } from "./stock-commands";

/**
 * The local collections on a device (plan PR50): TanStack DB over SQLite WASM
 * in OPFS (ADR 0015), one database per user and organization. Failures are
 * explicit: no silent fallback to memory or localStorage, and a schema mismatch
 * fails closed instead of discarding local data.
 */
const LOCAL_SCHEMA_VERSION = 1;
const META_KEY = "sync";

type MetaRow = LocalSyncMeta & { id: string };

/** The slice of a TanStack collection this module relies on. */
interface CollectionLike<T extends object> {
  delete: (keys: string[]) => { isPersisted: { promise: Promise<unknown> } };
  get: (key: string) => T | undefined;
  has: (key: string) => boolean;
  insert: (rows: T[]) => { isPersisted: { promise: Promise<unknown> } };
  keys: () => IterableIterator<string>;
  toArrayWhenReady: () => Promise<T[]>;
  update: (
    keys: string[],
    callback: (drafts: T[]) => void
  ) => { isPersisted: { promise: Promise<unknown> } };
}

type SaleRow = SaleListEntryReadModel;

interface LocalStoreCollections {
  categories: CollectionLike<LocalRows["categories"]>;
  customers: CollectionLike<LocalRows["customers"]>;
  inventory: CollectionLike<LocalRows["inventory"]>;
  products: CollectionLike<LocalRows["products"]>;
  recentSales: CollectionLike<SaleRow>;
  syncMeta: CollectionLike<MetaRow>;
  variants: CollectionLike<LocalRows["variants"]>;
}

export interface LocalStore {
  close: () => Promise<void>;
  collections: LocalStoreCollections;
  namespace: LocalNamespace;
  writer: LocalWriter & LocalInventoryReader & LocalVariantReader;
}

interface LocalStoreSupport {
  indexedDb: boolean;
  opfs: boolean;
  secureContext: boolean;
  webLocks: boolean;
}

function inspectLocalStoreSupport(): LocalStoreSupport {
  const storage =
    typeof navigator === "undefined" ? undefined : navigator.storage;
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  return {
    indexedDb: typeof indexedDB !== "undefined",
    opfs: typeof storage?.getDirectory === "function",
    secureContext: typeof window !== "undefined" && window.isSecureContext,
    webLocks: typeof locks?.request === "function",
  };
}

class LocalStoreUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalStoreUnavailableError";
  }
}

function assertSupported(support: LocalStoreSupport): void {
  if (!support.secureContext) {
    throw new LocalStoreUnavailableError(
      "O armazenamento local exige um contexto seguro (HTTPS)."
    );
  }
  if (!support.opfs) {
    throw new LocalStoreUnavailableError(
      "Este navegador não disponibiliza o armazenamento OPFS."
    );
  }
}

type Persistence = ReturnType<typeof createBrowserWASQLitePersistence>;

function collectionFor<T extends object>(
  persistence: Persistence,
  name: string
): CollectionLike<T> {
  return createCollection(
    persistedCollectionOptions<T & Record<string, unknown>, string>({
      getKey: (row) =>
        String(
          (row as { id?: string; variantId?: string }).id ??
            (row as { variantId?: string }).variantId
        ),
      id: `polaris-local-${name}-v${LOCAL_SCHEMA_VERSION}`,
      persistence,
      schemaVersion: LOCAL_SCHEMA_VERSION,
    })
  ) as unknown as CollectionLike<T>;
}

async function persisted(transaction: {
  isPersisted: { promise: Promise<unknown> };
}): Promise<void> {
  await transaction.isPersisted.promise;
}

/** Inserts what is new and updates what exists, waiting until it is on disk. */
async function upsertInto<T extends object>(
  collection: CollectionLike<T>,
  keyOf: (row: T) => string,
  rows: T[]
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  const fresh = rows.filter((row) => !collection.has(keyOf(row)));
  const existing = rows.filter((row) => collection.has(keyOf(row)));
  if (fresh.length > 0) {
    await persisted(collection.insert(fresh));
  }
  if (existing.length > 0) {
    await persisted(
      collection.update(existing.map(keyOf), (drafts) => {
        drafts.forEach((draft, index) => {
          const next = existing[index];
          if (next) {
            Object.assign(draft, next);
          }
        });
      })
    );
  }
}

async function removeFrom<T extends object>(
  collection: CollectionLike<T>,
  keys: string[]
): Promise<void> {
  const present = keys.filter((key) => collection.has(key));
  if (present.length > 0) {
    await persisted(collection.delete(present));
  }
}

function createWriter(
  collections: LocalStoreCollections
): LocalWriter & LocalInventoryReader & LocalVariantReader {
  const keyed = {
    categories: (row: LocalRows["categories"]) => row.id,
    customers: (row: LocalRows["customers"]) => row.id,
    inventory: (row: LocalRows["inventory"]) => row.variantId,
    products: (row: LocalRows["products"]) => row.id,
    variants: (row: LocalRows["variants"]) => row.id,
  };
  return {
    inventoryRow: (variantId) =>
      Promise.resolve(collections.inventory.get(variantId)),
    keys: (collection) => Promise.resolve([...collections[collection].keys()]),
    readMeta() {
      const row = collections.syncMeta.get(META_KEY);
      if (!row) {
        return Promise.resolve(null);
      }
      const { id: _id, ...meta } = row;
      return Promise.resolve(meta);
    },
    async remove(collection, keys) {
      await removeFrom(
        collections[collection] as unknown as CollectionLike<object>,
        keys
      );
    },
    async replaceRecentSales(rows) {
      await upsertInto(collections.recentSales, (row) => row.id, rows);
      const wanted = new Set(rows.map((row) => row.id));
      await removeFrom(
        collections.recentSales,
        [...collections.recentSales.keys()].filter((key) => !wanted.has(key))
      );
    },
    async upsert<K extends BootstrapCollectionName>(
      collection: K,
      rows: LocalRows[K][]
    ) {
      await upsertInto(
        collections[collection] as unknown as CollectionLike<LocalRows[K]>,
        keyed[collection] as (row: LocalRows[K]) => string,
        rows
      );
    },
    async variantKeysOfProducts(productIds) {
      const wanted = new Set(productIds);
      return (await collections.variants.toArrayWhenReady())
        .filter((row) => wanted.has(row.productId))
        .map((row) => row.id);
    },
    variantRow: (variantId) =>
      Promise.resolve(collections.variants.get(variantId)),
    async writeMeta(meta) {
      await upsertInto(collections.syncMeta, (row) => row.id, [
        { ...meta, id: META_KEY },
      ]);
    },
  };
}

/**
 * Opens (creating on first use) the local database of one namespace. Several
 * tabs share it through the coordinator. The caller must `close()` it.
 */
export async function openLocalStore(
  namespace: LocalNamespace
): Promise<LocalStore> {
  assertSupported(inspectLocalStoreSupport());
  const database = await openBrowserWASQLiteOPFSDatabase({
    databaseName: namespace.databaseFile,
  });
  const coordinator = new BrowserCollectionCoordinator({
    dbName: namespace.coordinatorName,
  });
  const persistence = createBrowserWASQLitePersistence({
    coordinator,
    database,
    // A schema mismatch must fail closed: local data is never discarded silently.
    schemaMismatchPolicy: "sync-absent-error",
  });
  const collections: LocalStoreCollections = {
    categories: collectionFor(persistence, "categories"),
    customers: collectionFor(persistence, "customers"),
    inventory: collectionFor(persistence, "inventory"),
    products: collectionFor(persistence, "products"),
    recentSales: collectionFor(persistence, "recent-sales"),
    syncMeta: collectionFor(persistence, "sync-meta"),
    variants: collectionFor(persistence, "variants"),
  };
  try {
    await Promise.all(
      Object.values(collections).map((collection) =>
        collection.toArrayWhenReady()
      )
    );
  } catch (error) {
    coordinator.dispose();
    await database.close?.();
    throw error;
  }
  let closed = false;
  return {
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      coordinator.dispose();
      await database.close?.();
    },
    collections,
    namespace,
    writer: createWriter(collections),
  };
}

/**
 * Deletes the namespace's database file (logout, leaving an organization, or a
 * reset). Close the store first. Missing files are fine.
 */
export async function wipeLocalStore(
  namespace: LocalNamespace
): Promise<{ removedFiles: number }> {
  assertSupported(inspectLocalStoreSupport());
  const root = await navigator.storage.getDirectory();
  let removedFiles = 0;
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: at most four tiny files
      await root.removeEntry(`${namespace.databaseFile}${suffix}`);
      removedFiles += 1;
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== "NotFoundError") {
        throw error;
      }
    }
  }
  return { removedFiles };
}
