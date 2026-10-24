import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Money } from "../money/money";
import { assertProperty } from "../testing/property";
import { saleArbitrary } from "../testing/sale-fact-arbitrary";
import {
  calendarDates,
  dailySales,
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

const FROM = DATES[0] as string;
const TO = DATES.at(-1) as string;

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
});
