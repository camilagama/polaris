import { describe, expect, it } from "vitest";
import type { PreferenceStorage } from "./current-organization-model";
import {
  clearSessionMarker,
  openingReason,
  readSessionMarker,
  SESSION_MARKER_KEY,
  writeSessionMarker,
} from "./session-marker";

function memoryStorage(
  initial: Record<string, string> = {}
): PreferenceStorage {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => data.get(key) ?? null,
    removeItem: (key) => {
      data.delete(key);
    },
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

describe("openingReason (U-01)", () => {
  it("says nothing on a first visit, when this browser never had a session", () => {
    expect(openingReason(readSessionMarker(memoryStorage()))).toBeUndefined();
  });

  it("says the session ended only when there was one", () => {
    const storage = memoryStorage();
    writeSessionMarker("ativa", storage);
    expect(openingReason(readSessionMarker(storage))).toBe("sessao");
  });

  it("says the person left after 'Sair'", () => {
    const storage = memoryStorage();
    writeSessionMarker("ativa", storage);
    writeSessionMarker("saiu", storage);
    expect(openingReason(readSessionMarker(storage))).toBe("saiu");
  });

  it("starts clean once cleared", () => {
    const storage = memoryStorage();
    writeSessionMarker("ativa", storage);
    clearSessionMarker(storage);
    expect(readSessionMarker(storage)).toBeNull();
  });

  it("ignores a value outside the closed list", () => {
    expect(
      readSessionMarker(memoryStorage({ [SESSION_MARKER_KEY]: "<b>x</b>" }))
    ).toBeNull();
  });

  it("works where the browser blocks storage", () => {
    expect(readSessionMarker(null)).toBeNull();
    expect(() => writeSessionMarker("ativa", null)).not.toThrow();
    const throwing: PreferenceStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readSessionMarker(throwing)).toBeNull();
    expect(() => writeSessionMarker("saiu", throwing)).not.toThrow();
    expect(() => clearSessionMarker(throwing)).not.toThrow();
  });
});
