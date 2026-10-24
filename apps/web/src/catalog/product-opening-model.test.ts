import { describe, expect, it } from "vitest";
import {
  COST_INVALID,
  emptyOpeningDraft,
  PRICE_INVALID,
  QUANTITY_FOR_COST,
  QUANTITY_INVALID,
  validateOpening,
} from "./product-opening-model";

const draft = (fields: Partial<typeof emptyOpeningDraft>) => ({
  ...emptyOpeningDraft,
  ...fields,
});

describe("price and opening stock of a new product", () => {
  it("makes only the product when the price, the quantity and the cost are empty", () => {
    expect(validateOpening(emptyOpeningDraft)).toEqual({
      errors: {},
      value: { initialStock: null, listPrice: null },
    });
  });

  it("takes the price as the amount with two decimals, with a comma or a dot", () => {
    expect(validateOpening(draft({ listPrice: "49,9" })).value?.listPrice).toBe(
      "49.90"
    );
    expect(
      validateOpening(draft({ listPrice: " 49.90 " })).value?.listPrice
    ).toBe("49.90");
    expect(validateOpening(draft({ listPrice: "0" })).value?.listPrice).toBe(
      "0.00"
    );
  });

  it("opens the stock with the cost unknown when there is a quantity and no cost", () => {
    expect(validateOpening(draft({ quantity: "10" })).value).toEqual({
      initialStock: { quantity: 10, unitCost: null },
      listPrice: null,
    });
  });

  it("opens the stock with the cost when both are there", () => {
    expect(
      validateOpening(draft({ quantity: "10", unitCost: "12,5" })).value
    ).toEqual({
      initialStock: { quantity: 10, unitCost: "12.5" },
      listPrice: null,
    });
  });

  it("keeps a cost of zero as a known cost", () => {
    expect(
      validateOpening(draft({ quantity: "3", unitCost: "0" })).value
        ?.initialStock
    ).toEqual({ quantity: 3, unitCost: "0" });
  });

  it("takes a quantity of 0 as no quantity", () => {
    expect(validateOpening(draft({ quantity: "0" })).value).toEqual({
      initialStock: null,
      listPrice: null,
    });
    expect(
      validateOpening(draft({ quantity: "000" })).value?.initialStock
    ).toBe(null);
  });

  it("refuses a cost without a quantity, at the quantity, and sends nothing", () => {
    expect(validateOpening(draft({ unitCost: "12,50" }))).toEqual({
      errors: { quantity: QUANTITY_FOR_COST },
      value: null,
    });
    // a quantity of 0 is no quantity: the cost has nothing to belong to
    expect(validateOpening(draft({ quantity: "0", unitCost: "0" }))).toEqual({
      errors: { quantity: QUANTITY_FOR_COST },
      value: null,
    });
  });

  it("says what is wrong at each field, all at once", () => {
    expect(
      validateOpening(
        draft({ listPrice: "49,999", quantity: "1,5", unitCost: "abc" })
      )
    ).toEqual({
      errors: {
        listPrice: PRICE_INVALID,
        quantity: QUANTITY_INVALID,
        unitCost: COST_INVALID,
      },
      value: null,
    });
  });

  it("refuses a quantity above the limit of the ledger and a negative or decimal one", () => {
    expect(
      validateOpening(draft({ quantity: "2147483648" })).errors.quantity
    ).toBe("O limite é 2.147.483.647 unidades.");
    expect(
      validateOpening(draft({ quantity: "2147483647" })).value
    ).not.toBeNull();
    for (const quantity of ["-1", "2,5", "12345678901"]) {
      expect(validateOpening(draft({ quantity })).errors.quantity).toBe(
        QUANTITY_INVALID
      );
    }
  });

  it("does not ask for a quantity when the cost itself is the invalid one", () => {
    expect(validateOpening(draft({ unitCost: "abc" })).errors).toEqual({
      unitCost: COST_INVALID,
    });
  });
});
