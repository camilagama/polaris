import {
  type ThumbnailDisk,
  type ThumbnailUsage,
  thumbnailsToEvict,
} from "../catalog/thumbnail-cache";

/**
 * The thumbnails of one namespace (user + store) on the disk: an IndexedDB database of its own, next to the outbox
 * of the namespace (ADR 0015), with one store, `thumbnails`, keyed by `assetId`. It is a cache of bytes the server
 * can send again, never a source of truth, so it lives outside the SQLite file of the local collections and is
 * deleted whole with the namespace (`wipeThumbnails`).
 *
 * The name is the namespace hash, never the raw ids, like the other databases of the namespace.
 */
const THUMBNAILS = "thumbnails";
/** `[lastUsed, size]`: the eviction walks this index with a key cursor, without loading a single image. */
const USAGE = "usage";
const DATABASE_VERSION = 1;

interface ThumbnailRecord {
  assetId: string;
  bytes: ArrayBuffer;
  lastUsed: number;
  size: number;
}

function thumbnailDatabaseName(namespaceKey: string): string {
  return `polaris-thumbnails-${namespaceKey}`;
}

function request<T>(source: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    source.onsuccess = () => resolve(source.result);
    source.onerror = () =>
      reject(source.error ?? new Error("indexeddb_request_failed"));
  });
}

function finished(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("indexeddb_failed"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("indexeddb_aborted"));
  });
}

function usageOf(store: IDBObjectStore): Promise<ThumbnailUsage[]> {
  return new Promise((resolve, reject) => {
    const entries: ThumbnailUsage[] = [];
    const cursor = store.index(USAGE).openKeyCursor();
    cursor.onerror = () =>
      reject(cursor.error ?? new Error("indexeddb_cursor_failed"));
    cursor.onsuccess = () => {
      const at = cursor.result;
      if (!at) {
        resolve(entries);
        return;
      }
      const [lastUsed, size] = at.key as [number, number];
      entries.push({ assetId: String(at.primaryKey), lastUsed, size });
      at.continue();
    };
  });
}

/** Called when the database of a namespace goes away under an open cache (this tab or another one wiped it). */
type GoneListener = () => void;
const listeners = new Map<string, Set<GoneListener>>();

function listen(namespaceKey: string, onGone: GoneListener): () => void {
  const set = listeners.get(namespaceKey) ?? new Set();
  set.add(onGone);
  listeners.set(namespaceKey, set);
  return () => {
    set.delete(onGone);
    if (set.size === 0) {
      listeners.delete(namespaceKey);
    }
  };
}

function announceGone(namespaceKey: string): void {
  for (const onGone of [...(listeners.get(namespaceKey) ?? [])]) {
    onGone();
  }
}

class ThumbnailStorageUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThumbnailStorageUnavailableError";
  }
}

/**
 * Opens the thumbnails database of a namespace. A browser that refuses IndexedDB rejects here, and the cache goes on
 * in memory. `onGone` runs once if the database is deleted or upgraded while open: the connection closes at once so
 * the deletion is never blocked by it.
 */
export function openThumbnailDisk(
  namespaceKey: string,
  onGone: GoneListener = () => undefined
): Promise<ThumbnailDisk> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(
      new ThumbnailStorageUnavailableError("indexeddb_unavailable")
    );
  }
  return new Promise((resolve, reject) => {
    let opening: IDBOpenDBRequest;
    try {
      opening = indexedDB.open(
        thumbnailDatabaseName(namespaceKey),
        DATABASE_VERSION
      );
    } catch (error) {
      reject(error);
      return;
    }
    opening.onupgradeneeded = () => {
      opening.result
        .createObjectStore(THUMBNAILS, { keyPath: "assetId" })
        .createIndex(USAGE, ["lastUsed", "size"]);
    };
    opening.onerror = () =>
      reject(
        new ThumbnailStorageUnavailableError(
          opening.error?.message ?? "indexeddb_open_failed"
        )
      );
    opening.onblocked = () =>
      reject(new ThumbnailStorageUnavailableError("indexeddb_blocked"));
    opening.onsuccess = () => {
      const database = opening.result;
      let closed = false;
      let stopListening: (() => void) | null = null;
      const close = () => {
        if (closed) {
          return;
        }
        closed = true;
        stopListening?.();
        database.close();
      };
      const gone = () => {
        const wasOpen = !closed;
        close();
        if (wasOpen) {
          onGone();
        }
      };
      stopListening = listen(namespaceKey, gone);
      database.onversionchange = gone;
      database.onclose = gone;
      const transaction = (mode: IDBTransactionMode) => {
        if (closed) {
          throw new ThumbnailStorageUnavailableError("thumbnails_closed");
        }
        return database.transaction(THUMBNAILS, mode);
      };
      resolve({
        close,
        async has(assetIds) {
          const tx = transaction("readonly");
          const store = tx.objectStore(THUMBNAILS);
          const counts = await Promise.all(
            assetIds.map((id) => request(store.count(id)))
          );
          return new Set(assetIds.filter((_, index) => counts[index] === 1));
        },
        async take(assetId, now) {
          const tx = transaction("readwrite");
          const done = finished(tx);
          const store = tx.objectStore(THUMBNAILS);
          const record = (await request(store.get(assetId))) as
            | ThumbnailRecord
            | undefined;
          if (record) {
            store.put({ ...record, lastUsed: now });
          }
          await done;
          return record?.bytes;
        },
        async touch(assetId, now) {
          const tx = transaction("readwrite");
          const done = finished(tx);
          const store = tx.objectStore(THUMBNAILS);
          const record = (await request(store.get(assetId))) as
            | ThumbnailRecord
            | undefined;
          if (record) {
            store.put({ ...record, lastUsed: now });
          }
          await done;
        },
        async write(assetId, bytes, now, budgetBytes) {
          const tx = transaction("readwrite");
          const done = finished(tx);
          const store = tx.objectStore(THUMBNAILS);
          const record: ThumbnailRecord = {
            assetId,
            bytes,
            lastUsed: now,
            size: bytes.byteLength,
          };
          store.put(record);
          const evicted = thumbnailsToEvict(
            await usageOf(store),
            budgetBytes,
            assetId
          );
          for (const id of evicted) {
            store.delete(id);
          }
          await done;
        },
      });
    };
  });
}

/**
 * Deletes the thumbnails database of a namespace: logout, revocation of the access, the emptying of its queue and
 * the switch to another store all end here. Open caches of this tab let go of their URLs first; another tab's
 * connection closes on `versionchange`. A database that does not exist is fine.
 */
export function wipeThumbnails(namespaceKey: string): Promise<void> {
  announceGone(namespaceKey);
  if (typeof indexedDB === "undefined") {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const deleting = indexedDB.deleteDatabase(
      thumbnailDatabaseName(namespaceKey)
    );
    deleting.onsuccess = () => resolve();
    deleting.onerror = () =>
      reject(deleting.error ?? new Error("thumbnails_wipe_failed"));
    // `blocked` only says a connection is still closing: the deletion goes on once it closes
  });
}
