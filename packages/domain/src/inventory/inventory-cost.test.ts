import { integer, property } from "fast-check";
import { assertProperty } from "../testing/property";
import { describe, expect, it } from "vitest";
import {
  calculateMovingAverageCost,
  InvalidUnitCostError,
  InventoryCostLimitError,
  InventoryCostUnavailableError,
  normalizeUnitCost,
  restockMovingAverageCost,
} from "./inventory-cost";

const costScale = 1_000_000n;

function costFromScaled(value: bigint): string {
  const whole = value / costScale;
  const fractional = (value % costScale).toString().padStart(6, "0");
  return `${whole}.${fractional}`;
}

function scaledCost(value: string): bigint {
  const [whole, fractional] = value.split(".");
  return BigInt(whole ?? "0") * costScale + BigInt(fractional ?? "0");
}

describe("inventory cost rules", () => {
  it("normalizes exact nonnegative unit costs to six decimal places", () => {
    expect(normalizeUnitCost(" 0012.34 ")).toBe("12.340000");
    expect(normalizeUnitCost("0")).toBe("0.000000");
  });

  it("rejects negative, locale-formatted, exponential, and over-scale costs", () => {
    for (const value of ["-1", "1,25", "1e2", "1.1234567", ""]) {
      expect(() => normalizeUnitCost(value)).toThrow(InvalidUnitCostError);
    }
  });

  it("caps the integer part at eighteen digits without rounding input", () => {
    expect(normalizeUnitCost("999999999999999999.999999")).toBe(
      "999999999999999999.999999"
    );
    expect(() => normalizeUnitCost("1000000000000000000")).toThrow(
      InventoryCostLimitError
    );
  });

  it("weights existing stock and received stock by their quantities", () => {
    expect(
      calculateMovingAverageCost({
        currentAverageCost: "10.000000",
        currentQuantity: 5,
        receivedQuantity: 3,
        unitCost: "14.000000",
      })
    ).toBe("11.500000");
  });

  it("uses the new receipt cost when inventory was empty", () => {
    expect(
      calculateMovingAverageCost({
        currentAverageCost: null,
        currentQuantity: 0,
        receivedQuantity: 3,
        unitCost: "12.34",
      })
    ).toBe("12.340000");
  });

  it("rounds exact half-micro-unit ties away from zero", () => {
    expect(
      calculateMovingAverageCost({
        currentAverageCost: "0.000000",
        currentQuantity: 1,
        receivedQuantity: 1,
        unitCost: "0.000001",
      })
    ).toBe("0.000001");
  });

  it("does not treat unvalued positive stock as free stock", () => {
    expect(() =>
      calculateMovingAverageCost({
        currentAverageCost: null,
        currentQuantity: 2,
        receivedQuantity: 1,
        unitCost: "5.00",
      })
    ).toThrow(InventoryCostUnavailableError);
  });

  it("preserves the weighted-average property over generated exact-decimal cases", () => {
    assertProperty(
      property(
        integer({ max: 5000, min: 0 }),
        integer({ max: 5000, min: 1 }),
        integer({ max: 20_000_000, min: 0 }),
        integer({ max: 20_000_000, min: 0 }),
        (currentQuantity, receivedQuantity, currentScaled, receiptScaled) => {
          const currentCost = BigInt(currentScaled);
          const receiptCost = BigInt(receiptScaled);
          const average = calculateMovingAverageCost({
            currentAverageCost:
              currentQuantity === 0 ? null : costFromScaled(currentCost),
            currentQuantity,
            receivedQuantity,
            unitCost: costFromScaled(receiptCost),
          });
          const resultingCost = scaledCost(average);
          const exactWeightedNumerator =
            currentCost * BigInt(currentQuantity) +
            receiptCost * BigInt(receivedQuantity);
          const resultingDenominator = BigInt(
            currentQuantity + receivedQuantity
          );
          const twiceTheRoundingError =
            (resultingCost * resultingDenominator - exactWeightedNumerator) *
            2n;
          const roundingErrorMagnitude =
            twiceTheRoundingError < 0n
              ? -twiceTheRoundingError
              : twiceTheRoundingError;
          const lowerBound =
            currentQuantity === 0 || currentCost >= receiptCost
              ? receiptCost
              : currentCost;
          const upperBound =
            currentQuantity === 0 || currentCost <= receiptCost
              ? receiptCost
              : currentCost;

          expect(roundingErrorMagnitude <= resultingDenominator).toBe(true);
          expect(resultingCost >= lowerBound).toBe(true);
          expect(resultingCost <= upperBound).toBe(true);
        }
      )
    );
  });

  it("is a no-op for the cost when the received cost equals the current average (property)", () => {
    assertProperty(
      property(
        integer({ max: 5000, min: 1 }),
        integer({ max: 5000, min: 1 }),
        integer({ max: 20_000_000, min: 0 }),
        (currentQuantity, receivedQuantity, scaled) => {
          const cost = costFromScaled(BigInt(scaled));
          expect(
            calculateMovingAverageCost({
              currentAverageCost: cost,
              currentQuantity,
              receivedQuantity,
              unitCost: cost,
            })
          ).toBe(cost);
        }
      )
    );
  });
});

describe("restockMovingAverageCost", () => {
  it("keeps the average of a positive balance when the restocked cost was unknown", () => {
    expect(
      restockMovingAverageCost({
        currentAverageCost: "10.000000",
        currentQuantity: 4,
        restockedQuantity: 2,
        restockedUnitCost: null,
      })
    ).toBe("10.000000");
    expect(
      restockMovingAverageCost({
        currentAverageCost: null,
        currentQuantity: 0,
        restockedQuantity: 2,
        restockedUnitCost: null,
      })
    ).toBeNull();
  });

  it("does not revive a stale average on an empty balance when the restocked cost was unknown", () => {
    expect(
      restockMovingAverageCost({
        currentAverageCost: "12.500000",
        currentQuantity: 0,
        restockedQuantity: 3,
        restockedUnitCost: null,
      })
    ).toBeNull();
  });

  it("takes the snapshot cost when the balance is empty", () => {
    expect(
      restockMovingAverageCost({
        currentAverageCost: "99.000000",
        currentQuantity: 0,
        restockedQuantity: 3,
        restockedUnitCost: "7.5",
      })
    ).toBe("7.500000");
    expect(
      restockMovingAverageCost({
        currentAverageCost: null,
        currentQuantity: 0,
        restockedQuantity: 3,
        restockedUnitCost: "7.5",
      })
    ).toBe("7.500000");
  });

  it("recomputes the weighted average exactly like a receipt", () => {
    expect(
      restockMovingAverageCost({
        currentAverageCost: "12.000000",
        currentQuantity: 2,
        restockedQuantity: 2,
        restockedUnitCost: "10.000000",
      })
    ).toBe("11.000000");
    expect(
      restockMovingAverageCost({
        currentAverageCost: "1.000000",
        currentQuantity: 2,
        restockedQuantity: 1,
        restockedUnitCost: "1.000001",
      })
    ).toBe("1.000000");
  });

  it("leaves an unknown average unknown instead of blocking or guessing", () => {
    expect(
      restockMovingAverageCost({
        currentAverageCost: null,
        currentQuantity: 5,
        restockedQuantity: 2,
        restockedUnitCost: "10.000000",
      })
    ).toBeNull();
  });
});
