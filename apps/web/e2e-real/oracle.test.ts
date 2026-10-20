import { describe, expect, it } from "vitest";
import {
  cents,
  moneyInput,
  numericCents,
  percentOfCents,
  saleTotals,
} from "./oracle";

describe("the oracle of the e2e journeys", () => {
  it("reads money as integer cents", () => {
    expect(cents("R$ 1.234,56")).toBe(123_456);
    expect(cents("R$ 0,07")).toBe(7);
    expect(cents("-R$ 0,10")).toBe(-10);
    expect(cents("15")).toBe(1500);
    expect(numericCents("12.30")).toBe(1230);
    expect(numericCents("0.1")).toBe(10);
    expect(numericCents("15")).toBe(1500);
    expect(() => numericCents("1.234")).toThrow();
    expect(moneyInput(105)).toBe("1,05");
  });

  it("rounds half-up once per adjustment", () => {
    expect(percentOfCents(104, "10")).toBe(10); // (a) 10,4 → down
    expect(percentOfCents(105, "10")).toBe(11); // (b) 10,5, even floor → up (half-even would give 10)
    expect(percentOfCents(115, "10")).toBe(12); // (c) 11,5, odd floor → up
    expect(percentOfCents(106, "10")).toBe(11); // (d) 10,6 → up
    expect(percentOfCents(1000, "2.5")).toBe(25);
  });

  it("does not compose percentages: each one on the same base", () => {
    // (e) two 10% discounts on 0,15: 1,5 + 1,5 → 2 + 2 = 4; one 20% would be 3, composed would be 2 + 1 = 3
    const totals = saleTotals(
      [
        { chargedCents: 7, quantity: 1 },
        { chargedCents: 8, quantity: 1 },
      ],
      ["10", "10"]
    );
    expect(totals).toEqual({
      discount: 4,
      discounts: [2, 2],
      subtotal: 15,
      total: 11,
    });
    expect(percentOfCents(15, "20")).toBe(3);
  });
});
