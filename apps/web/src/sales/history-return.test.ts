import { describe, expect, it } from "vitest";
import {
  armHistoryReturn,
  clearHistoryReturn,
  HISTORY_RETURN_KEY,
  readHistoryReturn,
  rememberHistoryReturn,
} from "./history-return";

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    map,
    removeItem: (key: string) => map.delete(key),
    setItem: (key: string, value: string) => map.set(key, value),
  };
}

const SALE = "sale-1";
const NONE = { customer: "", from: "", query: "", status: "", to: "" };
const FILTERS = {
  ...NONE,
  customer: "Ana",
  from: "2026-10-01",
  status: "cancelled",
  to: "2026-10-31",
};

describe("what the Histórico gives back on Voltar", () => {
  it("gives back the filters and the scroll once Voltar armed them", () => {
    const store = fakeStorage();
    rememberHistoryReturn(store, "org-1", SALE, {
      filters: FILTERS,
      scrollY: 640.4,
    });
    armHistoryReturn(store, SALE);
    expect(readHistoryReturn(store, "org-1")).toEqual({
      filters: FILTERS,
      scrollY: 640,
    });
  });

  it("gives nothing back when the person walked away from the detail instead of pressing Voltar", () => {
    const store = fakeStorage();
    rememberHistoryReturn(store, "org-1", SALE, {
      filters: FILTERS,
      scrollY: 640,
    });
    expect(readHistoryReturn(store, "org-1")).toBeNull();
  });

  it("gives nothing back to another store", () => {
    const store = fakeStorage();
    rememberHistoryReturn(store, "org-1", SALE, {
      filters: FILTERS,
      scrollY: 640,
    });
    armHistoryReturn(store, SALE);
    expect(readHistoryReturn(store, "org-2")).toBeNull();
  });

  it("drops it", () => {
    const store = fakeStorage();
    rememberHistoryReturn(store, "org-1", SALE, {
      filters: FILTERS,
      scrollY: 640,
    });
    armHistoryReturn(store, SALE);
    clearHistoryReturn(store);
    expect(readHistoryReturn(store, "org-1")).toBeNull();
    expect(store.map.has(HISTORY_RETURN_KEY)).toBe(false);
  });

  it("gives nothing back when the Voltar belongs to another sale than the one opened from the list", () => {
    const store = fakeStorage();
    rememberHistoryReturn(store, "org-1", SALE, {
      filters: FILTERS,
      scrollY: 640,
    });
    armHistoryReturn(store, "sale-2");
    expect(readHistoryReturn(store, "org-1")).toBeNull();
  });

  it("arming with nothing remembered writes nothing", () => {
    const store = fakeStorage();
    armHistoryReturn(store, SALE);
    expect(store.map.size).toBe(0);
  });

  it("reads a damaged or foreign value as nothing, and a field that is not text as empty", () => {
    const store = fakeStorage();
    store.setItem(HISTORY_RETURN_KEY, "{not json");
    expect(readHistoryReturn(store, "org-1")).toBeNull();
    store.setItem(
      HISTORY_RETURN_KEY,
      JSON.stringify({
        armed: true,
        filters: { customer: 3, status: 7 },
        organizationId: "org-1",
        scrollY: -5,
      })
    );
    expect(readHistoryReturn(store, "org-1")).toEqual({
      filters: NONE,
      scrollY: 0,
    });
  });

  it("works with no storage at all", () => {
    rememberHistoryReturn(null, "org-1", SALE, {
      filters: FILTERS,
      scrollY: 1,
    });
    armHistoryReturn(null, SALE);
    clearHistoryReturn(null);
    expect(readHistoryReturn(null, "org-1")).toBeNull();
  });
});
