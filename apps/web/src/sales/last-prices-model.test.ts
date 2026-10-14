import { describe, expect, it } from "vitest";
import type { PreferenceStorage } from "../lib/current-organization-model";
import {
  lastPricesKey,
  MAX_REMEMBERED_VARIANTS,
  mergeLastPrices,
  priceFieldText,
  readLastPrices,
  suggestionHint,
  suggestPrices,
  withSuggestedPrices,
  writeLastPrices,
} from "./last-prices-model";

const organizationId = "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0";
const blue = "0199c2d0-0000-7000-8000-000000000002";
const green = "0199c2d0-0000-7000-8000-000000000003";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const storage: PreferenceStorage = {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
  return { storage, values };
}

const throwingStorage: PreferenceStorage = {
  getItem: () => {
    throw new Error("blocked");
  },
  removeItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("quota");
  },
};

describe("remembered prices", () => {
  it("remembers the confirmed lines per variant", () => {
    const prices = mergeLastPrices(
      {},
      [
        {
          chargedUnitPrice: "49.90",
          listedUnitPrice: "59.90",
          variantId: blue,
        },
        {
          chargedUnitPrice: "30.00",
          listedUnitPrice: "30.00",
          variantId: green,
        },
      ],
      "2026-10-13"
    );
    expect(prices[blue]).toEqual({
      charged: "49.90",
      listed: "59.90",
      on: "2026-10-13",
    });
    expect(Object.keys(prices)).toHaveLength(2);
  });

  it("overwrites a variant with the newest sale and keeps the others", () => {
    const first = mergeLastPrices(
      {},
      [
        {
          chargedUnitPrice: "49.90",
          listedUnitPrice: "59.90",
          variantId: blue,
        },
        {
          chargedUnitPrice: "30.00",
          listedUnitPrice: "30.00",
          variantId: green,
        },
      ],
      "2026-10-01"
    );
    const second = mergeLastPrices(
      first,
      [
        {
          chargedUnitPrice: "45.00",
          listedUnitPrice: "59.90",
          variantId: blue,
        },
      ],
      "2026-10-13"
    );
    expect(second).toMatchObject({
      [blue]: { charged: "45.00", on: "2026-10-13" },
      [green]: { charged: "30.00" },
    });
  });

  it("keeps only the newest variants when the limit is exceeded", () => {
    const lines = Array.from(
      { length: MAX_REMEMBERED_VARIANTS + 5 },
      (_, n) => ({
        chargedUnitPrice: "1.00",
        listedUnitPrice: "1.00",
        variantId: `variant-${n}`,
      })
    );
    const old = mergeLastPrices({}, lines.slice(0, 5), "2026-01-01");
    const merged = mergeLastPrices(old, lines.slice(5), "2026-10-13");
    expect(Object.keys(merged)).toHaveLength(MAX_REMEMBERED_VARIANTS);
    expect(merged["variant-0"]).toBeUndefined();
    expect(merged[`variant-${MAX_REMEMBERED_VARIANTS + 4}`]).toBeDefined();
  });

  it("round-trips through storage, scoped to the organization", () => {
    const { storage, values } = memoryStorage();
    const prices = mergeLastPrices(
      {},
      [
        {
          chargedUnitPrice: "49.90",
          listedUnitPrice: "59.90",
          variantId: blue,
        },
      ],
      "2026-10-13"
    );
    expect(writeLastPrices(storage, organizationId, prices)).toBe(true);
    expect(values.has(lastPricesKey(organizationId))).toBe(true);
    expect(readLastPrices(storage, organizationId)).toEqual(prices);
    expect(readLastPrices(storage, "another-organization")).toEqual({});
  });

  it("never breaks the form without storage, with garbage, or when storage throws", () => {
    expect(readLastPrices(null, organizationId)).toEqual({});
    expect(writeLastPrices(null, organizationId, {})).toBe(false);
    expect(readLastPrices(throwingStorage, organizationId)).toEqual({});
    expect(writeLastPrices(throwingStorage, organizationId, {})).toBe(false);
    for (const garbage of ["{", "[]", "null", '"text"', "7"]) {
      const { storage } = memoryStorage({
        [lastPricesKey(organizationId)]: garbage,
      });
      expect(readLastPrices(storage, organizationId)).toEqual({});
    }
  });

  it("drops entries that are not valid prices, keeping the valid ones", () => {
    const { storage } = memoryStorage({
      [lastPricesKey(organizationId)]: JSON.stringify({
        [blue]: { charged: "49.90", listed: "59.90", on: "2026-10-13" },
        [green]: { charged: "abc", listed: "1.00", on: "2026-10-13" },
        other: { charged: "1.00", listed: "1.00" },
        text: "oops",
      }),
    });
    expect(Object.keys(readLastPrices(storage, organizationId))).toEqual([
      blue,
    ]);
  });
});

describe("price suggestions", () => {
  const prices = mergeLastPrices(
    {},
    [{ chargedUnitPrice: "49.90", listedUnitPrice: "59.90", variantId: blue }],
    "2026-10-13"
  );

  it("formats prices the way they are typed", () => {
    expect(priceFieldText("59.90")).toBe("59,90");
    expect(priceFieldText("49.9000")).toBe("49,90");
    expect(priceFieldText("50")).toBe("50,00");
    expect(priceFieldText("0.5")).toBe("0,50");
    expect(priceFieldText("1.234500")).toBe("1,2345");
    expect(priceFieldText("not a price")).toBe("not a price");
  });

  it("suggests the last prices of a known variant and nothing for others", () => {
    expect(suggestPrices(prices, blue)).toEqual({
      chargedUnitPrice: "49,90",
      listedUnitPrice: "59,90",
    });
    expect(suggestPrices(prices, green)).toBeNull();
    expect(suggestPrices(prices, "constructor")).toBeNull();
  });

  it("falls back to the variant list price when no sale was remembered", () => {
    expect(suggestPrices(prices, green, "39.90")).toEqual({
      chargedUnitPrice: "39,90",
      listedUnitPrice: "39,90",
    });
    // the last confirmed sale wins over the list price
    expect(suggestPrices(prices, blue, "39.90")).toEqual({
      chargedUnitPrice: "49,90",
      listedUnitPrice: "59,90",
    });
    expect(suggestPrices(prices, green, null)).toBeNull();
  });

  it("fills only the prices the operator has not typed", () => {
    const suggestion = suggestPrices(prices, blue);
    const empty = { chargedUnitPrice: "", listedUnitPrice: "", quantity: "1" };
    expect(withSuggestedPrices(empty, suggestion)).toEqual({
      chargedUnitPrice: "49,90",
      listedUnitPrice: "59,90",
      quantity: "1",
    });
    expect(
      withSuggestedPrices(
        { ...empty, chargedUnitPrice: "40", listedUnitPrice: "  " },
        suggestion
      )
    ).toMatchObject({ chargedUnitPrice: "40", listedUnitPrice: "59,90" });
    expect(withSuggestedPrices(empty, null)).toBe(empty);
  });

  it("explains the suggestion only while both prices are still the suggested ones", () => {
    const suggested = {
      chargedUnitPrice: "49,90",
      listedUnitPrice: "59,90",
      variantId: blue,
    };
    expect(suggestionHint(prices, suggested)).toContain("13/10/2026");
    expect(suggestionHint(prices, suggested)).toContain("edite");
    expect(
      suggestionHint(prices, { ...suggested, chargedUnitPrice: "45,00" })
    ).toBeNull();
    expect(
      suggestionHint(prices, { ...suggested, variantId: green })
    ).toBeNull();
  });
});
