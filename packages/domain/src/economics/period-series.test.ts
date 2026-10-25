import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Money } from "../money/money";
import { assertProperty } from "../testing/property";
import { price, saleArbitrary } from "../testing/sale-fact-arbitrary";
import {
  calendarDates,
  dailyEconomics,
  dailySales,
  type OperatingExpenseFact,
  productSales,
  topProducts,
} from "./period-series";
import {
  InvalidSaleFactError,
  periodResult,
  type SaleFact,
  saleEconomics,
  saleItemEconomics,
} from "./sale-economics";

const P1 = "0192a000-0000-7000-8000-000000000001";
const P2 = "0192a000-0000-7000-8000-000000000002";
const P3 = "0192a000-0000-7000-8000-000000000003";

const sale = (overrides: Partial<SaleFact> = {}): SaleFact => ({
  adjustments: [],
  anticipationFee: "0.00",
  cancelled: false,
  items: [
    {
      chargedUnitPrice: "100.00",
      position: 0,
      productId: P1,
      quantity: 1,
      unitCost: "40.00",
    },
  ],
  linkedExpenses: [],
  occurredOn: "2026-10-01",
  processingFee: "0.00",
  returnLines: [],
  ...overrides,
});

const minor = (value: string) => Money.from(value).minorUnits;

describe("calendarDates", () => {
  it("lists every date of the period, across months, leap days and years", () => {
    expect(calendarDates("2028-02-27", "2028-03-01")).toEqual([
      "2028-02-27",
      "2028-02-28",
      "2028-02-29",
      "2028-03-01",
    ]);
    expect(calendarDates("2026-12-31", "2027-01-01")).toEqual([
      "2026-12-31",
      "2027-01-01",
    ]);
    expect(calendarDates("2027-02-28", "2027-03-01")).toHaveLength(2);
    expect(calendarDates("2026-10-23", "2026-10-23")).toEqual(["2026-10-23"]);
    expect(calendarDates("2026-01-01", "2026-12-31")).toHaveLength(365);
  });

  it("refuses an inverted or impossible period", () => {
    expect(() => calendarDates("2026-10-02", "2026-10-01")).toThrow(
      InvalidSaleFactError
    );
    expect(() => calendarDates("2026-02-30", "2026-03-01")).toThrow(
      InvalidSaleFactError
    );
  });
});

describe("dailySales", () => {
  it("puts each sale on its commercial date and a day without sales at zero", () => {
    const series = dailySales(
      [
        sale({ occurredOn: "2026-10-01" }),
        sale({ occurredOn: "2026-10-03" }),
        sale({ occurredOn: "2026-10-03" }),
      ],
      "2026-10-01",
      "2026-10-04"
    );
    expect(series).toEqual([
      { date: "2026-10-01", netSales: "100.00", salesCount: 1 },
      { date: "2026-10-02", netSales: "0.00", salesCount: 0 },
      { date: "2026-10-03", netSales: "200.00", salesCount: 2 },
      { date: "2026-10-04", netSales: "0.00", salesCount: 0 },
    ]);
  });

  it("a cancelled sale is zero on its date and a return lowers the date of the sale it returns", () => {
    const series = dailySales(
      [
        sale({ cancelled: true, occurredOn: "2026-10-01" }),
        sale({
          items: [
            {
              chargedUnitPrice: "50.00",
              position: 0,
              productId: P1,
              quantity: 2,
              unitCost: null,
            },
          ],
          occurredOn: "2026-10-02",
          returnLines: [
            { itemPosition: 0, restockedQuantity: 1, returnedQuantity: 1 },
          ],
        }),
      ],
      "2026-10-01",
      "2026-10-03"
    );
    expect(series).toEqual([
      { date: "2026-10-01", netSales: "0.00", salesCount: 0 },
      { date: "2026-10-02", netSales: "50.00", salesCount: 1 },
      { date: "2026-10-03", netSales: "0.00", salesCount: 0 },
    ]);
  });

  it("refuses a sale without a date or outside the period", () => {
    const { occurredOn: _date, ...undated } = sale();
    expect(() => dailySales([undated], "2026-10-01", "2026-10-02")).toThrow(
      InvalidSaleFactError
    );
    expect(() =>
      dailySales(
        [sale({ occurredOn: "2026-09-30" })],
        "2026-10-01",
        "2026-10-02"
      )
    ).toThrow(InvalidSaleFactError);
    expect(() => dailySales([sale()], "2026-10-01", "2026-10-02", [])).toThrow(
      InvalidSaleFactError
    );
  });
});

const expense = (
  competenceOn: string,
  amount: string
): OperatingExpenseFact => ({ amount, competenceOn });

describe("dailyEconomics", () => {
  const day = (series: ReturnType<typeof dailyEconomics>, date: string) =>
    series.find((entry) => entry.date === date);

  it("a day of sales with known costs: costs are the cost of goods, fees and linked expenses, and the result is the day's", () => {
    const series = dailyEconomics(
      [
        sale({
          anticipationFee: "1.50",
          linkedExpenses: ["3.00"],
          occurredOn: "2026-10-02",
          processingFee: "2.50",
        }),
      ],
      [],
      "2026-10-01",
      "2026-10-03"
    );
    // cogs 40 + processing 2.50 + anticipation 1.50 + linked 3 = 47; net 100
    expect(day(series, "2026-10-02")).toEqual({
      costs: "47.00",
      date: "2026-10-02",
      netSales: "100.00",
      operatingExpenses: "0.00",
      operatingResult: "53.00",
      salesCount: 1,
    });
    // a day without sales or expenses is zero, never missing
    expect(day(series, "2026-10-01")).toEqual({
      costs: "0.00",
      date: "2026-10-01",
      netSales: "0.00",
      operatingExpenses: "0.00",
      operatingResult: "0.00",
      salesCount: 0,
    });
  });

  it("a day with an unknown cost, processing fee or anticipation fee is null in both fields, and the others are not", () => {
    const unknownCost = sale({
      items: [
        {
          chargedUnitPrice: "100.00",
          position: 0,
          productId: P1,
          quantity: 1,
          unitCost: null,
        },
      ],
      occurredOn: "2026-10-01",
    });
    const series = dailyEconomics(
      [
        unknownCost,
        sale({ occurredOn: "2026-10-02", processingFee: null }),
        sale({ anticipationFee: null, occurredOn: "2026-10-03" }),
        sale({ occurredOn: "2026-10-04" }),
      ],
      [],
      "2026-10-01",
      "2026-10-05"
    );
    for (const date of ["2026-10-01", "2026-10-02", "2026-10-03"]) {
      expect(day(series, date)).toMatchObject({
        costs: null,
        operatingResult: null,
      });
    }
    expect(day(series, "2026-10-04")).toMatchObject({
      costs: "40.00",
      operatingResult: "60.00",
    });
    expect(day(series, "2026-10-05")).toMatchObject({ costs: "0.00" });
    // the sales are still there: only the costs are unknown
    expect(day(series, "2026-10-01")).toMatchObject({
      netSales: "100.00",
      salesCount: 1,
    });
  });

  it("one unknown sale makes its whole day null, even beside a known one and an expense", () => {
    const series = dailyEconomics(
      [
        sale({ occurredOn: "2026-10-01" }),
        sale({ occurredOn: "2026-10-01", processingFee: null }),
      ],
      [expense("2026-10-01", "50.00")],
      "2026-10-01",
      "2026-10-01"
    );
    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({ costs: null, operatingResult: null });
  });

  it("a day with an expense and an unknown cost of goods has costs null and operatingExpenses filled", () => {
    const series = dailyEconomics(
      [
        sale({
          items: [
            {
              chargedUnitPrice: "100.00",
              position: 0,
              productId: P1,
              quantity: 1,
              unitCost: null,
            },
          ],
          occurredOn: "2026-10-01",
        }),
      ],
      [expense("2026-10-01", "50.00"), expense("2026-10-01", "12.34")],
      "2026-10-01",
      "2026-10-02"
    );
    expect(day(series, "2026-10-01")).toMatchObject({
      costs: null,
      operatingExpenses: "62.34",
      operatingResult: null,
    });
    // a day without expenses is "0.00", never null or missing
    expect(day(series, "2026-10-02")?.operatingExpenses).toBe("0.00");
  });

  it("a cancelled sale with unknown inputs counts as nothing: the day is zero, not null", () => {
    const series = dailyEconomics(
      [
        sale({
          cancelled: true,
          occurredOn: "2026-10-01",
          processingFee: null,
        }),
      ],
      [],
      "2026-10-01",
      "2026-10-01"
    );
    expect(series[0]).toMatchObject({
      costs: "0.00",
      netSales: "0.00",
      operatingResult: "0.00",
      salesCount: 0,
    });
  });

  it("an expense with no sale falls on its competence day, on a day with no sale at all", () => {
    const series = dailyEconomics(
      [sale({ occurredOn: "2026-10-01" })],
      [expense("2026-10-05", "1800.00"), expense("2026-10-05", "250.50")],
      "2026-10-01",
      "2026-10-07"
    );
    expect(day(series, "2026-10-05")).toEqual({
      costs: "2050.50",
      date: "2026-10-05",
      netSales: "0.00",
      operatingExpenses: "2050.50",
      operatingResult: "-2050.50",
      salesCount: 0,
    });
    expect(day(series, "2026-10-01")).toMatchObject({ costs: "40.00" });
    expect(day(series, "2026-10-06")).toMatchObject({ costs: "0.00" });
  });

  it("an expense after today is on its own day: every date to the end of the period is returned", () => {
    // "today" is the 10th; the rent is on the last day of the month
    const series = dailyEconomics(
      [sale({ occurredOn: "2026-10-10" })],
      [expense("2026-10-31", "900.00")],
      "2026-10-01",
      "2026-10-31"
    );
    expect(series).toHaveLength(31);
    expect(series.at(-1)).toMatchObject({
      costs: "900.00",
      date: "2026-10-31",
      operatingExpenses: "900.00",
      operatingResult: "-900.00",
    });
  });

  it("surcharges and freight stay in the result and never lower the costs, which are never negative", () => {
    const series = dailyEconomics(
      [
        sale({
          adjustments: [
            { amount: "10.00", kind: "freight" },
            { amount: "5.00", kind: "surcharge" },
            { amount: "2.00", kind: "payment_surcharge" },
          ],
          occurredOn: "2026-10-01",
        }),
        sale({
          adjustments: [{ amount: "50.00", kind: "freight" }],
          items: [
            {
              chargedUnitPrice: "10.00",
              position: 0,
              productId: P1,
              quantity: 1,
              unitCost: "0.00",
            },
          ],
          occurredOn: "2026-10-02",
        }),
      ],
      [],
      "2026-10-01",
      "2026-10-02"
    );
    // net 100, cogs 40, surcharges 17: costs 40 (not 23), result 77
    expect(day(series, "2026-10-01")).toMatchObject({
      costs: "40.00",
      operatingResult: "77.00",
    });
    // net 10, no cost, freight 50: costs 0 (not -50), result 60
    expect(day(series, "2026-10-02")).toMatchObject({
      costs: "0.00",
      operatingResult: "60.00",
    });
  });

  it("a return lowers the day of the sale it returns, and the units that went back to stock lower its cost of goods", () => {
    const series = dailyEconomics(
      [
        sale({
          occurredOn: "2026-10-01",
          returnLines: [
            { itemPosition: 0, restockedQuantity: 1, returnedQuantity: 1 },
          ],
        }),
      ],
      [],
      "2026-10-01",
      "2026-10-02"
    );
    expect(day(series, "2026-10-01")).toMatchObject({
      costs: "0.00",
      netSales: "0.00",
      operatingResult: "0.00",
    });
    expect(day(series, "2026-10-02")).toMatchObject({ costs: "0.00" });
  });

  it("refuses an expense outside the period or a sale without a date", () => {
    expect(() =>
      dailyEconomics(
        [],
        [expense("2026-11-01", "1.00")],
        "2026-10-01",
        "2026-10-31"
      )
    ).toThrow(InvalidSaleFactError);
    expect(() =>
      dailyEconomics(
        [],
        [expense("2026-09-30", "1.00")],
        "2026-10-01",
        "2026-10-31"
      )
    ).toThrow(InvalidSaleFactError);
    expect(() =>
      dailyEconomics(
        [sale({ occurredOn: "2026-11-01" })],
        [],
        "2026-10-01",
        "2026-10-31"
      )
    ).toThrow(InvalidSaleFactError);
  });

  it("keeps the figures of dailySales as they are", () => {
    const sales = [sale({ occurredOn: "2026-10-01" })];
    expect(
      dailyEconomics(sales, [], "2026-10-01", "2026-10-03").map(
        ({ date, netSales, salesCount }) => ({ date, netSales, salesCount })
      )
    ).toEqual(dailySales(sales, "2026-10-01", "2026-10-03"));
  });
});

describe("topProducts", () => {
  const item = (
    position: number,
    productId: string,
    quantity: number,
    chargedUnitPrice = "10.00"
  ) => ({
    chargedUnitPrice,
    position,
    productId,
    quantity,
    unitCost: null,
  });

  it("ranks by units, then net sales, then product ID, and adds across sales", () => {
    const sales = [
      sale({ items: [item(0, P2, 2), item(1, P3, 2, "20.00")] }),
      sale({ items: [item(0, P1, 1, "5.00")] }),
      sale({ items: [item(0, P1, 1, "5.00")] }),
    ];
    expect(topProducts(sales, 10)).toEqual([
      { netSales: "40.00", productId: P3, quantity: 2 },
      { netSales: "20.00", productId: P2, quantity: 2 },
      { netSales: "10.00", productId: P1, quantity: 2 },
    ]);
    expect(topProducts(sales, 2).map((entry) => entry.productId)).toEqual([
      P3,
      P2,
    ]);
  });

  it("more units rank first even with lower net sales", () => {
    expect(
      topProducts(
        [sale({ items: [item(0, P2, 3, "1.00"), item(1, P3, 2, "50.00")] })],
        2
      ).map((entry) => [entry.productId, entry.quantity])
    ).toEqual([
      [P2, 3],
      [P3, 2],
    ]);
  });

  it("a full tie is broken by the product ID, whatever the order of the sales", () => {
    const a = sale({ items: [item(0, P2, 1)] });
    const b = sale({ items: [item(0, P1, 1)] });
    expect(topProducts([a, b], 2)).toEqual(topProducts([b, a], 2));
    expect(topProducts([a, b], 1)[0]?.productId).toBe(P1);
  });

  it("leaves out a product returned in full and the cancelled sales, and nets the discount", () => {
    const sales = [
      sale({
        items: [item(0, P1, 1)],
        returnLines: [
          { itemPosition: 0, restockedQuantity: 0, returnedQuantity: 1 },
        ],
      }),
      sale({ cancelled: true, items: [item(0, P2, 5)] }),
      sale({
        adjustments: [{ amount: "3.00", kind: "discount" }],
        items: [item(0, P3, 1)],
      }),
    ];
    expect(topProducts(sales, 10)).toEqual([
      { netSales: "7.00", productId: P3, quantity: 1 },
    ]);
    expect(productSales(sales)).toEqual([
      { netSales: "7.00", productId: P3, quantity: 1 },
      { netSales: "0.00", productId: P1, quantity: 0 },
    ]);
  });

  it("refuses an item without a product and a limit below one", () => {
    expect(() =>
      topProducts(
        [
          sale({
            items: [
              {
                chargedUnitPrice: "1.00",
                position: 0,
                quantity: 1,
                unitCost: null,
              },
            ],
          }),
        ],
        3
      )
    ).toThrow(InvalidSaleFactError);
    expect(() => topProducts([], 0)).toThrow(InvalidSaleFactError);
  });
});

// ---------------------------------------------------------------- properties

const DATES = calendarDates("2026-10-01", "2026-10-07");
const PRODUCTS = [P1, P2, P3];

/** A sale of the generator, placed on one of the dates and with products on its items. */
const datedSale = fc
  .record({
    dateIndex: fc.nat(DATES.length - 1),
    fact: saleArbitrary,
    products: fc.array(fc.nat(PRODUCTS.length - 1), {
      maxLength: 5,
      minLength: 5,
    }),
  })
  .map(
    ({ dateIndex, fact, products }): SaleFact => ({
      ...fact,
      items: fact.items.map((entry, index) => ({
        ...entry,
        productId: PRODUCTS[products[index] ?? 0] as string,
      })),
      occurredOn: DATES[dateIndex] as string,
    })
  );

/** The same sales with every cost and fee known, so no day is null. */
const knownSale = datedSale.map(
  (fact): SaleFact => ({
    ...fact,
    anticipationFee: fact.anticipationFee ?? "0.50",
    items: fact.items.map((entry) => ({
      ...entry,
      unitCost: entry.unitCost ?? "5.000000",
    })),
    processingFee: fact.processingFee ?? "1.00",
  })
);

const FROM = DATES[0] as string;
const TO = DATES.at(-1) as string;

/** An expense with no sale placed on one of the dates. */
const datedExpense = fc
  .record({ amount: price, dateIndex: fc.nat(DATES.length - 1) })
  .map(
    ({ amount, dateIndex }): OperatingExpenseFact => ({
      amount,
      competenceOn: DATES[dateIndex] as string,
    })
  );

describe("period series properties", () => {
  it("the series adds up to the period: Σ net sales and Σ sales are the period's", () => {
    assertProperty(
      fc.property(fc.array(datedSale, { maxLength: 12 }), (sales) => {
        const result = periodResult(sales, []);
        const series = dailySales(sales, FROM, TO);
        expect(series).toHaveLength(DATES.length);
        expect(
          series.reduce((total, day) => total + minor(day.netSales), 0n)
        ).toBe(minor(result.netSales));
        expect(series.reduce((total, day) => total + day.salesCount, 0)).toBe(
          result.salesCount
        );
      })
    );
  });

  it("each day is the result of that day's sales alone, whatever the order of the sales", () => {
    assertProperty(
      fc.property(
        fc.array(datedSale, { maxLength: 12 }),
        fc.nat(DATES.length - 1),
        (sales, dayIndex) => {
          const date = DATES[dayIndex] as string;
          const ofTheDay = sales.filter((entry) => entry.occurredOn === date);
          const alone = periodResult(ofTheDay, []);
          const day = dailySales(sales, FROM, TO).find(
            (entry) => entry.date === date
          );
          expect(day).toEqual({
            date,
            netSales: alone.netSales,
            salesCount: alone.salesCount,
          });
          expect(dailySales([...sales].reverse(), FROM, TO)).toEqual(
            dailySales(sales, FROM, TO)
          );
        }
      )
    );
  });

  it("the full ranking adds up to the units sold and the net sales, and its order does not depend on the sales' order", () => {
    assertProperty(
      fc.property(fc.array(datedSale, { maxLength: 12 }), (sales) => {
        const result = periodResult(sales, []);
        const ranking = productSales(sales);
        expect(
          ranking.reduce((total, entry) => total + entry.quantity, 0)
        ).toBe(result.unitsSold);
        expect(
          ranking.reduce((total, entry) => total + minor(entry.netSales), 0n)
        ).toBe(minor(result.netSales));
        expect(productSales([...sales].reverse())).toEqual(ranking);
      })
    );
  });

  it("the items of a sale add up to the sale exactly", () => {
    assertProperty(
      fc.property(datedSale, (fact) => {
        const whole = saleEconomics(fact);
        const items = saleItemEconomics(fact);
        expect(items.reduce((total, entry) => total + entry.unitsSold, 0)).toBe(
          whole.unitsSold
        );
        expect(
          items.reduce((total, entry) => total + entry.netSales.minorUnits, 0n)
        ).toBe(minor(whole.netSales));
      })
    );
  });

  it("passing the economics already computed gives the same result and series", () => {
    assertProperty(
      fc.property(fc.array(datedSale, { maxLength: 8 }), (sales) => {
        const economics = sales.map(saleEconomics);
        expect(periodResult(sales, ["5.00"], economics)).toEqual(
          periodResult(sales, ["5.00"])
        );
        expect(dailySales(sales, FROM, TO, economics)).toEqual(
          dailySales(sales, FROM, TO)
        );
      })
    );
  });

  describe("the costs and the result of each day", () => {
    const costsOf = (result: ReturnType<typeof periodResult>) =>
      [
        result.cogs,
        result.processingFees,
        result.anticipationFees,
        result.linkedExpenses,
        result.operatingExpenses,
      ].reduce((total, value) => total + minor(value), 0n);
    const hasUnknown = (result: ReturnType<typeof periodResult>) =>
      result.unknown.costItems +
        result.unknown.processingFees +
        result.unknown.anticipationFees >
      0;

    it("the days add up to the period when no day is null: Σ costs is the chain's costs and Σ result is the estimated result", () => {
      assertProperty(
        fc.property(
          fc.array(knownSale, { maxLength: 12 }),
          fc.array(datedExpense, { maxLength: 6 }),
          (sales, expenses) => {
            const result = periodResult(
              sales,
              expenses.map((entry) => entry.amount)
            );
            const series = dailyEconomics(sales, expenses, FROM, TO);
            expect(series).toHaveLength(DATES.length);
            expect(hasUnknown(result)).toBe(false);
            expect(series.every((entry) => entry.costs !== null)).toBe(true);
            expect(
              series.reduce(
                (total, entry) => total + minor(entry.costs as string),
                0n
              )
            ).toBe(costsOf(result));
            expect(
              series.reduce(
                (total, entry) => total + minor(entry.operatingExpenses),
                0n
              )
            ).toBe(minor(result.operatingExpenses));
            expect(
              series.reduce(
                (total, entry) =>
                  total + minor(entry.operatingResult as string),
                0n
              )
            ).toBe(minor(result.estimatedOperatingResult));
          }
        )
      );
    });

    it("the operating expenses of the days add up to the chain's, also when a day is null, and never exceed a known day's costs", () => {
      assertProperty(
        fc.property(
          fc.array(datedSale, { maxLength: 12 }),
          fc.array(datedExpense, { maxLength: 6 }),
          (sales, expenses) => {
            const result = periodResult(
              sales,
              expenses.map((entry) => entry.amount)
            );
            const series = dailyEconomics(sales, expenses, FROM, TO);
            expect(
              series.reduce(
                (total, entry) => total + minor(entry.operatingExpenses),
                0n
              )
            ).toBe(minor(result.operatingExpenses));
            for (const entry of series) {
              if (entry.costs !== null) {
                expect(minor(entry.operatingExpenses)).toBeLessThanOrEqual(
                  minor(entry.costs)
                );
              }
            }
            // a day with no sale at all: its costs are its expenses
            for (const entry of series) {
              if (entry.salesCount === 0 && entry.costs !== null) {
                expect(entry.costs).toBe(entry.operatingExpenses);
              }
            }
          }
        )
      );
    });

    it("an unknown cost or fee in the period leaves at least one day null, never a number", () => {
      let withUnknown = 0;
      assertProperty(
        fc.property(
          fc.array(datedSale, { maxLength: 12 }),
          fc.array(datedExpense, { maxLength: 6 }),
          (sales, expenses) => {
            const result = periodResult(
              sales,
              expenses.map((entry) => entry.amount)
            );
            if (hasUnknown(result)) {
              withUnknown += 1;
              expect(
                dailyEconomics(sales, expenses, FROM, TO).some(
                  (entry) => entry.costs === null
                )
              ).toBe(true);
            }
          }
        )
      );
      // the property must not pass by never meeting an unknown input
      expect(withUnknown).toBeGreaterThan(0);
    });

    it("a day is null in both fields or in neither, and its costs are never negative", () => {
      assertProperty(
        fc.property(
          fc.array(datedSale, { maxLength: 12 }),
          fc.array(datedExpense, { maxLength: 6 }),
          (sales, expenses) => {
            const series = dailyEconomics(sales, expenses, FROM, TO);
            for (const entry of series) {
              expect(entry.costs === null).toBe(entry.operatingResult === null);
              if (entry.costs !== null) {
                expect(minor(entry.costs)).toBeGreaterThanOrEqual(0n);
              }
            }
          }
        )
      );
    });

    it("each day is the period of that day alone, whatever the order of the sales and the expenses", () => {
      assertProperty(
        fc.property(
          fc.array(datedSale, { maxLength: 12 }),
          fc.array(datedExpense, { maxLength: 6 }),
          fc.nat(DATES.length - 1),
          (sales, expenses, dayIndex) => {
            const date = DATES[dayIndex] as string;
            const alone = periodResult(
              sales.filter((entry) => entry.occurredOn === date),
              expenses
                .filter((entry) => entry.competenceOn === date)
                .map((entry) => entry.amount)
            );
            const series = dailyEconomics(sales, expenses, FROM, TO);
            const found = series.find((candidate) => candidate.date === date);
            expect(found).toEqual({
              costs: hasUnknown(alone)
                ? null
                : Money.fromMinorUnits(costsOf(alone)).toString(),
              date,
              netSales: alone.netSales,
              operatingExpenses: alone.operatingExpenses,
              operatingResult: hasUnknown(alone)
                ? null
                : alone.estimatedOperatingResult,
              salesCount: alone.salesCount,
            });
            // the same day read as a period of one day (from = to)
            expect(
              dailyEconomics(
                sales.filter((candidate) => candidate.occurredOn === date),
                expenses.filter((candidate) => candidate.competenceOn === date),
                date,
                date
              )
            ).toEqual([found]);
            expect(
              dailyEconomics(
                [...sales].reverse(),
                [...expenses].reverse(),
                FROM,
                TO
              )
            ).toEqual(series);
          }
        )
      );
    });

    it("passing the economics already computed gives the same series", () => {
      assertProperty(
        fc.property(
          fc.array(datedSale, { maxLength: 8 }),
          fc.array(datedExpense, { maxLength: 4 }),
          (sales, expenses) => {
            expect(
              dailyEconomics(
                sales,
                expenses,
                FROM,
                TO,
                sales.map(saleEconomics)
              )
            ).toEqual(dailyEconomics(sales, expenses, FROM, TO));
          }
        )
      );
    });
  });
});
