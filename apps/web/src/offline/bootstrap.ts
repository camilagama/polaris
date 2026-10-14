import type {
  LocalCategoryReadModel,
  LocalCustomerReadModel,
  LocalInventoryReadModel,
  LocalProductReadModel,
  LocalVariantReadModel,
  SaleListEntryReadModel,
  SyncChangeReadModel,
} from "@polaris/contracts";

/**
 * The bootstrap and catch-up of the local collections (plan PR50), written
 * against two small interfaces so it runs the same on the real server and
 * OPFS store and on in-memory fakes:
 *
 * 1. record the change-log cursor BEFORE reading anything;
 * 2. read every collection page by page (keyset), replacing local rows and
 *    dropping local rows the server no longer has;
 * 3. pull from the recorded cursor and re-read what changed meanwhile.
 *
 * Re-reading is idempotent, so changes that land during the snapshot are simply
 * applied again and none is missed. An interrupted run leaves the store marked
 * "bootstrapping" and the next run starts over.
 */
export interface LocalRows {
  categories: LocalCategoryReadModel;
  customers: LocalCustomerReadModel;
  inventory: LocalInventoryReadModel;
  products: LocalProductReadModel;
  variants: LocalVariantReadModel;
}

export type BootstrapCollectionName = keyof LocalRows;

const BOOTSTRAP_COLLECTION_ORDER: readonly BootstrapCollectionName[] = [
  "categories",
  "products",
  "variants",
  "inventory",
  "customers",
];

const LOCAL_STORE_VERSION = 1;
const ID_CHUNK = 200;
/** Products per variants read: the server refuses more, so none is cut short (50 variants each). */
const VARIANT_PRODUCT_CHUNK = 40;

export interface BootstrapPageRequest {
  afterId?: string | null;
  ids?: string[];
  limit?: number;
}

export interface BootstrapSource {
  getCursor: () => Promise<string>;
  page: <K extends BootstrapCollectionName>(
    collection: K,
    request: BootstrapPageRequest
  ) => Promise<{ nextAfterId: string | null; rows: LocalRows[K][] }>;
  pull: (
    cursor: string,
    limit: number
  ) => Promise<{
    changes: SyncChangeReadModel[];
    hasMore: boolean;
    nextCursor: string;
  }>;
  recentSales: () => Promise<SaleListEntryReadModel[]>;
}

export interface LocalSyncMeta {
  bootstrappedAt: string | null;
  /** The change-log cursor the local data is current to, or null before one is known. */
  cursor: string | null;
  status: "bootstrapping" | "ready";
  updatedAt: string;
  version: typeof LOCAL_STORE_VERSION;
}

export interface LocalWriter {
  keys: (collection: BootstrapCollectionName) => Promise<string[]>;
  readMeta: () => Promise<LocalSyncMeta | null>;
  remove: (
    collection: BootstrapCollectionName | "recentSales",
    keys: string[]
  ) => Promise<void>;
  /** Replaces the recent sales window with exactly these rows. */
  replaceRecentSales: (rows: SaleListEntryReadModel[]) => Promise<void>;
  /** Every row of a collection, in no particular order (the screens sort). */
  rows: <K extends BootstrapCollectionName>(
    collection: K
  ) => Promise<LocalRows[K][]>;
  upsert: <K extends BootstrapCollectionName>(
    collection: K,
    rows: LocalRows[K][]
  ) => Promise<void>;
  variantKeysOfProducts: (productIds: string[]) => Promise<string[]>;
  writeMeta: (meta: LocalSyncMeta) => Promise<void>;
}

export interface BootstrapOptions {
  now?: () => Date;
  pageSize?: number;
  pullLimit?: number;
}

export interface BootstrapResult {
  counts: Record<BootstrapCollectionName | "recentSales", number>;
  cursor: string;
}

export function localRowKey<K extends BootstrapCollectionName>(
  collection: K,
  row: LocalRows[K]
): string {
  return collection === "inventory"
    ? (row as LocalInventoryReadModel).variantId
    : (row as { id: string }).id;
}

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function metaOf(
  now: () => Date,
  status: LocalSyncMeta["status"],
  cursor: string | null,
  previous: LocalSyncMeta | null
): LocalSyncMeta {
  const at = now().toISOString();
  return {
    bootstrappedAt:
      status === "ready" ? (previous?.bootstrappedAt ?? at) : null,
    cursor,
    status,
    updatedAt: at,
    version: LOCAL_STORE_VERSION,
  };
}

async function replaceCollection<K extends BootstrapCollectionName>(
  source: BootstrapSource,
  writer: LocalWriter,
  collection: K,
  pageSize: number
): Promise<number> {
  const seen = new Set<string>();
  let afterId: string | null = null;
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: each page needs the previous keyset position
    const page: Awaited<ReturnType<typeof source.page<K>>> = await source.page(
      collection,
      { afterId, limit: pageSize }
    );
    for (const row of page.rows) {
      seen.add(localRowKey(collection, row));
    }
    await writer.upsert(collection, page.rows);
    if (page.nextAfterId === null) {
      break;
    }
    afterId = page.nextAfterId;
  }
  const stale = (await writer.keys(collection)).filter((key) => !seen.has(key));
  if (stale.length > 0) {
    await writer.remove(collection, stale);
  }
  return seen.size;
}

async function refreshRecentSales(
  source: BootstrapSource,
  writer: LocalWriter
): Promise<number> {
  const sales = await source.recentSales();
  await writer.replaceRecentSales(sales);
  return sales.length;
}

/** Re-reads entities by id; present rows are stored, absent ones are dropped. */
async function refreshByIds<K extends BootstrapCollectionName>(
  source: BootstrapSource,
  writer: LocalWriter,
  collection: K,
  ids: string[]
): Promise<void> {
  for (const idsChunk of chunk(ids, ID_CHUNK)) {
    // biome-ignore lint/performance/noAwaitInLoops: chunks are applied in order
    const page = await source.page(collection, { ids: idsChunk });
    await writer.upsert(collection, page.rows);
    const present = new Set(
      page.rows.map((row) => localRowKey(collection, row))
    );
    const gone = idsChunk.filter((id) => !present.has(id));
    if (gone.length > 0) {
      await writer.remove(collection, gone);
    }
  }
}

/** Variants are re-read per product: a product change moves its variants too. */
async function refreshVariantsOfProducts(
  source: BootstrapSource,
  writer: LocalWriter,
  productIds: string[]
): Promise<void> {
  for (const idsChunk of chunk(productIds, VARIANT_PRODUCT_CHUNK)) {
    // biome-ignore lint/performance/noAwaitInLoops: chunks are applied in order
    const page = await source.page("variants", { ids: idsChunk });
    await writer.upsert("variants", page.rows);
    const present = new Set(page.rows.map((row) => row.id));
    const gone = (await writer.variantKeysOfProducts(idsChunk)).filter(
      (key) => !present.has(key)
    );
    if (gone.length > 0) {
      await writer.remove("variants", gone);
    }
  }
}

function idsOf(changes: SyncChangeReadModel[], type: string): string[] {
  return [
    ...new Set(
      changes
        .filter((change) => change.entityType === type)
        .map((c) => c.entityId)
    ),
  ];
}

async function applyChanges(
  source: BootstrapSource,
  writer: LocalWriter,
  changes: SyncChangeReadModel[]
): Promise<{ salesChanged: boolean }> {
  const productIds = idsOf(changes, "product");
  await refreshByIds(source, writer, "categories", idsOf(changes, "category"));
  await refreshByIds(source, writer, "customers", idsOf(changes, "customer"));
  await refreshByIds(source, writer, "products", productIds);
  await refreshVariantsOfProducts(source, writer, productIds);
  await refreshByIds(
    source,
    writer,
    "inventory",
    idsOf(changes, "inventory_balance")
  );
  // Payment profiles are not a local collection yet; sales refresh the window.
  return {
    salesChanged: changes.some((change) => change.entityType === "sale"),
  };
}

/**
 * Applies the changes after `from` until the log is exhausted, saving the
 * cursor after every page. Returns the cursor the local data is current to.
 */
export async function pullLocalChanges(
  source: BootstrapSource,
  writer: LocalWriter,
  from: string,
  options: BootstrapOptions = {}
): Promise<string> {
  const now = options.now ?? (() => new Date());
  const limit = options.pullLimit ?? 500;
  let cursor = from;
  let salesChanged = false;
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: pages are applied in commit order
    const page = await source.pull(cursor, limit);
    const applied = await applyChanges(source, writer, page.changes);
    salesChanged = salesChanged || applied.salesChanged;
    cursor = page.nextCursor;
    // A ready store stays ready while it catches up; a snapshot in progress stays so.
    const previous = await writer.readMeta();
    await writer.writeMeta(
      metaOf(now, previous?.status ?? "bootstrapping", cursor, previous)
    );
    if (!page.hasMore) {
      break;
    }
  }
  if (salesChanged) {
    await refreshRecentSales(source, writer);
  }
  return cursor;
}

/**
 * The first load of a namespace: snapshot, then catch-up. Safe to run again at
 * any time; it replaces what is local with what the server has.
 */
export async function bootstrapLocalStore(
  source: BootstrapSource,
  writer: LocalWriter,
  options: BootstrapOptions = {}
): Promise<BootstrapResult> {
  const now = options.now ?? (() => new Date());
  const pageSize = options.pageSize ?? 200;
  const previous = await writer.readMeta();
  await writer.writeMeta(metaOf(now, "bootstrapping", null, previous));

  const startCursor = await source.getCursor();
  const counts = {
    categories: 0,
    customers: 0,
    inventory: 0,
    products: 0,
    recentSales: 0,
    variants: 0,
  };
  for (const collection of BOOTSTRAP_COLLECTION_ORDER) {
    // biome-ignore lint/performance/noAwaitInLoops: collections are read one after another
    counts[collection] = await replaceCollection(
      source,
      writer,
      collection,
      pageSize
    );
  }
  counts.recentSales = await refreshRecentSales(source, writer);
  await writer.writeMeta(
    metaOf(now, "bootstrapping", startCursor, await writer.readMeta())
  );

  const cursor = await pullLocalChanges(source, writer, startCursor, options);
  await writer.writeMeta(metaOf(now, "ready", cursor, await writer.readMeta()));
  return { counts, cursor };
}

/** True when the store holds a complete snapshot that catch-up can extend. */
export function isLocalStoreReady(meta: LocalSyncMeta | null): boolean {
  return (
    meta !== null &&
    meta.status === "ready" &&
    meta.cursor !== null &&
    meta.version === LOCAL_STORE_VERSION
  );
}
