import { describe, expect, it } from "vitest";
import {
  array,
  assert as fcAssert,
  bigInt,
  integer,
  property,
  tuple,
} from "fast-check";
import {
  InvalidSaleAdjustmentError,
  SaleDiscountExceedsSubtotalError,
  calculateSaleAdjustments,
} from "./sale-adjustments";

function moneyFromMinorUnits(minorUnits: bigint): string {
  const sign = minorUnits < 0n ? "-" : "";
  const absolute = minorUnits < 0n ? -minorUnits : minorUnits;
  const whole = absolute / 100n;
  const fraction = (absolute % 100n).toString().padStart(2, "0");
  return `${sign}${whole}.${fraction}`;
}

function decimalFromUnits(units: bigint, scale: number): string {
  const digits = units.toString().padStart(scale + 1, "0");
  const whole = scale === 0 ? digits : digits.slice(0, -scale);
  const fraction = scale === 0 ? "" : `.${digits.slice(-scale)}`;
  return `${whole}${fraction}`;
}

describe("calculateSaleAdjustments", () => {
  it("calculates fixed and percentage adjustments into the due total", () => {
    expect(
      calculateSaleAdjustments({
        adjustments: [
          {
            kind: "discount",
            value: { percentage: "10", type: "percentage" },
          },
          {
            kind: "surcharge",
            value: { amount: "2", type: "fixed" },
          },
          {
            kind: "freight",
            value: { amount: "5", type: "fixed" },
          },
          {
            kind: "payment_surcharge",
            value: { amount: "3", type: "fixed" },
          },
        ],
        items: [{ chargedUnitPrice: "50", quantity: 1 }],
      })
    ).toEqual({
      adjustments: [
        {
          amount: "5.00",
          kind: "discount",
          percentage: "10.000000",
          position: 0,
          valueType: "percentage",
        },
        {
          amount: "2.00",
          kind: "surcharge",
          percentage: null,
          position: 1,
          valueType: "fixed",
        },
        {
          amount: "5.00",
          kind: "freight",
          percentage: null,
          position: 2,
          valueType: "fixed",
        },
        {
          amount: "3.00",
          kind: "payment_surcharge",
          percentage: null,
          position: 3,
          valueType: "fixed",
        },
      ],
      discountTotal: "5.00",
      freightTotal: "5.00",
      paymentSurchargeTotal: "3.00",
      subtotal: "50.00",
      surchargeTotal: "2.00",
      totalDue: "55.00",
    });
  });

  it("calculates every percentage from the negotiated subtotal without compounding", () => {
    const result = calculateSaleAdjustments({
      adjustments: [
        { kind: "discount", value: { percentage: "10", type: "percentage" } },
        { kind: "surcharge", value: { percentage: "10", type: "percentage" } },
      ],
      items: [{ chargedUnitPrice: "100", quantity: 1 }],
    });

    expect(result.subtotal).toBe("100.00");
    expect(result.adjustments.map((adjustment) => adjustment.amount)).toEqual([
      "10.00",
      "10.00",
    ]);
    expect(result.totalDue).toBe("100.00");
  });

  it("rounds each percentage adjustment half-up once to cents", () => {
    const result = calculateSaleAdjustments({
      adjustments: [
        { kind: "discount", value: { percentage: "10", type: "percentage" } },
        { kind: "discount", value: { percentage: "10", type: "percentage" } },
      ],
      items: [{ chargedUnitPrice: "0.05", quantity: 1 }],
    });

    expect(result.adjustments.map((adjustment) => adjustment.amount)).toEqual([
      "0.01",
      "0.01",
    ]);
    expect(result.discountTotal).toBe("0.02");
    expect(result.totalDue).toBe("0.03");
  });

  it("rejects discounts whose combined value exceeds the subtotal", () => {
    expect(() =>
      calculateSaleAdjustments({
        adjustments: [
          { kind: "discount", value: { amount: "1.00", type: "fixed" } },
          { kind: "discount", value: { percentage: "1", type: "percentage" } },
        ],
        items: [{ chargedUnitPrice: "1.00", quantity: 1 }],
      })
    ).toThrow(SaleDiscountExceedsSubtotalError);
  });

  it("requires at least one item and rejects negative values", () => {
    expect(() =>
      calculateSaleAdjustments({ items: [], adjustments: [] })
    ).toThrow(InvalidSaleAdjustmentError);
    expect(() =>
      calculateSaleAdjustments({
        adjustments: [],
        items: [{ chargedUnitPrice: "-0.01", quantity: 1 }],
      })
    ).toThrow(InvalidSaleAdjustmentError);
    expect(() =>
      calculateSaleAdjustments({
        adjustments: [
          { kind: "surcharge", value: { amount: "-1.00", type: "fixed" } },
        ],
        items: [{ chargedUnitPrice: "1.00", quantity: 1 }],
      })
    ).toThrow(InvalidSaleAdjustmentError);
  });

  it("rejects sparse item arrays instead of treating them as an empty subtotal", () => {
    const sparseItems = new Array<{
      chargedUnitPrice: string;
      quantity: number;
    }>(1);
    expect(() =>
      calculateSaleAdjustments({ items: sparseItems, adjustments: [] })
    ).toThrow(InvalidSaleAdjustmentError);
  });

  it("keeps freight and payment surcharge as fixed BRL values", () => {
    for (const kind of ["freight", "payment_surcharge"] as const) {
      expect(() =>
        calculateSaleAdjustments({
          adjustments: [
            { kind, value: { percentage: "5", type: "percentage" } },
          ],
          items: [{ chargedUnitPrice: "10.00", quantity: 1 }],
        })
      ).toThrow(InvalidSaleAdjustmentError);
    }
  });

  it("sums negotiated item prices and quantities exactly", async () => {
    await fcAssert(
      property(
        array(
          tuple(
            bigInt({ min: 0n, max: 1_000_000_000n }),
            integer({ min: 1, max: 1000 })
          ),
          { minLength: 1, maxLength: 8 }
        ),
        (lines) => {
          const expectedSubtotal = lines.reduce(
            (sum, [unitPrice, quantity]) => sum + unitPrice * BigInt(quantity),
            0n
          );
          const result = calculateSaleAdjustments({
            adjustments: [],
            items: lines.map(([unitPrice, quantity]) => ({
              chargedUnitPrice: moneyFromMinorUnits(unitPrice),
              quantity,
            })),
          });

          expect(result.subtotal).toBe(moneyFromMinorUnits(expectedSubtotal));
          expect(result.totalDue).toBe(moneyFromMinorUnits(expectedSubtotal));
        }
      ),
      { numRuns: 300 }
    );
  });

  it("applies matching percent adjustments to the same subtotal", async () => {
    await fcAssert(
      property(
        bigInt({ min: 0n, max: 1_000_000_000_000n }),
        bigInt({ min: 0n, max: 100_000_000n }),
        (subtotalCents, percentageUnits) => {
          const percentage = decimalFromUnits(percentageUnits, 6);
          const result = calculateSaleAdjustments({
            adjustments: [
              { kind: "discount", value: { percentage, type: "percentage" } },
              { kind: "surcharge", value: { percentage, type: "percentage" } },
            ],
            items: [
              {
                chargedUnitPrice: moneyFromMinorUnits(subtotalCents),
                quantity: 1,
              },
            ],
          });

          expect(result.totalDue).toBe(moneyFromMinorUnits(subtotalCents));
        }
      ),
      { numRuns: 300 }
    );
  });
});
