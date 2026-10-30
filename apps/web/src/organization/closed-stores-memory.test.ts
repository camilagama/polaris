import { describe, expect, it } from "vitest";
import {
  closedStorePath,
  justReopened,
  NEW_STORE_PATH,
  REOPENED_PATH,
  wantsNewStore,
  withoutOpeningMarks,
} from "../lib/closed-store-path";
import {
  CLOSED_STORES_KEY,
  clearClosedStores,
  closedStoreLineText,
  closedStoresBeside,
  readClosedStores,
  rememberClosedStore,
  rememberClosedStores,
} from "./closed-stores-memory";

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

const A = { id: "a", name: "Doce Mel", phase: "closing" };
const B = { id: "b", name: "Segunda loja", phase: "closed" };

describe("what the browser remembers of the owner's closed stores", () => {
  it("keeps the list the server gave, only id and name, without a purged store", () => {
    const storage = memoryStorage();
    rememberClosedStores(storage, [
      A,
      B,
      { id: "c", name: "Apagada", phase: "purged" },
    ]);
    expect(readClosedStores(storage)).toEqual([
      { id: "a", name: "Doce Mel" },
      { id: "b", name: "Segunda loja" },
    ]);
    rememberClosedStores(storage, []);
    expect(storage.data.has(CLOSED_STORES_KEY)).toBe(false);
  });

  it("updates one store read on its own: kept, renamed, or forgotten when no longer closed or purged", () => {
    const storage = memoryStorage();
    rememberClosedStores(storage, [A, B]);
    rememberClosedStore(storage, "a", { ...A, name: "Doce Mel 2" });
    expect(readClosedStores(storage)).toEqual([
      { id: "b", name: "Segunda loja" },
      { id: "a", name: "Doce Mel 2" },
    ]);
    rememberClosedStore(storage, "a", null);
    rememberClosedStore(storage, "b", { ...B, phase: "purged" });
    expect(readClosedStores(storage)).toEqual([]);
  });

  it("reads nothing from a broken or foreign value, and survives a storage that throws", () => {
    const storage = memoryStorage();
    storage.setItem(CLOSED_STORES_KEY, "{not json");
    expect(readClosedStores(storage)).toEqual([]);
    storage.setItem(
      CLOSED_STORES_KEY,
      JSON.stringify([{ id: 1 }, { id: "x", name: "" }, A])
    );
    expect(readClosedStores(storage)).toEqual([A]);
    const throwing = {
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
    expect(readClosedStores(throwing)).toEqual([]);
    expect(() => rememberClosedStores(throwing, [A])).not.toThrow();
    expect(() => clearClosedStores(throwing)).not.toThrow();
    expect(readClosedStores(null)).toEqual([]);
  });

  it("never mentions a store the server lists as active again", () => {
    expect(
      closedStoresBeside(
        [
          { id: "a", name: "Doce Mel" },
          { id: "b", name: "Segunda loja" },
        ],
        ["a"]
      )
    ).toEqual([{ id: "b", name: "Segunda loja" }]);
    expect(closedStoreLineText("Doce Mel")).toBe(
      "Você também tem uma loja encerrada: Doce Mel."
    );
  });
});

describe("the one-time marks of the address", () => {
  it("opens the form at once from the panel, and says reopened once on the Início", () => {
    expect(NEW_STORE_PATH).toBe("/?nova-loja=1");
    expect(wantsNewStore("?nova-loja=1")).toBe(true);
    expect(wantsNewStore("")).toBe(false);
    expect(REOPENED_PATH).toBe("/?reaberta=1");
    expect(justReopened("?reaberta=1")).toBe(true);
    expect(justReopened("?reaberta=0")).toBe(false);
  });

  it("drops only its own marks from the address", () => {
    expect(withoutOpeningMarks("/", "?reaberta=1")).toBe("/");
    expect(withoutOpeningMarks("/", "?nova-loja=1&aba=x")).toBe("/?aba=x");
    expect(closedStorePath({ storeId: "a" })).toBe("/loja-encerrada?loja=a");
  });
});
