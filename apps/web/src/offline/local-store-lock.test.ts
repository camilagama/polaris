import { afterEach, describe, expect, it, vi } from "vitest";
import { withLocalFileLock } from "./local-store-lock";

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

function gate() {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

describe("withLocalFileLock", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("runs two concurrent tasks of the same file one after the other", async () => {
    vi.stubGlobal("navigator", { locks: createLockManager() });
    const events: string[] = [];
    const firstGate = gate();
    const first = withLocalFileLock("a.sqlite", async () => {
      events.push("first:start");
      await firstGate.opened;
      events.push("first:end");
    });
    const second = withLocalFileLock("a.sqlite", () => {
      events.push("second:start");
      return Promise.resolve();
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    firstGate.open();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("does not make different files wait for each other", async () => {
    vi.stubGlobal("navigator", { locks: createLockManager() });
    const events: string[] = [];
    const blocker = gate();
    const slow = withLocalFileLock("a.sqlite", async () => {
      events.push("a:start");
      await blocker.opened;
    });
    await withLocalFileLock("b.sqlite", () => {
      events.push("b:done");
      return Promise.resolve();
    });
    expect(events).toEqual(["a:start", "b:done"]);
    blocker.open();
    await slow;
  });

  it("releases the lock when a task fails", async () => {
    vi.stubGlobal("navigator", { locks: createLockManager() });
    await expect(
      withLocalFileLock("a.sqlite", () => Promise.reject(new Error("boom")))
    ).rejects.toThrow("boom");
    await expect(
      withLocalFileLock("a.sqlite", () => Promise.resolve("ok"))
    ).resolves.toBe("ok");
  });

  it("names the lock after the file only", async () => {
    const manager = createLockManager();
    vi.stubGlobal("navigator", { locks: manager });
    await withLocalFileLock("polaris-local-abc.sqlite", () =>
      Promise.resolve()
    );
    expect(manager.names).toEqual([
      "polaris-local-file:polaris-local-abc.sqlite",
    ]);
  });

  it("runs the task without Web Locks", async () => {
    vi.stubGlobal("navigator", {});
    await expect(
      withLocalFileLock("a.sqlite", () => Promise.resolve(7))
    ).resolves.toBe(7);
  });
});
