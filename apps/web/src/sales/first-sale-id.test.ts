import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIRST_STEPS_KEY, rememberFirstSteps } from "../app-shell/first-steps";
import { firstSaleIdOf } from "./first-sale-id";
import type { ConfirmedSaleView, SubmissionState } from "./sale-form-model";

const SALE_ID = "77777777-7777-4777-8777-777777777777";

const confirmed = (replayed: boolean): SubmissionState => {
  const sale: ConfirmedSaleView = {
    headline: "Venda confirmada.",
    items: [],
    note: "",
    paymentDetails: [],
    replayed,
    saleDetails: [],
    saleId: SALE_ID,
    totals: [],
  };
  return { phase: "confirmed", sale };
};

const sessionStorageStub = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    values,
  };
};

describe("the sale the confirmation panel announces as the first", () => {
  let store: ReturnType<typeof sessionStorageStub>;

  beforeEach(() => {
    store = sessionStorageStub();
    vi.stubGlobal("window", { sessionStorage: store });
    rememberFirstSteps("loja-a", { firstProductId: "p1" }, store);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is the one the server confirms while the steps are open", () => {
    expect(firstSaleIdOf("loja-a", confirmed(false))).toBe(SALE_ID);
    expect(store.values.get(FIRST_STEPS_KEY)).toContain('"done":null');
  });

  it("is also the one the server answers as replayed, because the answer of the first try never came", () => {
    expect(firstSaleIdOf("loja-a", confirmed(true))).toBe(SALE_ID);
  });

  it("is none once the steps are over", () => {
    expect(firstSaleIdOf("loja-a", confirmed(false))).toBe(SALE_ID);
    expect(firstSaleIdOf("loja-a", confirmed(false))).toBeNull();
  });

  it("is none while no sale is confirmed", () => {
    expect(firstSaleIdOf("loja-a", { phase: "idle" })).toBeNull();
  });
});
