import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openDatabase = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/browser-db-sqlite-persistence", () => ({
  BrowserCollectionCoordinator: class {},
  createBrowserWASQLitePersistence: vi.fn(),
  openBrowserWASQLiteOPFSDatabase: openDatabase,
  persistedCollectionOptions: vi.fn(),
}));

import { openLocalStore, wipeLocalStore } from "./local-store";
import { localNamespace } from "./namespace";

function createLockManager() {
  const tails = new Map<string, Promise<unknown>>();
  return {
    request<T>(name: string, task: () => Promise<T>): Promise<T> {
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

function overlapProbe() {
  let running = 0;
  let maxRunning = 0;
  return {
    get maxRunning() {
      return maxRunning;
    },
    async enter() {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
    },
  };
}

describe("local store file lock", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { isSecureContext: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    openDatabase.mockReset();
  });

  it("opens the same file one tab at a time", async () => {
    vi.stubGlobal("navigator", {
      locks: createLockManager(),
      storage: { getDirectory: vi.fn() },
    });
    const probe = overlapProbe();
    openDatabase.mockImplementation(async () => {
      await probe.enter();
      throw new Error("stop after open");
    });
    const namespace = await localNamespace("user-1", "org-1");
    const results = await Promise.allSettled([
      openLocalStore(namespace),
      openLocalStore(namespace),
    ]);
    expect(results.map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    expect(openDatabase).toHaveBeenCalledTimes(2);
    expect(probe.maxRunning).toBe(1);
  });

  it("opens different files at the same time", async () => {
    vi.stubGlobal("navigator", {
      locks: createLockManager(),
      storage: { getDirectory: vi.fn() },
    });
    const probe = overlapProbe();
    openDatabase.mockImplementation(async () => {
      await probe.enter();
      throw new Error("stop after open");
    });
    const first = await localNamespace("user-1", "org-1");
    const second = await localNamespace("user-2", "org-1");
    await Promise.allSettled([openLocalStore(first), openLocalStore(second)]);
    expect(probe.maxRunning).toBe(2);
  });

  it("removes the same file one tab at a time and counts the files", async () => {
    const probe = overlapProbe();
    const removeEntry = vi.fn(async (name: string) => {
      await probe.enter();
      if (!name.endsWith(".sqlite")) {
        throw new DOMException("missing", "NotFoundError");
      }
    });
    vi.stubGlobal("navigator", {
      locks: createLockManager(),
      storage: { getDirectory: async () => ({ removeEntry }) },
    });
    const namespace = await localNamespace("user-1", "org-1");
    const results = await Promise.all([
      wipeLocalStore(namespace),
      wipeLocalStore(namespace),
    ]);
    expect(results).toEqual([{ removedFiles: 1 }, { removedFiles: 1 }]);
    expect(probe.maxRunning).toBe(1);
  });

  it.each([
    { first: "wipe", second: "open" },
    { first: "open", second: "wipe" },
  ] as const)(
    "$second waits for $first on the same file",
    async ({ first, second }) => {
      const events: string[] = [];
      const step = async (label: string) => {
        events.push(`${label}:start`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        events.push(`${label}:end`);
      };
      openDatabase.mockImplementation(async () => {
        await step("open");
        throw new Error("stop after open");
      });
      const removeEntry = vi.fn(async (name: string) => {
        if (name.endsWith(".sqlite")) {
          await step("wipe");
          return;
        }
        throw new DOMException("missing", "NotFoundError");
      });
      vi.stubGlobal("navigator", {
        locks: createLockManager(),
        storage: { getDirectory: async () => ({ removeEntry }) },
      });
      const namespace = await localNamespace("user-1", "org-1");
      const run = (kind: "open" | "wipe") =>
        kind === "open" ? openLocalStore(namespace) : wipeLocalStore(namespace);
      await Promise.allSettled([run(first), run(second)]);
      expect(events).toEqual([
        `${first}:start`,
        `${first}:end`,
        `${second}:start`,
        `${second}:end`,
      ]);
    }
  );

  it("still removes the files without Web Locks", async () => {
    const removeEntry = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", {
      storage: { getDirectory: async () => ({ removeEntry }) },
    });
    const namespace = await localNamespace("user-1", "org-1");
    await expect(wipeLocalStore(namespace)).resolves.toEqual({
      removedFiles: 4,
    });
  });
});
