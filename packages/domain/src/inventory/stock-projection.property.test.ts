import { array, integer, oneof, property, tuple } from "fast-check";
import { assertProperty } from "../testing/property";
import { describe, expect, it } from "vitest";
import {
  InsufficientStockError,
  InventoryQuantityLimitError,
  MAX_INVENTORY_QUANTITY,
  projectInventoryCount,
  projectInventoryQuantity,
} from "./inventory";

type Command =
  | { kind: "delta"; quantity: number }
  | { kind: "count"; physical: number };

const commandArbitrary = oneof(
  tuple(integer({ max: 500, min: -500 }).filter((n) => n !== 0)).map(
    ([quantity]) => ({ kind: "delta", quantity }) as Command
  ),
  tuple(integer({ max: 600, min: 0 })).map(
    ([physical]) => ({ kind: "count", physical }) as Command
  )
);

describe("stock projection (property)", () => {
  it("never goes negative and equals the sum of the accepted deltas", () => {
    assertProperty(
      property(array(commandArbitrary, { maxLength: 60 }), (commands) => {
        let balance = 0;
        let ledgerSum = 0;
        for (const command of commands) {
          // Oracle: a delta is refused exactly when it would take the balance
          // below zero; a count is always accepted and lands on the physical
          // quantity. A refused command leaves balance and ledger untouched.
          if (command.kind === "delta") {
            if (balance + command.quantity < 0) {
              expect(() =>
                projectInventoryQuantity(balance, command.quantity)
              ).toThrow(InsufficientStockError);
            } else {
              balance = projectInventoryQuantity(balance, command.quantity);
              ledgerSum += command.quantity;
            }
          } else {
            const projected = projectInventoryCount(balance, command.physical);
            expect(projected.quantity).toBe(command.physical);
            balance = projected.quantity;
            ledgerSum += projected.quantityDelta;
          }
          expect(balance).toBeGreaterThanOrEqual(0);
          expect(balance).toBe(ledgerSum);
        }
      })
    );
  });

  it("refuses to cross the quantity ceiling and the floor", () => {
    expect(() => projectInventoryQuantity(MAX_INVENTORY_QUANTITY, 1)).toThrow(
      InventoryQuantityLimitError
    );
    expect(() => projectInventoryQuantity(0, -1)).toThrow(
      InsufficientStockError
    );
  });
});
