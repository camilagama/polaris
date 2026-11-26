import { describe, expect, it } from "vitest";
import {
  adjustedTotals,
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

  it("sums discount in value, surcharge in percent and freight (AC-2.1)", () => {
    // subtotal 24,90 + 9,99 = 34,89; 10% of 3489 = 348,9 → 349; 3489 − 500 + 349 + 1200 = 4538
    const totals = adjustedTotals(
      [
        { chargedCents: 2490, quantity: 1 },
        { chargedCents: 999, quantity: 1 },
      ],
      [
        { cents: 500, kind: "discount" },
        { kind: "surcharge", percent: "10" },
        { cents: 1200, kind: "freight" },
      ]
    );
    expect(totals).toEqual({
      amounts: [500, 349, 1200],
      discount: 500,
      discountExceedsSubtotal: false,
      freight: 1200,
      subtotal: 3489,
      surcharge: 349,
      total: 4538,
    });
  });

  it("takes a discount and a surcharge of 10% on the same subtotal (AC-2.2)", () => {
    // 349 each on 3489 → the total goes back to 3489; composed it would be 3489 − 349 = 3140, + 314 = 3454
    const totals = adjustedTotals(
      [
        { chargedCents: 2490, quantity: 1 },
        { chargedCents: 999, quantity: 1 },
      ],
      [
        { kind: "discount", percent: "10" },
        { kind: "surcharge", percent: "10" },
      ]
    );
    expect(totals.amounts).toEqual([349, 349]);
    expect(totals.total).toBe(3489);
    // 10% off and 20% on 1000: 100 and 200, not 200 on 900 (180)
    expect(
      adjustedTotals(
        [{ chargedCents: 1000, quantity: 1 }],
        [
          { kind: "discount", percent: "10" },
          { kind: "surcharge", percent: "20" },
        ]
      ).total
    ).toBe(1100);
  });

  it("flags a discount above the subtotal, and accepts one equal to it", () => {
    const lines = [{ chargedCents: 1000, quantity: 2 }];
    expect(
      adjustedTotals(lines, [{ cents: 2001, kind: "discount" }])
        .discountExceedsSubtotal
    ).toBe(true);
    const equal = adjustedTotals(lines, [{ cents: 2000, kind: "discount" }]);
    expect(equal.discountExceedsSubtotal).toBe(false);
    expect(equal.total).toBe(0);
    // two discounts that pass the subtotal only together
    expect(
      adjustedTotals(lines, [
        { cents: 1500, kind: "discount" },
        { kind: "discount", percent: "30" },
      ]).discountExceedsSubtotal
    ).toBe(true);
  });
});
