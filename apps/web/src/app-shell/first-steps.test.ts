import { describe, expect, it } from "vitest";
import {
  clearFirstSteps,
  FIRST_STEPS_KEY,
  firstProductRegistered,
  firstSaleConfirmed,
  firstStepsCount,
  firstStepsDone,
  rememberedFirstSteps,
  rememberFirstSteps,
  subscribeFirstSteps,
} from "./first-steps";

const fakeStore = () => {
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

describe("the first steps of the menu", () => {
  it("are the three of the Início: the store, the first product, the first sale", () => {
    expect(firstStepsDone({ firstProductId: null })).toEqual([
      true,
      false,
      false,
    ]);
    expect(firstStepsDone({ firstProductId: "p1" })).toEqual([
      true,
      true,
      false,
    ]);
    expect(firstStepsCount({ firstProductId: null })).toBe(1);
    expect(firstStepsCount({ firstProductId: "p1" })).toBe(2);
  });

  it("show what the Início read for this store, and only for it", () => {
    const store = fakeStore();
    rememberFirstSteps("loja-a", { firstProductId: "p1" }, store);
    expect(rememberedFirstSteps("loja-a", store)).toBe(2);
    expect(rememberedFirstSteps("loja-b", store)).toBeNull();
    expect(store.values.get(FIRST_STEPS_KEY)).not.toContain("p1");
  });

  it("are gone once the store sold", () => {
    const store = fakeStore();
    rememberFirstSteps("loja-a", { firstProductId: null }, store);
    expect(rememberedFirstSteps("loja-a", store)).toBe(1);
    rememberFirstSteps("loja-a", null, store);
    expect(rememberedFirstSteps("loja-a", store)).toBeNull();
  });

  it("are nothing before the Início read them, and refuse what is not a count of them", () => {
    const store = fakeStore();
    expect(rememberedFirstSteps("loja-a", store)).toBeNull();
    for (const value of [
      "not json",
      "2",
      JSON.stringify({ done: "2", organizationId: "loja-a" }),
      JSON.stringify({ done: 0, organizationId: "loja-a" }),
      JSON.stringify({ done: 3, organizationId: "loja-a" }),
      JSON.stringify({ done: 1.5, organizationId: "loja-a" }),
    ]) {
      store.values.set(FIRST_STEPS_KEY, value);
      expect(rememberedFirstSteps("loja-a", store)).toBeNull();
    }
  });

  it("are over once the server confirms a sale of the store, and only of that store", () => {
    const store = fakeStore();
    rememberFirstSteps("loja-a", { firstProductId: "p1" }, store);
    firstSaleConfirmed("loja-b", store);
    expect(rememberedFirstSteps("loja-a", store)).toBe(2);
    firstSaleConfirmed("loja-a", store);
    expect(rememberedFirstSteps("loja-a", store)).toBeNull();
  });

  it("move to two of three when the first product is registered, for that store only", () => {
    const store = fakeStore();
    rememberFirstSteps("loja-a", { firstProductId: null }, store);
    firstProductRegistered("loja-b", "p1", store);
    expect(rememberedFirstSteps("loja-a", store)).toBe(1);
    firstProductRegistered("loja-a", "p1", store);
    expect(rememberedFirstSteps("loja-a", store)).toBe(2);
    expect(store.values.get(FIRST_STEPS_KEY)).not.toContain("p1");
  });

  it("stay as they are when a product is registered after the Início saw a sale or never read them", () => {
    const store = fakeStore();
    clearFirstSteps(store);
    firstProductRegistered("loja-a", "p1", store);
    expect(rememberedFirstSteps("loja-a", store)).toBeNull();
    rememberFirstSteps("loja-a", null, store);
    firstProductRegistered("loja-a", "p1", store);
    expect(rememberedFirstSteps("loja-a", store)).toBeNull();
  });

  it("stay at two of three when another product is registered", () => {
    const store = fakeStore();
    rememberFirstSteps("loja-a", { firstProductId: "p1" }, store);
    firstProductRegistered("loja-a", "p2", store);
    expect(rememberedFirstSteps("loja-a", store)).toBe(2);
  });

  it("tell the foot of the menu when the first product is registered", () => {
    const store = fakeStore();
    rememberFirstSteps("loja-a", { firstProductId: null }, store);
    let told = 0;
    const stop = subscribeFirstSteps(() => {
      told += 1;
    });
    firstProductRegistered("loja-a", "p1", store);
    stop();
    expect(told).toBe(1);
  });

  it("are dropped when the session ends", () => {
    const store = fakeStore();
    rememberFirstSteps("loja-a", { firstProductId: null }, store);
    clearFirstSteps(store);
    expect(store.values.has(FIRST_STEPS_KEY)).toBe(false);
    expect(rememberedFirstSteps("loja-a", store)).toBeNull();
  });
});
