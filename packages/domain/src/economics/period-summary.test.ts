import fc from "fast-check";
import { assertProperty } from "../testing/property";
import { describe, expect, it } from "vitest";
import { cogsCoverage, dashboardCards, resultQuality } from "./period-summary";
import {
  type PeriodResult,
  periodResult,
  type SaleFact,
} from "./sale-economics";

const sale = (overrides: Partial<SaleFact> = {}): SaleFact => ({
  adjustments: [],
  anticipationFee: "0.00",
  cancelled: false,
  items: [
    { chargedUnitPrice: "100.00", position: 0, quantity: 1, unitCost: "40.00" },
  ],
  linkedExpenses: [],
  processingFee: "0.00",
  returnLines: [],
  ...overrides,
});

const result = (sales: SaleFact[], expenses: string[]): PeriodResult =>
  periodResult(sales, expenses);

describe("dashboardCards", () => {
  it("shows net sales, result, margin, count, ticket and items", () => {
    const cards = dashboardCards(
      result(
        [
          sale(),
          sale({
            items: [
              {
                chargedUnitPrice: "50.00",
                position: 0,
                quantity: 3,
                unitCost: "10.00",
              },
            ],
          }),
        ],
        ["30.00"]
      )
    );
    // net 100 + 150 = 250 ; cogs 40 + 30 ; margin 180
    expect(cards).toEqual({
      items: 4,
      marginPercent: "72.00",
      netSales: "250.00",
      operatingResult: "150.00",
      salesCount: 2,
      ticket: "125.00",
    });
  });

  it("rounds the ticket and the margin half-up, and keeps a negative margin", () => {
    const cards = dashboardCards(
      result(
        [
          sale({
            items: [
              {
                chargedUnitPrice: "0.01",
                position: 0,
                quantity: 1,
                unitCost: null,
              },
            ],
          }),
          sale({
            items: [
              {
                chargedUnitPrice: "0.02",
                position: 0,
                quantity: 1,
                unitCost: null,
              },
            ],
          }),
        ],
        []
      )
    );
    // net 0.03 over 2 sales = 0.015 -> 0.02
    expect(cards.ticket).toBe("0.02");
    const loss = dashboardCards(
      result(
        [
          sale({
            items: [
              {
                chargedUnitPrice: "10.00",
                position: 0,
                quantity: 1,
                unitCost: "30.00",
              },
            ],
          }),
        ],
        []
      )
    );
    expect(loss.marginPercent).toBe("-200.00");
  });

  it("has no ticket and no margin without sales or without net sales", () => {
    expect(dashboardCards(result([], ["10.00"]))).toEqual({
      items: 0,
      marginPercent: null,
      netSales: "0.00",
      operatingResult: "-10.00",
      salesCount: 0,
      ticket: null,
    });
    const returned = dashboardCards(
      result(
        [
          sale({
            returnLines: [
              { itemPosition: 0, restockedQuantity: 1, returnedQuantity: 1 },
            ],
          }),
        ],
        []
      )
    );
    expect(returned.netSales).toBe("0.00");
    expect(returned.marginPercent).toBeNull();
    expect(returned.salesCount).toBe(1);
  });

  it("the margin percent matches the exact ratio for any amounts (property)", () => {
    assertProperty(
      fc.property(
        fc.integer({ max: 1_000_000, min: 1 }),
        fc.integer({ max: 1_000_000, min: 0 }),
        (priceCents, costCents) => {
          const price = `${Math.floor(priceCents / 100)}.${String(priceCents % 100).padStart(2, "0")}`;
          const cost = `${Math.floor(costCents / 100)}.${String(costCents % 100).padStart(2, "0")}`;
          const cards = dashboardCards(
            result(
              [
                sale({
                  items: [
                    {
                      chargedUnitPrice: price,
                      position: 0,
                      quantity: 1,
                      unitCost: cost,
                    },
                  ],
                }),
              ],
              []
            )
          );
          const exact = ((priceCents - costCents) * 10_000) / priceCents;
          const shown = Number(cards.marginPercent) * 100;
          expect(Math.abs(shown - exact)).toBeLessThanOrEqual(0.5 + 1e-9);
        }
      )
    );
  });
});

describe("cogsCoverage", () => {
  it("is full with no line or no unknown line, none when every line is unknown and partial in between", () => {
    expect(cogsCoverage({ itemLines: 0, itemLinesWithUnknownCost: 0 })).toBe(
      "full"
    );
    expect(cogsCoverage({ itemLines: 25, itemLinesWithUnknownCost: 0 })).toBe(
      "full"
    );
    expect(cogsCoverage({ itemLines: 25, itemLinesWithUnknownCost: 3 })).toBe(
      "partial"
    );
    expect(cogsCoverage({ itemLines: 25, itemLinesWithUnknownCost: 25 })).toBe(
      "none"
    );
  });
});

const noCostItem = (position: number) => ({
  chargedUnitPrice: "10.00",
  position,
  quantity: 1,
  unitCost: null,
});

describe("resultQuality", () => {
  it("the coverage of the cost of the goods: none, partial and full from the item lines", () => {
    const none = resultQuality(
      result([sale({ items: [noCostItem(0), noCostItem(1)] })], ["1.00"])
    );
    expect(none).toMatchObject({
      cogsCoverage: "none",
      itemLines: 2,
      itemLinesWithUnknownCost: 2,
      level: "partial",
      missing: ["unknown_cost"],
    });
    const mixed = resultQuality(
      result([sale(), sale({ items: [noCostItem(0)] })], ["1.00"])
    );
    expect(mixed.cogsCoverage).toBe("partial");
    expect(resultQuality(result([sale(), sale()], ["1.00"])).cogsCoverage).toBe(
      "full"
    );
  });

  it("an unknown fee alone leaves the coverage of the cost of the goods full", () => {
    const quality = resultQuality(
      result([sale({ anticipationFee: null, processingFee: null })], ["1.00"])
    );
    expect(quality.cogsCoverage).toBe("full");
    expect(quality.missing).toEqual([
      "unknown_processing_fee",
      "unknown_anticipation_fee",
    ]);
  });

  it("a cancelled sale with an item of unknown cost does not count against the coverage", () => {
    const quality = resultQuality(
      result(
        [sale({ cancelled: true, items: [noCostItem(0)] }), sale()],
        ["1.00"]
      )
    );
    expect(quality.cogsCoverage).toBe("full");
    expect(quality.level).toBe("complete");
  });

  it("is complete only when nothing was left out and expenses exist", () => {
    const quality = resultQuality(result([sale()], ["10.00"]));
    expect(quality.level).toBe("complete");
    expect(quality.missing).toEqual([]);
    expect(quality).toMatchObject({
      itemLines: 1,
      itemLinesWithUnknownCost: 0,
      operatingExpenses: 1,
      salesCount: 1,
    });
  });

  it("names everything that was left out", () => {
    const quality = resultQuality(
      result(
        [
          sale({
            anticipationFee: null,
            items: [
              {
                chargedUnitPrice: "10.00",
                position: 0,
                quantity: 1,
                unitCost: null,
              },
            ],
            processingFee: null,
          }),
        ],
        []
      )
    );
    expect(quality.level).toBe("partial");
    expect(quality.missing).toEqual([
      "unknown_cost",
      "unknown_processing_fee",
      "unknown_anticipation_fee",
      "no_expenses",
    ]);
    expect(quality).toMatchObject({
      anticipationFeesUnknown: 1,
      itemLinesWithUnknownCost: 1,
      processingFeesUnknown: 1,
    });
  });

  it("a period with sales and no expense is partial, and an empty one is no_data", () => {
    expect(resultQuality(result([sale()], [])).missing).toEqual([
      "no_expenses",
    ]);
    expect(resultQuality(result([], []))).toMatchObject({
      level: "no_data",
      missing: ["no_sales"],
    });
    // only expenses: not "no data", and not missing expenses
    expect(resultQuality(result([], ["5.00"])).level).toBe("complete");
  });

  it("a cancelled sale leaves nothing unknown behind", () => {
    const quality = resultQuality(
      result([sale({ cancelled: true, processingFee: null }), sale()], ["1.00"])
    );
    expect(quality.level).toBe("complete");
    expect(quality.salesCount).toBe(1);
  });

  it("an expense linked to a sale is an expense: only linked ones are not 'no expenses'", () => {
    expect(
      resultQuality(result([sale({ linkedExpenses: ["5.00"] })], [])).missing
    ).toEqual([]);
  });

  it("counts the expenses linked to the counted sales", () => {
    const quality = resultQuality(
      result([sale({ linkedExpenses: ["5.00", "6.00"] })], ["1.00"])
    );
    expect(quality.linkedExpenses).toBe(2);
    expect(quality.operatingExpenses).toBe(1);
  });
});
