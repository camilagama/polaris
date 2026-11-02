import type { OutboxCommand } from "./command";
import type { OutboxStorage, OutboxTransaction } from "./outbox";

/**
 * The durable outbox storage: IndexedDB, one database per namespace (ADR 0015).
 * The store survives reloads, closing the tab and restarting the browser; the
 * sequence counter lives in the same transaction as the command it numbers, so
 * a position is never reused or skipped by a crash.
 */
const COMMANDS = "commands";
const META = "meta";
const LAST_SEQ = "lastSeq";
const DATABASE_VERSION = 1;

class OutboxStorageUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboxStorageUnavailableError";
  }
}

function request<T>(source: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    source.onsuccess = () => resolve(source.result);
    source.onerror = () =>
      reject(source.error ?? new Error("indexeddb_request_failed"));
  });
}

export function outboxDatabaseName(namespaceKey: string): string {
  return `polaris-outbox-${namespaceKey}`;
}

export class IndexedDbOutboxStorage implements OutboxStorage {
  private readonly database: IDBDatabase;

  private constructor(database: IDBDatabase) {
    this.database = database;
  }

  static open(name: string): Promise<IndexedDbOutboxStorage> {
    if (typeof indexedDB === "undefined") {
      return Promise.reject(
        new OutboxStorageUnavailableError(
          "Este navegador não disponibiliza IndexedDB para o outbox."
        )
      );
    }
    return new Promise((resolve, reject) => {
      const opening = indexedDB.open(name, DATABASE_VERSION);
      opening.onupgradeneeded = () => {
        const database = opening.result;
        const commands = database.createObjectStore(COMMANDS, {
          keyPath: "commandId",
        });
        commands.createIndex("seq", "seq", { unique: true });
        database.createObjectStore(META);
      };
      opening.onsuccess = () =>
        resolve(new IndexedDbOutboxStorage(opening.result));
      opening.onerror = () =>
        reject(
          new OutboxStorageUnavailableError(
            opening.error?.message ?? "Falha ao abrir o outbox."
          )
        );
      opening.onblocked = () =>
        reject(new OutboxStorageUnavailableError("O outbox está bloqueado."));
    });
  }

  close(): void {
    this.database.close();
  }

  async transaction<T>(
    work: (tx: OutboxTransaction) => Promise<T>
  ): Promise<T> {
    const idb = this.database.transaction([COMMANDS, META], "readwrite");
    const done = new Promise<void>((resolve, reject) => {
      idb.oncomplete = () => resolve();
      idb.onerror = () => reject(idb.error ?? new Error("indexeddb_failed"));
      idb.onabort = () => reject(idb.error ?? new Error("indexeddb_aborted"));
    });
    const commands = idb.objectStore(COMMANDS);
    const meta = idb.objectStore(META);
    const tx: OutboxTransaction = {
      all: () => request(commands.getAll() as IDBRequest<OutboxCommand[]>),
      delete: async (commandId) => {
        await request(commands.delete(commandId));
      },
      get: (commandId) =>
        request(
          commands.get(commandId) as IDBRequest<OutboxCommand | undefined>
        ),
      nextSeq: async () => {
        const last = (await request(meta.get(LAST_SEQ))) as number | undefined;
        const next = (last ?? 0) + 1;
        await request(meta.put(next, LAST_SEQ));
        return next;
      },
      put: async (command) => {
        await request(commands.put(command));
      },
    };
    let result: T;
    try {
      result = await work(tx);
    } catch (error) {
      done.catch(() => undefined);
      try {
        idb.abort();
      } catch {
        // already finished
      }
      throw error;
    }
    await done;
    return result;
  }
}

/**
 * Opens an outbox database only if it already exists. Opening a missing one
 * would create it; aborting the upgrade transaction leaves nothing behind.
 */
function openExistingOutbox(name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    let missing = false;
    const opening = indexedDB.open(name);
    opening.onupgradeneeded = () => {
      missing = true;
      opening.transaction?.abort();
    };
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = (event) => {
      if (missing) {
        event.preventDefault();
        resolve(null);
        return;
      }
      reject(
        new OutboxStorageUnavailableError(
          opening.error?.message ?? "Falha ao abrir o outbox."
        )
      );
    };
  });
}

/** How many commands an outbox database holds; 0 when it does not exist, which it never creates. */
export async function countOutboxCommands(name: string): Promise<number> {
  const database = await openExistingOutbox(name);
  if (!database) {
    return 0;
  }
  try {
    return await request(
      database.transaction(COMMANDS, "readonly").objectStore(COMMANDS).count()
    );
  } finally {
    database.close();
  }
}

/**
 * Empties every store of an outbox database in ONE readwrite transaction, after
 * `allow` saw the command count read inside it; if `allow` throws, the
 * transaction aborts and nothing is cleared. The database itself stays: a
 * `deleteDatabase` blocked by another tab's connection is not cancelled, and
 * would later remove what that tab queued in the meantime.
 */
export async function clearOutboxDatabase(
  name: string,
  allow: (count: number) => void
): Promise<number> {
  const database = await openExistingOutbox(name);
  if (!database) {
    allow(0);
    return 0;
  }
  try {
    return await new Promise<number>((resolve, reject) => {
      const stores = [...database.objectStoreNames];
      const idb = database.transaction(stores, "readwrite");
      let count = 0;
      let refusal: unknown = null;
      idb.oncomplete = () => resolve(count);
      idb.onabort = () =>
        reject(refusal ?? idb.error ?? new Error("indexeddb_aborted"));
      const counting = idb.objectStore(COMMANDS).count();
      counting.onsuccess = () => {
        count = counting.result;
        try {
          allow(count);
          for (const store of stores) {
            idb.objectStore(store).clear();
          }
        } catch (error) {
          refusal = error;
          idb.abort();
        }
      };
    });
  } finally {
    database.close();
  }
}
