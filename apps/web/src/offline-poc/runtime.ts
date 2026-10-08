import {
  BrowserCollectionCoordinator,
  type BrowserWASQLiteDatabase,
  createBrowserWASQLitePersistence,
  openBrowserWASQLiteOPFSDatabase,
  persistedCollectionOptions,
} from "@tanstack/browser-db-sqlite-persistence";
import { createCollection } from "@tanstack/db";
import {
  IndexedDBAdapter,
  type OfflineExecutor,
  type OfflineTransaction,
  type OnlineDetector,
  startOfflineExecutor,
} from "@tanstack/offline-transactions";

export const OFFLINE_POC_DATABASE_FILE = "polaris-pr12-offline-poc.sqlite";
export const SHARED_RECORD_ID = "polaris-pr12-shared-concurrent-record";
const COORDINATOR_NAME = "polaris-pr12-offline-poc";
const OUTBOX_DATABASE_NAME = "polaris-pr12-offline-poc-outbox";
const OUTBOX_STORE_NAME = "transactions";
const MOCK_SERVER_DATABASE_NAME = "polaris-pr12-offline-poc-mock-server";
const MOCK_SERVER_STORE_NAME = "receipts";
const CONNECTIVITY_CHANNEL_NAME = "polaris-pr12-offline-poc-connectivity";
const MOCK_RECEIPT_PREFIX = "receipt:";
const RESET_JOURNAL_DATABASE_NAME = "polaris-pr12-offline-poc-reset-journal";
const RESET_JOURNAL_STORE_NAME = "journal";
const RESET_JOURNAL_RECORD_KEY = "reset";
const RESET_JOURNAL_LOCK_NAME = "polaris-pr12-offline-poc-reset-recovery";
const RESET_JOURNAL_PENDING_VALUE = "pending";

export type OfflinePocRelease = 1 | 2;

export interface OfflineNoteV1 {
  createdAt: string;
  formatVersion: 1;
  id: string;
  origin: "created";
  title: string;
}

export interface OfflineNoteV2 {
  category: string;
  createdAt: string;
  formatVersion: 2;
  id: string;
  origin: "created" | "migration";
  title: string;
}

export interface OfflinePocCapabilities {
  broadcastChannel: boolean;
  indexedDb: boolean;
  opfs: boolean;
  secureContext: boolean;
  webLocks: boolean;
}

interface OfflinePocDiagnostics {
  storageFailure?: string;
  unknownMutation?: { mutationFnName: string; transactionId: string };
}

export interface OfflinePocMigrationResult {
  copied: number;
  sourceCount: number;
  targetCount: number;
}

export interface OfflinePocRuntime {
  capabilities: OfflinePocCapabilities;
  close: () => Promise<void>;
  database: BrowserWASQLiteDatabase;
  diagnostics: OfflinePocDiagnostics;
  executor: OfflineExecutor;
  mockServerStorage: IndexedDBAdapter;
  notesV1: ReturnType<typeof createNotesV1Collection>;
  notesV2?: ReturnType<typeof createNotesV2Collection>;
  onlineDetector: MockOnlineDetector;
  outboxStorage: IndexedDBAdapter;
  release: OfflinePocRelease;
}

export interface OfflinePocResetResult {
  removedDatabaseFile: boolean;
}

export function inspectOfflinePocCapabilities(): OfflinePocCapabilities {
  const storage =
    typeof navigator === "undefined" ? undefined : navigator.storage;
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;

  return {
    broadcastChannel: typeof BroadcastChannel !== "undefined",
    indexedDb: typeof indexedDB !== "undefined",
    opfs: typeof storage?.getDirectory === "function",
    secureContext: typeof window !== "undefined" && window.isSecureContext,
    webLocks: typeof locks?.request === "function",
  };
}

class MockOnlineDetector implements OnlineDetector {
  private readonly channel: BroadcastChannel | undefined;
  private isOnlineValue: boolean;
  private readonly listeners = new Set<() => void>();

  constructor() {
    this.isOnlineValue = false;
    if (typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel(CONNECTIVITY_CHANNEL_NAME);
      this.channel.addEventListener("message", this.handleMessage);
    }
  }

  private readonly handleMessage = (event: MessageEvent<unknown>) => {
    if (
      !event.data ||
      typeof event.data !== "object" ||
      !("type" in event.data) ||
      event.data.type !== "mock-online-change" ||
      !("online" in event.data) ||
      typeof event.data.online !== "boolean"
    ) {
      return;
    }

    this.updateOnlineState(event.data.online);
  };

  private updateOnlineState(isOnline: boolean) {
    if (this.isOnlineValue === isOnline) {
      return;
    }

    this.isOnlineValue = isOnline;
    for (const listener of this.listeners) {
      listener();
    }
  }

  setOnline(isOnline: boolean) {
    this.updateOnlineState(isOnline);
    this.channel?.postMessage({ online: isOnline, type: "mock-online-change" });
  }

  subscribe(callback: () => void) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  notifyOnline() {
    for (const listener of this.listeners) {
      listener();
    }
  }

  isOnline() {
    return this.isOnlineValue;
  }

  dispose() {
    this.channel?.removeEventListener("message", this.handleMessage);
    this.channel?.close();
    this.listeners.clear();
  }
}

function createNotesV1Collection(
  persistence: ReturnType<typeof createBrowserWASQLitePersistence>
) {
  return createCollection(
    persistedCollectionOptions<OfflineNoteV1, string>({
      getKey: (note) => note.id,
      id: "offline-poc-notes-v1",
      persistence,
      schemaVersion: 1,
    })
  );
}

function createNotesV2Collection(
  persistence: ReturnType<typeof createBrowserWASQLitePersistence>
) {
  return createCollection(
    persistedCollectionOptions<OfflineNoteV2, string>({
      getKey: (note) => note.id,
      id: "offline-poc-notes-v2",
      persistence,
      schemaVersion: 2,
    })
  );
}

export async function createOfflinePocRuntime(
  release: OfflinePocRelease
): Promise<OfflinePocRuntime> {
  const capabilities = inspectOfflinePocCapabilities();

  if (!capabilities.secureContext) {
    throw new Error("OPFS exige um contexto seguro (HTTPS ou localhost).");
  }
  if (!capabilities.opfs) {
    throw new Error("Este navegador não disponibiliza o armazenamento OPFS.");
  }
  if (!capabilities.indexedDb) {
    throw new Error(
      "Este navegador não disponibiliza IndexedDB para o outbox."
    );
  }

  const storageProbe = await IndexedDBAdapter.probe();
  if (!storageProbe.available) {
    throw new Error(
      `IndexedDB não está disponível para o outbox: ${storageProbe.error?.message ?? "causa desconhecida"}`
    );
  }

  const database = await openBrowserWASQLiteOPFSDatabase({
    databaseName: OFFLINE_POC_DATABASE_FILE,
  });
  const coordinator = new BrowserCollectionCoordinator({
    dbName: COORDINATOR_NAME,
  });
  const persistence = createBrowserWASQLitePersistence({
    coordinator,
    database,
    // Same-id schema mismatches must fail closed. The lab migrates between
    // versioned collection ids so a reset cannot silently discard local work.
    schemaMismatchPolicy: "sync-absent-error",
  });
  const notesV1 = createNotesV1Collection(persistence);
  const notesV2 =
    release === 2 ? createNotesV2Collection(persistence) : undefined;
  const outboxStorage = new IndexedDBAdapter(
    OUTBOX_DATABASE_NAME,
    OUTBOX_STORE_NAME
  );
  const mockServerStorage = new IndexedDBAdapter(
    MOCK_SERVER_DATABASE_NAME,
    MOCK_SERVER_STORE_NAME
  );
  const onlineDetector = new MockOnlineDetector();
  const diagnostics: OfflinePocDiagnostics = {};
  const collections = notesV2 ? { notesV1, notesV2 } : { notesV1 };
  const executor = startOfflineExecutor({
    collections,
    jitter: false,
    maxConcurrency: 1,
    mutationFns: {
      commitLabCommand: async ({ idempotencyKey, transaction }) => {
        const receiptKey = `${MOCK_RECEIPT_PREFIX}${idempotencyKey}`;
        if (await mockServerStorage.get(receiptKey)) {
          return;
        }

        await mockServerStorage.set(
          receiptKey,
          JSON.stringify({
            acceptedAt: new Date().toISOString(),
            idempotencyKey,
            mutationCount: transaction.mutations.length,
          })
        );
      },
    },
    onLeadershipChange: () => undefined,
    onlineDetector,
    onStorageFailure: (diagnostic) => {
      diagnostics.storageFailure = diagnostic.message;
    },
    onUnknownMutationFn: (mutationFnName, transaction) => {
      diagnostics.unknownMutation = {
        mutationFnName,
        transactionId: transaction.id,
      };
    },
    storage: outboxStorage,
  });

  try {
    await executor.waitForInit();
  } catch (error) {
    executor.dispose();
    onlineDetector.dispose();
    coordinator.dispose();
    await database.close?.();
    throw error;
  }

  let isClosed = false;
  const close = async () => {
    if (isClosed) {
      return;
    }
    isClosed = true;
    executor.dispose();
    onlineDetector.dispose();
    coordinator.dispose();
    await database.close?.();
  };

  return {
    capabilities,
    close,
    diagnostics,
    executor,
    mockServerStorage,
    notesV1,
    ...(notesV2 ? { notesV2 } : {}),
    database,
    onlineDetector,
    outboxStorage,
    release,
  };
}

export async function queueOfflineNote(
  runtime: OfflinePocRuntime,
  note: OfflineNoteV1 | OfflineNoteV2
) {
  if (!runtime.executor.isOfflineEnabled) {
    throw new Error(
      "Só a aba líder pode admitir uma mutation offline. Verifique o status do outbox."
    );
  }

  const idempotencyKey = `polaris-pr12:${crypto.randomUUID()}`;
  const command = runtime.executor.createOfflineTransaction({
    autoCommit: false,
    idempotencyKey,
    mutationFnName: "commitLabCommand",
  });

  command.mutate(() => {
    if (note.formatVersion === 1) {
      runtime.notesV1.insert(note);
      return;
    }

    if (!runtime.notesV2) {
      throw new Error(
        "A coleção v2 não foi aberta nesta versão do laboratório."
      );
    }
    runtime.notesV2.insert(note);
  });

  const commitPromise = command.commit();
  const pending = await Promise.race([
    waitForOutboxItem(runtime.executor, idempotencyKey),
    commitPromise.then(() => {
      throw new Error(
        "A mutation foi enviada ao mock server antes de aparecer no outbox."
      );
    }),
  ]);

  return { idempotencyKey, pending };
}

function waitForOutboxItem(
  executor: OfflineExecutor,
  idempotencyKey: string,
  timeoutMs = 5000
): Promise<OfflineTransaction> {
  const deadline = Date.now() + timeoutMs;

  const poll = async (): Promise<OfflineTransaction> => {
    const outbox = await executor.peekOutbox();
    const pending = outbox.find(
      (transaction) => transaction.idempotencyKey === idempotencyKey
    );
    if (pending) {
      return pending;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        "A mutation não foi confirmada no outbox dentro do prazo."
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
    return poll();
  };

  return poll();
}

export function copyLegacyNotesToV2(
  runtime: OfflinePocRuntime
): Promise<OfflinePocMigrationResult> {
  if (runtime.release !== 2 || !runtime.notesV2) {
    throw new Error("Abra o laboratório na versão 2 para executar a migração.");
  }
  if (typeof navigator.locks?.request !== "function") {
    throw new Error(
      "Web Locks não está disponível para serializar a migração."
    );
  }

  return navigator.locks.request(
    "polaris-pr12-offline-poc-v1-to-v2",
    async () => {
      const [legacyRows, currentRows] = await Promise.all([
        runtime.notesV1.toArrayWhenReady(),
        runtime.notesV2?.toArrayWhenReady(),
      ]);
      const currentIds = new Set((currentRows ?? []).map((note) => note.id));
      const toCopy = legacyRows.filter((legacy) => !currentIds.has(legacy.id));
      const persistedWrites = toCopy.map((legacy) =>
        runtime.notesV2?.insert({
          category: "migrated-from-v1",
          createdAt: legacy.createdAt,
          formatVersion: 2,
          id: legacy.id,
          origin: "migration",
          title: legacy.title,
        })
      );
      if (persistedWrites.some((transaction) => !transaction)) {
        throw new Error("A coleção v2 não está pronta para receber dados.");
      }
      await Promise.all(
        persistedWrites.map((transaction) => transaction?.isPersisted.promise)
      );

      return {
        copied: persistedWrites.length,
        sourceCount: legacyRows.length,
        targetCount: currentIds.size + persistedWrites.length,
      };
    }
  );
}

export async function getMockServerReceiptCount(storage: IndexedDBAdapter) {
  const receiptKeys = await storage.keys();
  return receiptKeys.filter((key) => key.startsWith(MOCK_RECEIPT_PREFIX))
    .length;
}

export async function writeSharedNote(
  runtime: OfflinePocRuntime,
  tabId: string
) {
  const id = SHARED_RECORD_ID;
  const title = `Editada pela aba ${tabId} às ${new Date().toLocaleTimeString()}`;

  if (runtime.release === 1) {
    const existing = (await runtime.notesV1.toArrayWhenReady()).find(
      (note) => note.id === id
    );
    const transaction = existing
      ? runtime.notesV1.update(id, (draft) => {
          draft.title = title;
        })
      : runtime.notesV1.insert({
          createdAt: new Date().toISOString(),
          formatVersion: 1,
          id,
          origin: "created",
          title,
        });
    await transaction.isPersisted.promise;
    return title;
  }

  if (!runtime.notesV2) {
    throw new Error("A coleção v2 não foi aberta nesta versão do laboratório.");
  }

  const existing = (await runtime.notesV2.toArrayWhenReady()).find(
    (note) => note.id === id
  );
  const transaction = existing
    ? runtime.notesV2.update(id, (draft) => {
        draft.title = title;
      })
    : runtime.notesV2.insert({
        category: "concurrent-write",
        createdAt: new Date().toISOString(),
        formatVersion: 2,
        id,
        origin: "created",
        title,
      });
  await transaction.isPersisted.promise;
  return title;
}

function openResetJournalDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(RESET_JOURNAL_DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(RESET_JOURNAL_STORE_NAME)) {
        request.result.createObjectStore(RESET_JOURNAL_STORE_NAME);
      }
    };
    request.onerror = () =>
      reject(
        request.error ?? new Error("Não foi possível abrir o journal de reset.")
      );
    request.onblocked = () =>
      reject(new Error("O journal de reset está bloqueado por outra aba."));
    request.onsuccess = () => resolve(request.result);
  });
}

async function setResetJournalPending(isPending: boolean) {
  const database = await openResetJournalDatabase();
  try {
    const transaction = database.transaction(
      RESET_JOURNAL_STORE_NAME,
      "readwrite"
    );
    const store = transaction.objectStore(RESET_JOURNAL_STORE_NAME);
    if (isPending) {
      store.put(RESET_JOURNAL_PENDING_VALUE, RESET_JOURNAL_RECORD_KEY);
    } else {
      store.delete(RESET_JOURNAL_RECORD_KEY);
    }
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(
          transaction.error ??
            new Error("Falha ao atualizar o journal de reset.")
        );
      transaction.onabort = () =>
        reject(
          transaction.error ??
            new Error("A atualização do journal foi cancelada.")
        );
    });
  } finally {
    database.close();
  }
}

async function hasPendingResetJournal() {
  const database = await openResetJournalDatabase();
  try {
    const transaction = database.transaction(
      RESET_JOURNAL_STORE_NAME,
      "readonly"
    );
    const request = transaction
      .objectStore(RESET_JOURNAL_STORE_NAME)
      .get(RESET_JOURNAL_RECORD_KEY);
    return await new Promise<boolean>((resolve, reject) => {
      let value: unknown;
      request.onsuccess = () => {
        value = request.result;
      };
      request.onerror = () =>
        reject(request.error ?? new Error("Falha ao ler o journal de reset."));
      transaction.oncomplete = () =>
        resolve(value === RESET_JOURNAL_PENDING_VALUE);
      transaction.onerror = () =>
        reject(
          transaction.error ?? new Error("Falha ao ler o journal de reset.")
        );
      transaction.onabort = () =>
        reject(
          transaction.error ?? new Error("A leitura do journal foi cancelada.")
        );
    });
  } finally {
    database.close();
  }
}

export async function resumeOfflinePocResetIfNeeded() {
  if (!(await hasPendingResetJournal())) {
    return;
  }
  if (typeof navigator.locks?.request !== "function") {
    throw new Error("Web Locks são necessários para retomar o reset seguro.");
  }

  await navigator.locks.request(RESET_JOURNAL_LOCK_NAME, async () => {
    if (!(await hasPendingResetJournal())) {
      return;
    }
    await clearOfflinePocStorageData();
    await setResetJournalPending(false);
  });
}
async function clearIndexedDbStore(databaseName: string, storeName: string) {
  let databaseWasMissing = false;
  const database = await new Promise<IDBDatabase | null>((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.onupgradeneeded = () => {
      databaseWasMissing = true;
      request.transaction?.abort();
    };
    request.onerror = () => {
      if (databaseWasMissing) {
        resolve(null);
        return;
      }
      reject(request.error ?? new Error(`Falha ao abrir ${databaseName}.`));
    };
    request.onblocked = () =>
      reject(new Error(`O banco IndexedDB ${databaseName} está bloqueado.`));
    request.onsuccess = () => {
      if (databaseWasMissing) {
        request.result.close();
        resolve(null);
        return;
      }
      resolve(request.result);
    };
  });

  if (!database) {
    return;
  }
  try {
    if (!database.objectStoreNames.contains(storeName)) {
      throw new Error(
        `O store ${storeName} não existe no banco ${databaseName}.`
      );
    }

    const clearTransaction = database.transaction(storeName, "readwrite");
    const clearRequest = clearTransaction.objectStore(storeName).clear();
    await new Promise<void>((resolve, reject) => {
      clearTransaction.oncomplete = () => resolve();
      clearTransaction.onerror = () =>
        reject(
          clearTransaction.error ??
            clearRequest.error ??
            new Error(`Falha ao limpar ${storeName}.`)
        );
      clearTransaction.onabort = () =>
        reject(
          clearTransaction.error ??
            clearRequest.error ??
            new Error(`A limpeza de ${storeName} foi cancelada.`)
        );
    });

    const verifyTransaction = database.transaction(storeName, "readonly");
    const countRequest = verifyTransaction.objectStore(storeName).count();
    const remainingCount = await new Promise<number>((resolve, reject) => {
      let count = 0;
      countRequest.onsuccess = () => {
        count = countRequest.result;
      };
      countRequest.onerror = () =>
        reject(
          countRequest.error ??
            new Error(`Não foi possível verificar ${storeName}.`)
        );
      verifyTransaction.oncomplete = () => resolve(count);
      verifyTransaction.onerror = () =>
        reject(
          verifyTransaction.error ??
            new Error(`Falha ao verificar ${storeName}.`)
        );
      verifyTransaction.onabort = () =>
        reject(
          verifyTransaction.error ??
            new Error(`A verificação de ${storeName} foi cancelada.`)
        );
    });

    if (remainingCount !== 0) {
      throw new Error(
        `O store ${storeName} ainda contém ${remainingCount} registro(s).`
      );
    }
  } finally {
    database.close();
  }
}
async function clearOfflinePocStorageData(): Promise<OfflinePocResetResult> {
  await Promise.all([
    clearIndexedDbStore(OUTBOX_DATABASE_NAME, OUTBOX_STORE_NAME),
    clearIndexedDbStore(MOCK_SERVER_DATABASE_NAME, MOCK_SERVER_STORE_NAME),
  ]);

  const root = await navigator.storage.getDirectory();
  let removedDatabaseFile = false;
  try {
    await root.removeEntry(OFFLINE_POC_DATABASE_FILE);
    removedDatabaseFile = true;
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== "NotFoundError") {
      throw error;
    }
  }

  return { removedDatabaseFile };
}

export async function clearOfflinePocStorage(
  runtime: OfflinePocRuntime
): Promise<OfflinePocResetResult> {
  if (typeof navigator.locks?.request !== "function") {
    throw new Error(
      "Web Locks são necessários para limpar o armazenamento seguro."
    );
  }
  await runtime.close();

  return navigator.locks.request(RESET_JOURNAL_LOCK_NAME, async () => {
    await setResetJournalPending(true);
    const result = await clearOfflinePocStorageData();
    await setResetJournalPending(false);
    return result;
  });
}

export async function removeOfflinePocDatabaseFile(
  runtime: OfflinePocRuntime
): Promise<boolean> {
  await runtime.close();

  const root = await navigator.storage.getDirectory();
  try {
    await root.removeEntry(OFFLINE_POC_DATABASE_FILE);
    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") {
      return false;
    }
    throw error;
  }
}
