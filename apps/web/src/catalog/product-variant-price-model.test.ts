import { describe, expect, it } from "vitest";
import {
  listPriceFieldText,
  listPriceFromField,
} from "./product-variant-price-model";

describe("variant list price field", () => {
  it("shows a saved price as typed in Brazil and an absent one as empty", () => {
    expect(listPriceFieldText("59.90")).toBe("59,90");
    expect(listPriceFieldText("1200.00")).toBe("1200,00");
    expect(listPriceFieldText(null)).toBe("");
  });

  it("turns the text into the value the server expects", () => {
    expect(listPriceFromField("59,9")).toBe("59.90");
    expect(listPriceFromField(" 59.90 ")).toBe("59.90");
    expect(listPriceFromField("0")).toBe("0.00");
    expect(listPriceFromField("")).toBeNull();
    expect(listPriceFromField("   ")).toBeNull();
  });

  it("flags text that is not a price", () => {
    for (const text of ["abc", "-5", "1,234", "R$ 5", "1e3"]) {
      expect(listPriceFromField(text)).toBeUndefined();
    }
  });
});
