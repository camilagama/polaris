import { array, assert as fcAssert, integer, property } from "fast-check";
import { describe, expect, it } from "vitest";
import {
  InvalidSaleReturnError,
  MAX_RETURN_NOTE_CODE_POINTS,
  normalizeReturnSaleCommand,
  planSaleReturn,
  RETURN_REASON_CODES,
  type ReturnLineInput,
  SaleReturnExceedsAvailableError,
  type SaleReturnItemFacts,
  UnsupportedSaleReturnCommandVersionError,
} from "./sale-return";

const commandId = "0190a9d2-7c4c-7b2f-9c0e-5f4f4f0d6a11";
const saleId = "0190a9d2-7c4c-7b2f-9c0e-5f4f4f0d6a12";

function command(overrides: Record<string, unknown> = {}) {
  return {
    commandId,
    commandVersion: 1,
    items: [{ position: 0, restockedQuantity: 1, returnedQuantity: 2 }],
    saleId,
    ...overrides,
  } as Parameters<typeof normalizeReturnSaleCommand>[0];
}

function item(
  position: number,
  quantity: number,
  returnedSoFar = 0
): SaleReturnItemFacts {
  return {
    position,
    productId: `p${position}`,
    quantity,
    returnedSoFar,
    unitCost: position % 2 === 0 ? "10.000000" : null,
    variantId: `v${position}`,
  };
}

describe("normalizeReturnSaleCommand", () => {
  it("accepts returned 2 restocked 1 (a damaged unit does not go back)", () => {
    expect(normalizeReturnSaleCommand(command())).toEqual({
      commandId,
      items: [{ position: 0, restockedQuantity: 1, returnedQuantity: 2 }],
      reasonCode: null,
      reasonNote: null,
      saleId,
    });
  });

  it("accepts a return that restocks nothing", () => {
    expect(
      normalizeReturnSaleCommand(
        command({
          items: [{ position: 3, restockedQuantity: 0, returnedQuantity: 1 }],
        })
      ).items
    ).toEqual([{ position: 3, restockedQuantity: 0, returnedQuantity: 1 }]);
  });

  it("sorts lines by item position and lowercases ids", () => {
    const normalized = normalizeReturnSaleCommand(
      command({
        commandId: commandId.toUpperCase(),
        items: [
          { position: 2, restockedQuantity: 1, returnedQuantity: 1 },
          { position: 0, restockedQuantity: 0, returnedQuantity: 1 },
        ],
        saleId: saleId.toUpperCase(),
      })
    );
    expect(normalized.items.map((line) => line.position)).toEqual([0, 2]);
    expect(normalized.commandId).toBe(commandId);
    expect(normalized.saleId).toBe(saleId);
  });

  it("rejects restocked above returned, non-positive returned and bad integers", () => {
    for (const line of [
      { position: 0, restockedQuantity: 3, returnedQuantity: 2 },
      { position: 0, restockedQuantity: 0, returnedQuantity: 0 },
      { position: 0, restockedQuantity: -1, returnedQuantity: 1 },
      { position: 0, restockedQuantity: 0, returnedQuantity: 1.5 },
      { position: -1, restockedQuantity: 0, returnedQuantity: 1 },
      { position: 0, restockedQuantity: 0, returnedQuantity: 2_147_483_648 },
      { position: 0, restockedQuantity: Number.NaN, returnedQuantity: 1 },
    ]) {
      expect(() =>
        normalizeReturnSaleCommand(command({ items: [line] }))
      ).toThrow(InvalidSaleReturnError);
    }
  });

  it("rejects empty returns, duplicate items, bad ids and unsupported versions", () => {
    expect(() => normalizeReturnSaleCommand(command({ items: [] }))).toThrow(
      InvalidSaleReturnError
    );
    expect(() =>
      normalizeReturnSaleCommand(
        command({
          items: [
            { position: 1, restockedQuantity: 0, returnedQuantity: 1 },
            { position: 1, restockedQuantity: 1, returnedQuantity: 1 },
          ],
        })
      )
    ).toThrow(InvalidSaleReturnError);
    expect(() =>
      normalizeReturnSaleCommand(command({ commandId: "nope" }))
    ).toThrow(InvalidSaleReturnError);
    expect(() =>
      normalizeReturnSaleCommand(command({ saleId: "nope" }))
    ).toThrow(InvalidSaleReturnError);
    expect(() =>
      normalizeReturnSaleCommand(command({ commandVersion: 2 }))
    ).toThrow(UnsupportedSaleReturnCommandVersionError);
  });

  it("rejects notes PostgreSQL could not store faithfully", () => {
    for (const reasonNote of [
      "com\u0000nulo",
      "surrogate \ud800 solto",
      "x".repeat(5000),
    ]) {
      expect(() =>
        normalizeReturnSaleCommand(command({ reasonCode: "other", reasonNote }))
      ).toThrow(InvalidSaleReturnError);
    }
  });

  it("validates the optional structured reason like a cancellation", () => {
    for (const reasonCode of RETURN_REASON_CODES) {
      if (reasonCode === "other") {
        expect(() =>
          normalizeReturnSaleCommand(command({ reasonCode }))
        ).toThrow(InvalidSaleReturnError);
        expect(
          normalizeReturnSaleCommand(
            command({ reasonCode, reasonNote: "  motivo livre " })
          ).reasonNote
        ).toBe("motivo livre");
      } else {
        expect(
          normalizeReturnSaleCommand(command({ reasonCode })).reasonCode
        ).toBe(reasonCode);
      }
    }
    expect(() =>
      normalizeReturnSaleCommand(command({ reasonCode: "fraud" }))
    ).toThrow(InvalidSaleReturnError);
    expect(() =>
      normalizeReturnSaleCommand(command({ reasonNote: "sem motivo" }))
    ).toThrow(InvalidSaleReturnError);
    expect(() =>
      normalizeReturnSaleCommand(
        command({
          reasonCode: "other",
          reasonNote: "x".repeat(MAX_RETURN_NOTE_CODE_POINTS + 1),
        })
      )
    ).toThrow(InvalidSaleReturnError);
  });
});

describe("planSaleReturn", () => {
  it("plans lines in position order with the cost snapshot of each item", () => {
    const plan = planSaleReturn(
      [item(0, 5), item(1, 3, 1)],
      [
        { position: 1, restockedQuantity: 0, returnedQuantity: 2 },
        { position: 0, restockedQuantity: 1, returnedQuantity: 2 },
      ]
    );
    expect(plan).toEqual([
      {
        availableBefore: 5,
        position: 0,
        productId: "p0",
        restockedQuantity: 1,
        returnedQuantity: 2,
        unitCost: "10.000000",
        variantId: "v0",
      },
      {
        availableBefore: 2,
        position: 1,
        productId: "p1",
        restockedQuantity: 0,
        returnedQuantity: 2,
        unitCost: null,
        variantId: "v1",
      },
    ]);
  });

  it("rejects returning more than is still available", () => {
    expect(() =>
      planSaleReturn(
        [item(0, 3, 2)],
        [{ position: 0, restockedQuantity: 0, returnedQuantity: 2 }]
      )
    ).toThrow(SaleReturnExceedsAvailableError);
    expect(() =>
      planSaleReturn(
        [item(0, 3, 3)],
        [{ position: 0, restockedQuantity: 0, returnedQuantity: 1 }]
      )
    ).toThrow(SaleReturnExceedsAvailableError);
  });

  it("rejects an unknown item position and restocked above returned", () => {
    expect(() =>
      planSaleReturn(
        [item(0, 3)],
        [{ position: 4, restockedQuantity: 0, returnedQuantity: 1 }]
      )
    ).toThrow(InvalidSaleReturnError);
    expect(() =>
      planSaleReturn(
        [item(0, 3)],
        [{ position: 0, restockedQuantity: 2, returnedQuantity: 1 }]
      )
    ).toThrow(InvalidSaleReturnError);
  });

  it("rejects the same position twice even when each line fits alone", () => {
    expect(() =>
      planSaleReturn(
        [item(0, 3)],
        [
          { position: 0, restockedQuantity: 0, returnedQuantity: 2 },
          { position: 0, restockedQuantity: 0, returnedQuantity: 2 },
        ]
      )
    ).toThrow(InvalidSaleReturnError);
  });

  it("allows returning exactly the remaining units, once", () => {
    const first = planSaleReturn(
      [item(0, 3)],
      [{ position: 0, restockedQuantity: 3, returnedQuantity: 3 }]
    );
    expect(first[0]?.availableBefore).toBe(3);
    expect(() =>
      planSaleReturn(
        [item(0, 3, 3)],
        [{ position: 0, restockedQuantity: 0, returnedQuantity: 1 }]
      )
    ).toThrow(SaleReturnExceedsAvailableError);
  });
});

describe("return invariants (property tests)", () => {
  const quantity = integer({ max: 50, min: 1 });
  const attempts = array(
    array(
      integer({ max: 60, min: 0 }).chain((returned) =>
        integer({ max: Math.max(returned, 0), min: 0 }).map((restocked) => ({
          restocked,
          returned,
        }))
      ),
      { maxLength: 3, minLength: 1 }
    ),
    { maxLength: 12, minLength: 1 }
  );

  it("never lets cumulative returns exceed what was sold, and restocked <= returned", () => {
    fcAssert(
      property(
        array(quantity, { maxLength: 3, minLength: 1 }),
        attempts,
        (sold, rounds) => {
          const returned = sold.map(() => 0);
          let restockedTotal = 0;
          for (const round of rounds) {
            const lines: ReturnLineInput[] = round
              .map((attempt, index) => ({
                position: index % sold.length,
                restockedQuantity: attempt.restocked,
                returnedQuantity: attempt.returned,
              }))
              .filter(
                (line, index, all) =>
                  all.findIndex((other) => other.position === line.position) ===
                  index
              );
            const facts = sold.map((quantityOf, position) =>
              item(position, quantityOf, returned[position] ?? 0)
            );
            // Oracle: the first line (in position order) that cannot be
            // returned decides the error; with none, the plan is accepted.
            const firstBad = [...lines]
              .sort((left, right) => left.position - right.position)
              .map((line) => {
                const available =
                  (sold[line.position] ?? 0) - (returned[line.position] ?? 0);
                if (line.returnedQuantity < 1) {
                  return InvalidSaleReturnError;
                }
                return line.returnedQuantity > available
                  ? SaleReturnExceedsAvailableError
                  : null;
              })
              .find((error) => error !== null);
            if (firstBad) {
              expect(() => planSaleReturn(facts, lines)).toThrow(firstBad);
            } else {
              const plan = planSaleReturn(facts, lines);
              expect(plan).toHaveLength(lines.length);
              for (const planned of plan) {
                expect(planned.returnedQuantity).toBeGreaterThanOrEqual(1);
                expect(planned.restockedQuantity).toBeLessThanOrEqual(
                  planned.returnedQuantity
                );
                expect(planned.returnedQuantity).toBeLessThanOrEqual(
                  planned.availableBefore
                );
                returned[planned.position] =
                  (returned[planned.position] ?? 0) + planned.returnedQuantity;
                restockedTotal += planned.restockedQuantity;
              }
            }
            sold.forEach((quantityOf, position) => {
              expect(returned[position] ?? 0).toBeLessThanOrEqual(quantityOf);
            });
          }
          const totalReturned = returned.reduce((sum, value) => sum + value, 0);
          expect(restockedTotal).toBeLessThanOrEqual(totalReturned);
        }
      ),
      { numRuns: 300 }
    );
  });

  it("a rejected plan has no effect: the same facts plan the same way afterwards", () => {
    fcAssert(
      property(quantity, integer({ max: 80, min: 1 }), (sold, tooMany) => {
        const facts = [item(0, sold)];
        const line = {
          position: 0,
          restockedQuantity: 0,
          returnedQuantity: sold + tooMany,
        };
        expect(() => planSaleReturn(facts, [line])).toThrow(
          SaleReturnExceedsAvailableError
        );
        expect(facts.map((fact) => fact.returnedSoFar)).toEqual([0]);
        expect(
          planSaleReturn(facts, [{ ...line, returnedQuantity: sold }])[0]
            ?.availableBefore
        ).toBe(sold);
      }),
      { numRuns: 200 }
    );
  });

  it("returning everything in any split uses each unit exactly once", () => {
    fcAssert(
      property(
        integer({ max: 40, min: 1 }),
        array(integer({ max: 40, min: 1 }), { maxLength: 8, minLength: 1 }),
        (sold, chunks) => {
          let returned = 0;
          for (const chunk of chunks) {
            const facts = [item(0, sold, returned)];
            const line = {
              position: 0,
              restockedQuantity: chunk,
              returnedQuantity: chunk,
            };
            if (returned + chunk <= sold) {
              const [planned] = planSaleReturn(facts, [line]);
              expect(planned?.availableBefore).toBe(sold - returned);
              returned += chunk;
            } else {
              expect(() => planSaleReturn(facts, [line])).toThrow(
                SaleReturnExceedsAvailableError
              );
            }
          }
          expect(returned).toBeLessThanOrEqual(sold);
        }
      ),
      { numRuns: 300 }
    );
  });
});
