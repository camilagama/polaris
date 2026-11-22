import { describe, expect, it } from "vitest";
import {
  armHistoryReturn,
  clearHistoryReturn,
  HISTORY_RETURN_KEY,
  readHistoryReturn,
  rememberHistoryReturn,
} from "./history-return";
import { emptyHistoryFilters } from "./sale-history-model";

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    map,
    removeItem: (key: string) => map.delete(key),
    setItem: (key: string, value: string) => map.set(key, value),
  };
}

const FILTERS = {
  ...emptyHistoryFilters,
  customer: "Ana",
  from: "2026-10-01",
  status: "cancelled",
  to: "2026-10-31",
} as const;

describe("what the Histórico gives back on Voltar", () => {
  it("gives back the filters and the scroll once Voltar armed them", () => {
    const store = fakeStorage();
    rememberHistoryReturn(store, "org-1", { filters: FILTERS, scrollY: 640.4 });
    armHistoryReturn(store);
    expect(readHistoryReturn(store, "org-1")).toEqual({
      filters: FILTERS,
      scrollY: 640,
    });
  });

  it("gives nothing back when the person walked away from the detail instead of pressing Voltar", () => {
    const store = fakeStorage();
    rememberHistoryReturn(store, "org-1", { filters: FILTERS, scrollY: 640 });
    expect(readHistoryReturn(store, "org-1")).toBeNull();
  });

  it("gives nothing back to another store", () => {
    const store = fakeStorage();
    rememberHistoryReturn(store, "org-1", { filters: FILTERS, scrollY: 640 });
    armHistoryReturn(store);
    expect(readHistoryReturn(store, "org-2")).toBeNull();
  });

  it("drops it", () => {
    const store = fakeStorage();
    rememberHistoryReturn(store, "org-1", { filters: FILTERS, scrollY: 640 });
    armHistoryReturn(store);
    clearHistoryReturn(store);
    expect(readHistoryReturn(store, "org-1")).toBeNull();
    expect(store.map.has(HISTORY_RETURN_KEY)).toBe(false);
  });

  it("arming with nothing remembered writes nothing", () => {
    const store = fakeStorage();
    armHistoryReturn(store);
    expect(store.map.size).toBe(0);
  });

  it("reads a damaged or foreign value as nothing, and a situation that is not one as no filter", () => {
    const store = fakeStorage();
    store.setItem(HISTORY_RETURN_KEY, "{not json");
    expect(readHistoryReturn(store, "org-1")).toBeNull();
    store.setItem(
      HISTORY_RETURN_KEY,
      JSON.stringify({
        armed: true,
        filters: { customer: 3, status: "bogus" },
        organizationId: "org-1",
        scrollY: -5,
      })
    );
    expect(readHistoryReturn(store, "org-1")).toEqual({
      filters: emptyHistoryFilters,
      scrollY: 0,
    });
  });

  it("works with no storage at all", () => {
    rememberHistoryReturn(null, "org-1", { filters: FILTERS, scrollY: 1 });
    armHistoryReturn(null);
    clearHistoryReturn(null);
    expect(readHistoryReturn(null, "org-1")).toBeNull();
  });
});
