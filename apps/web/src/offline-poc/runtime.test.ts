import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openDatabase = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/browser-db-sqlite-persistence", () => ({
  BrowserCollectionCoordinator: class {},
  createBrowserWASQLitePersistence: vi.fn(),
  openBrowserWASQLiteOPFSDatabase: openDatabase,
  persistedCollectionOptions: vi.fn(),
}));

vi.mock("@tanstack/offline-transactions", () => ({
  IndexedDBAdapter: { probe: () => Promise.resolve({ available: true }) },
  startOfflineExecutor: vi.fn(),
}));

import {
  clearOfflinePocStorage,
  createOfflinePocRuntime,
  OFFLINE_POC_DATABASE_FILE,
  type OfflinePocRuntime,
  removeOfflinePocDatabaseFile,
} from "./runtime";

const FILE_LOCK_PREFIX = "polaris-local-file:";
const FILE_LOCK_NAME = `${FILE_LOCK_PREFIX}${OFFLINE_POC_DATABASE_FILE}`;

function createLockManager() {
  const tails = new Map<string, Promise<unknown>>();
  const names: string[] = [];
  return {
    names,
    request<T>(name: string, task: () => Promise<T>): Promise<T> {
      names.push(name);
      const previous = tails.get(name) ?? Promise.resolve();
      const run = previous.then(task, task);
      tails.set(
        name,
        run.catch(() => undefined)
      );
      return run;
    },
  };
}

function createFakeIndexedDb() {
  const journalDatabase = {
    close: () => undefined,
    objectStoreNames: { contains: () => true },
    transaction: () => {
      const transaction: {
        oncomplete?: () => void;
        objectStore: () => { delete: () => void; put: () => void };
      } = {
        objectStore: () => ({ delete: () => undefined, put: () => undefined }),
      };
      queueMicrotask(() => transaction.oncomplete?.());
      return transaction;
    },
  };
  return {
    open(_name: string, version?: number) {
      const request: {
        onerror?: () => void;
        onsuccess?: () => void;
        onupgradeneeded?: () => void;
        result: typeof journalDatabase;
        transaction: { abort: () => void };
      } = { result: journalDatabase, transaction: { abort: () => undefined } };
      queueMicrotask(() => {
        if (version === undefined) {
          request.onupgradeneeded?.();
          request.onerror?.();
          return;
        }
        request.onsuccess?.();
      });
      return request;
    },
  };
}

async function drainMicrotasks() {
  for (let turn = 0; turn < 100; turn += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each turn must finish before the next
    await Promise.resolve();
  }
}

function overlapScenario() {
  const events: string[] = [];
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const step = async (label: string) => {
    events.push(`${label}:start`);
    await released;
    events.push(`${label}:end`);
  };
  openDatabase.mockImplementation(async () => {
    await step("open");
    throw new Error("stop after open");
  });
  const removeEntry = vi.fn(async () => {
    await step("remove");
  });
  const locks = createLockManager();
  vi.stubGlobal("window", { isSecureContext: true });
  vi.stubGlobal("indexedDB", createFakeIndexedDb());
  vi.stubGlobal("navigator", {
    locks,
    storage: { getDirectory: async () => ({ removeEntry }) },
  });
  return { events, locks, release, removeEntry };
}

const closedRuntime = { close: () => Promise.resolve() } as OfflinePocRuntime;

const actions = {
  clear: () => clearOfflinePocStorage(closedRuntime),
  open: () => createOfflinePocRuntime(1),
  remove: () => removeOfflinePocDatabaseFile(closedRuntime),
} as const;

type Action = keyof typeof actions;

const labels: Record<Action, string> = {
  clear: "remove",
  open: "open",
  remove: "remove",
};

describe("offline lab database file lock", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { isSecureContext: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    openDatabase.mockReset();
  });

  it.each([
    { first: "open", second: "remove" },
    { first: "remove", second: "open" },
    { first: "open", second: "clear" },
    { first: "clear", second: "open" },
  ] as const)(
    "$second waits for $first on the lab file",
    async ({ first, second }) => {
      const { events, release } = overlapScenario();
      const running = Promise.allSettled([actions[first]()]);
      await vi.waitFor(() =>
        expect(events).toContain(`${labels[first]}:start`)
      );
      const queued = Promise.allSettled([actions[second]()]);
      await drainMicrotasks();
      expect(events).toEqual([`${labels[first]}:start`]);
      release();
      await Promise.all([running, queued]);
      expect(events).toEqual([
        `${labels[first]}:start`,
        `${labels[first]}:end`,
        `${labels[second]}:start`,
        `${labels[second]}:end`,
      ]);
    }
  );

  it.each(["open", "remove", "clear"] as const)(
    "%s takes the lock named after the lab file",
    async (action) => {
      const { locks, release, removeEntry } = overlapScenario();
      release();
      await Promise.allSettled([actions[action]()]);
      if (action !== "open") {
        expect(removeEntry).toHaveBeenCalledWith(OFFLINE_POC_DATABASE_FILE);
      }
      expect(
        locks.names.filter((name) => name.includes(FILE_LOCK_PREFIX))
      ).toEqual([FILE_LOCK_NAME]);
    }
  );

  it("reports whether the lab file existed", async () => {
    const removeEntry = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new DOMException("missing", "NotFoundError"));
    vi.stubGlobal("navigator", {
      locks: createLockManager(),
      storage: { getDirectory: async () => ({ removeEntry }) },
    });
    await expect(removeOfflinePocDatabaseFile(closedRuntime)).resolves.toBe(
      true
    );
    await expect(removeOfflinePocDatabaseFile(closedRuntime)).resolves.toBe(
      false
    );
  });
});
