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

/** Removes the whole outbox database of a namespace. Close it first. */
export function deleteOutboxDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deleting = indexedDB.deleteDatabase(name);
    deleting.onsuccess = () => resolve();
    deleting.onerror = () =>
      reject(deleting.error ?? new Error("indexeddb_delete_failed"));
    deleting.onblocked = () =>
      reject(new OutboxStorageUnavailableError("O outbox está em uso."));
  });
}
