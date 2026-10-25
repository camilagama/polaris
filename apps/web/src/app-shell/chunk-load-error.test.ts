import { describe, expect, it, vi } from "vitest";
import {
  isChunkLoadError,
  RELOAD_WINDOW_MS,
  reloadOnceForChunkError,
} from "./chunk-load-error";

describe("which errors are a download that failed", () => {
  it("knows the message of each browser and of the bundlers", () => {
    for (const message of [
      "Failed to fetch dynamically imported module: https://app.example/assets/expenses-page-DzKt9t-U.js",
      "error loading dynamically imported module: https://app.example/assets/a.js",
      "Importing a module script failed.",
      "Unable to preload CSS for /assets/a.css",
      "Loading chunk 12 failed.",
    ]) {
      expect(isChunkLoadError(new TypeError(message))).toBe(true);
    }
    const named = new Error("boom");
    named.name = "ChunkLoadError";
    expect(isChunkLoadError(named)).toBe(true);
  });

  it("leaves the errors of the screen itself alone", () => {
    expect(isChunkLoadError(new TypeError("x is not a function"))).toBe(false);
    expect(
      isChunkLoadError("Failed to fetch dynamically imported module")
    ).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });
});

function memory(initial: Record<string, string> = {}) {
  const values = { ...initial };
  return {
    getItem: (key: string) => values[key] ?? null,
    setItem: (key: string, value: string) => {
      values[key] = value;
    },
    values,
  };
}

describe("reloading once for a chunk that did not download", () => {
  it("reloads the first time and remembers it", () => {
    const storage = memory();
    const reload = vi.fn();
    expect(reloadOnceForChunkError(storage, 1_000_000, reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(Object.values(storage.values)).toEqual(["1000000"]);
  });

  it("does not reload again right after: a chunk that is still missing would loop", () => {
    const storage = memory();
    const reload = vi.fn();
    reloadOnceForChunkError(storage, 1_000_000, reload);
    expect(
      reloadOnceForChunkError(storage, 1_000_000 + RELOAD_WINDOW_MS - 1, reload)
    ).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads again for a failure long after the last one", () => {
    const storage = memory();
    const reload = vi.fn();
    reloadOnceForChunkError(storage, 1_000_000, reload);
    expect(
      reloadOnceForChunkError(storage, 1_000_000 + RELOAD_WINDOW_MS, reload)
    ).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("does not reload when the tab cannot remember (no storage, or it throws)", () => {
    const reload = vi.fn();
    expect(reloadOnceForChunkError(null, 1, reload)).toBe(false);
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => undefined,
    };
    expect(reloadOnceForChunkError(broken, 1, reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
