import fc from "fast-check";
import { assertProperty } from "../testing/property";
import { price, saleArbitrary } from "../testing/sale-fact-arbitrary";
import { describe, expect, it } from "vitest";
import { Money } from "../money/money";
import {
  InvalidSaleFactError,
  periodResult,
  type SaleFact,
  saleEconomics,
} from "./sale-economics";

const base: SaleFact = {
  adjustments: [],
  anticipationFee: "0.00",
  cancelled: false,
  items: [],
  linkedExpenses: [],
  processingFee: "0.00",
  returnLines: [],
};

const sale = (overrides: Partial<SaleFact>): SaleFact => ({
  ...base,
  ...overrides,
});

describe("saleEconomics", () => {
  it("walks the whole chain for a plain sale", () => {
    const result = saleEconomics(
      sale({
        adjustments: [
          { amount: "10.00", kind: "discount" },
          { amount: "15.00", kind: "freight" },
        ],
        items: [
          {
            chargedUnitPrice: "50.00",
            position: 0,
            quantity: 2,
            unitCost: "20.00",
          },
        ],
        linkedExpenses: ["5.00"],
        processingFee: "3.00",
      })
    );
    expect(result).toMatchObject({
      anticipationFee: "0.00",
      cogs: "40.00",
      commercialSurcharges: "15.00",
      contributionMargin: "57.00",
      counted: true,
      discounts: "10.00",
      grossProfit: "50.00",
      grossSales: "100.00",
      linkedExpenses: "5.00",
      netSales: "90.00",
      processingFee: "3.00",
      returns: "0.00",
      unitsSold: 2,
      unknown: { anticipationFees: 0, costItems: 0, processingFees: 0 },
    });
  });

  it("a returned unit gives back its price minus its share of the discount, and a restocked one is not consumed", () => {
    const items = [
      {
        chargedUnitPrice: "30.00",
        position: 0,
        quantity: 3,
        unitCost: "10.00",
      },
    ];
    const adjustments = [{ amount: "9.00", kind: "discount" as const }];
    const restocked = saleEconomics(
      sale({
        adjustments,
        items,
        returnLines: [
          { itemPosition: 0, restockedQuantity: 1, returnedQuantity: 1 },
        ],
      })
    );
    // 30.00 - (9.00 x 30 / 90 = 3.00) = 27.00 given back
    expect(restocked.returns).toBe("27.00");
    expect(restocked.netSales).toBe("54.00");
    expect(restocked.cogs).toBe("20.00");
    expect(restocked.grossProfit).toBe("34.00");
    expect(restocked.unitsSold).toBe(2);
    const damaged = saleEconomics(
      sale({
        adjustments,
        items,
        returnLines: [
          { itemPosition: 0, restockedQuantity: 0, returnedQuantity: 1 },
        ],
      })
    );
    expect(damaged.returns).toBe("27.00");
    // the unit was not restocked: its cost stays a cost
    expect(damaged.cogs).toBe("30.00");
  });

  it("surcharges, freight and the payment surcharge are not given back on a return", () => {
    const result = saleEconomics(
      sale({
        adjustments: [
          { amount: "6.00", kind: "freight" },
          { amount: "2.00", kind: "payment_surcharge" },
          { amount: "4.00", kind: "surcharge" },
        ],
        items: [
          {
            chargedUnitPrice: "10.00",
            position: 0,
            quantity: 1,
            unitCost: "4.00",
          },
        ],
        returnLines: [
          { itemPosition: 0, restockedQuantity: 1, returnedQuantity: 1 },
        ],
      })
    );
    expect(result.netSales).toBe("0.00");
    expect(result.commercialSurcharges).toBe("12.00");
    expect(result.contributionMargin).toBe("12.00");
  });

  it("a sale returned in full gives back exactly gross sales minus discounts, whatever the rounding", () => {
    const items = [
      { chargedUnitPrice: "1.00", position: 0, quantity: 1, unitCost: null },
      { chargedUnitPrice: "1.00", position: 1, quantity: 1, unitCost: null },
      { chargedUnitPrice: "1.00", position: 2, quantity: 1, unitCost: null },
    ];
    const adjustments = [{ amount: "1.00", kind: "discount" as const }];
    const result = saleEconomics(
      sale({
        adjustments,
        items,
        returnLines: items.map((item) => ({
          itemPosition: item.position,
          restockedQuantity: 0,
          returnedQuantity: 1,
        })),
      })
    );
    expect(result.returns).toBe("2.00");
    expect(result.netSales).toBe("0.00");
  });

  it("splitting a return into several lines gives the same result as one", () => {
    const items = [
      { chargedUnitPrice: "7.00", position: 0, quantity: 5, unitCost: "2.50" },
      { chargedUnitPrice: "3.00", position: 1, quantity: 4, unitCost: "1.10" },
    ];
    const adjustments = [{ amount: "4.33", kind: "discount" as const }];
    const one = saleEconomics(
      sale({
        adjustments,
        items,
        returnLines: [
          { itemPosition: 0, restockedQuantity: 3, returnedQuantity: 4 },
          { itemPosition: 1, restockedQuantity: 1, returnedQuantity: 2 },
        ],
      })
    );
    const split = saleEconomics(
      sale({
        adjustments,
        items,
        returnLines: [
          { itemPosition: 0, restockedQuantity: 1, returnedQuantity: 1 },
          { itemPosition: 1, restockedQuantity: 1, returnedQuantity: 1 },
          { itemPosition: 0, restockedQuantity: 2, returnedQuantity: 3 },
          { itemPosition: 1, restockedQuantity: 0, returnedQuantity: 1 },
        ],
      })
    );
    expect(split).toEqual(one);
  });

  it("never turns an unknown cost or fee into zero: it is left out and counted", () => {
    const result = saleEconomics(
      sale({
        anticipationFee: null,
        items: [
          {
            chargedUnitPrice: "10.00",
            position: 0,
            quantity: 1,
            unitCost: null,
          },
          {
            chargedUnitPrice: "20.00",
            position: 1,
            quantity: 1,
            unitCost: "8.00",
          },
        ],
        processingFee: null,
      })
    );
    expect(result.unknown).toEqual({
      anticipationFees: 1,
      costItems: 1,
      processingFees: 1,
    });
    expect(result.cogs).toBe("8.00");
    expect(result.processingFee).toBe("0.00");
  });

  it("rounds the COGS half-up once, from the six-place unit cost", () => {
    // 3 x 0.003333 = 0.009999 -> 0.01 ; 0.004999 x 1 -> 0.00
    expect(
      saleEconomics(
        sale({
          items: [
            {
              chargedUnitPrice: "1.00",
              position: 0,
              quantity: 3,
              unitCost: "0.003333",
            },
          ],
        })
      ).cogs
    ).toBe("0.01");
    expect(
      saleEconomics(
        sale({
          items: [
            {
              chargedUnitPrice: "1.00",
              position: 0,
              quantity: 1,
              unitCost: "0.004999",
            },
          ],
        })
      ).cogs
    ).toBe("0.00");
    // two items that round up only together (0.004 + 0.004 = 0.008 -> 0.01)
    expect(
      saleEconomics(
        sale({
          items: [
            {
              chargedUnitPrice: "1.00",
              position: 0,
              quantity: 1,
              unitCost: "0.004",
            },
            {
              chargedUnitPrice: "1.00",
              position: 1,
              quantity: 1,
              unitCost: "0.004",
            },
          ],
        })
      ).cogs
    ).toBe("0.01");
  });

  it("a cancelled sale counts for nothing", () => {
    const result = saleEconomics(
      sale({
        adjustments: [{ amount: "10.00", kind: "freight" }],
        cancelled: true,
        items: [
          {
            chargedUnitPrice: "50.00",
            position: 0,
            quantity: 2,
            unitCost: "20.00",
          },
        ],
        linkedExpenses: ["5.00"],
        processingFee: null,
      })
    );
    expect(result.counted).toBe(false);
    expect(result.grossSales).toBe("0.00");
    expect(result.contributionMargin).toBe("0.00");
    expect(result.unknown.processingFees).toBe(0);
  });

  it("a loss is a negative margin, not an error", () => {
    const result = saleEconomics(
      sale({
        items: [
          {
            chargedUnitPrice: "10.00",
            position: 0,
            quantity: 1,
            unitCost: "30.00",
          },
        ],
      })
    );
    expect(result.grossProfit).toBe("-20.00");
    expect(result.contributionMargin).toBe("-20.00");
  });

  it.each([
    [
      "a duplicated position",
      {
        items: [
          {
            chargedUnitPrice: "1.00",
            position: 0,
            quantity: 1,
            unitCost: null,
          },
          {
            chargedUnitPrice: "1.00",
            position: 0,
            quantity: 1,
            unitCost: null,
          },
        ],
      },
    ],
    [
      "a zero quantity",
      {
        items: [
          {
            chargedUnitPrice: "1.00",
            position: 0,
            quantity: 0,
            unitCost: null,
          },
        ],
      },
    ],
    [
      "a return of an unknown item",
      {
        items: [
          {
            chargedUnitPrice: "1.00",
            position: 0,
            quantity: 1,
            unitCost: null,
          },
        ],
        returnLines: [
          { itemPosition: 5, restockedQuantity: 0, returnedQuantity: 1 },
        ],
      },
    ],
    [
      "more returned than sold",
      {
        items: [
          {
            chargedUnitPrice: "1.00",
            position: 0,
            quantity: 2,
            unitCost: null,
          },
        ],
        returnLines: [
          { itemPosition: 0, restockedQuantity: 0, returnedQuantity: 2 },
          { itemPosition: 0, restockedQuantity: 0, returnedQuantity: 1 },
        ],
      },
    ],
    [
      "more restocked than returned",
      {
        items: [
          {
            chargedUnitPrice: "1.00",
            position: 0,
            quantity: 2,
            unitCost: null,
          },
        ],
        returnLines: [
          { itemPosition: 0, restockedQuantity: 2, returnedQuantity: 1 },
        ],
      },
    ],
    [
      "an invalid amount",
      {
        items: [
          {
            chargedUnitPrice: "1.005",
            position: 0,
            quantity: 1,
            unitCost: null,
          },
        ],
      },
    ],
  ])("refuses %s", (_label, override) => {
    expect(() => saleEconomics(sale(override))).toThrow(InvalidSaleFactError);
  });
});

// ---------------------------------------------------------------- properties

const minor = (value: string) => Money.from(value).minorUnits;

describe("economics properties", () => {
  it("the chain holds for any valid sale: net = gross - discounts - returns, and the margin follows", () => {
    assertProperty(
      fc.property(saleArbitrary, (fact) => {
        const result = saleEconomics(fact);
        expect(minor(result.netSales)).toBe(
          minor(result.grossSales) -
            minor(result.discounts) -
            minor(result.returns)
        );
        expect(minor(result.grossProfit)).toBe(
          minor(result.netSales) - minor(result.cogs)
        );
        expect(minor(result.contributionMargin)).toBe(
          minor(result.grossProfit) +
            minor(result.commercialSurcharges) -
            minor(result.processingFee) -
            minor(result.anticipationFee) -
            minor(result.linkedExpenses)
        );
      })
    );
  });

  it("returns never exceed what was sold net of discounts, and a full return gives back exactly that", () => {
    assertProperty(
      fc.property(saleArbitrary, (fact) => {
        const live = { ...fact, cancelled: false };
        const result = saleEconomics(live);
        expect(minor(result.returns)).toBeLessThanOrEqual(
          minor(result.grossSales) - minor(result.discounts)
        );
        const everything = saleEconomics({
          ...live,
          returnLines: live.items.map((item) => ({
            itemPosition: item.position,
            restockedQuantity: item.quantity,
            returnedQuantity: item.quantity,
          })),
        });
        expect(minor(everything.returns)).toBe(
          minor(everything.grossSales) - minor(everything.discounts)
        );
        expect(everything.netSales).toBe("0.00");
      })
    );
  });

  it("splitting the sales of a period in two adds up to the whole period, in any order", () => {
    assertProperty(
      fc.property(
        fc.array(saleArbitrary, { maxLength: 6 }),
        fc.array(price, { maxLength: 4 }),
        fc.array(price, { maxLength: 4 }),
        fc.nat(6),
        (sales, expensesA, expensesB, cut) => {
          const whole = periodResult(sales, [...expensesA, ...expensesB]);
          const a = periodResult(sales.slice(0, cut), expensesA);
          const b = periodResult(sales.slice(cut), expensesB);
          for (const field of [
            "cogs",
            "contributionMargin",
            "estimatedOperatingResult",
            "grossSales",
            "netSales",
            "operatingExpenses",
          ] as const) {
            expect(minor(whole[field])).toBe(minor(a[field]) + minor(b[field]));
          }
          expect(whole.salesCount).toBe(a.salesCount + b.salesCount);
          expect(whole.unknown.costItems).toBe(
            a.unknown.costItems + b.unknown.costItems
          );
          const reversed = periodResult([...sales].reverse(), [
            ...expensesB,
            ...expensesA,
          ]);
          expect(reversed).toEqual(whole);
        }
      )
    );
  });

  it("cancelled sales change nothing in a period", () => {
    assertProperty(
      fc.property(
        fc.array(saleArbitrary, { maxLength: 5 }),
        saleArbitrary,
        (sales, extra) => {
          const live = sales.map((entry) => ({ ...entry, cancelled: false }));
          const without = periodResult(live, []);
          const withCancelled = periodResult(
            [...live, { ...extra, cancelled: true }],
            []
          );
          expect(withCancelled).toEqual(without);
        }
      )
    );
  });

  it("an unknown cost lowers the COGS only by leaving it out, never by pricing it at zero", () => {
    assertProperty(
      fc.property(saleArbitrary, (fact) => {
        const live = { ...fact, cancelled: false };
        const unknownAll = saleEconomics({
          ...live,
          items: live.items.map((item) => ({ ...item, unitCost: null })),
          returnLines: [],
        });
        expect(unknownAll.cogs).toBe("0.00");
        expect(unknownAll.unknown.costItems).toBe(live.items.length);
      })
    );
  });
});

describe("periodResult", () => {
  it("subtracts the operating expenses (no sale) from the contribution margin and flags what is unknown", () => {
    const result = periodResult(
      [
        sale({
          items: [
            {
              chargedUnitPrice: "100.00",
              position: 0,
              quantity: 1,
              unitCost: "40.00",
            },
          ],
          processingFee: null,
        }),
        sale({
          cancelled: true,
          items: [
            {
              chargedUnitPrice: "999.00",
              position: 0,
              quantity: 1,
              unitCost: "1.00",
            },
          ],
        }),
      ],
      ["1500.00", "20.50"]
    );
    expect(result).toMatchObject({
      contributionMargin: "60.00",
      estimatedOperatingResult: "-1460.50",
      netSales: "100.00",
      operatingExpenses: "1520.50",
      salesCount: 1,
      unknown: { anticipationFees: 0, costItems: 0, processingFees: 1 },
    });
  });

  it("an empty period is all zeros", () => {
    expect(periodResult([], [])).toMatchObject({
      contributionMargin: "0.00",
      estimatedOperatingResult: "0.00",
      salesCount: 0,
    });
  });
});
