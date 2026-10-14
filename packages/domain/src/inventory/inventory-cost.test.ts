import { describe, expect, it } from "vitest";
import {
  calculateMovingAverageCost,
  InventoryCostUnavailableError,
  InventoryCostLimitError,
  InvalidUnitCostError,
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
    let seed = 0x5e_ed_20_26;
    const nextInt = (maximum: number) => {
      seed = (seed * 48_271) % 2_147_483_647;
      return seed % (maximum + 1);
    };

    for (let iteration = 0; iteration < 500; iteration += 1) {
      const currentQuantity = nextInt(5000);
      const receivedQuantity = nextInt(5000) + 1;
      const currentCost = BigInt(nextInt(20_000_000));
      const receiptCost = BigInt(nextInt(20_000_000));
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
      const resultingDenominator = BigInt(currentQuantity + receivedQuantity);
      const twiceTheRoundingError =
        (resultingCost * resultingDenominator - exactWeightedNumerator) * 2n;
      const roundingErrorMagnitude =
        twiceTheRoundingError < 0n
          ? -twiceTheRoundingError
          : twiceTheRoundingError;

      expect(roundingErrorMagnitude).toBeLessThanOrEqual(resultingDenominator);
      const lowerBound =
        currentQuantity === 0 || currentCost >= receiptCost
          ? receiptCost
          : currentCost;
      const upperBound =
        currentQuantity === 0 || currentCost <= receiptCost
          ? receiptCost
          : currentCost;
      expect(resultingCost).toBeGreaterThanOrEqual(lowerBound);
      expect(resultingCost).toBeLessThanOrEqual(upperBound);
    }
  });
});

describe("restockMovingAverageCost", () => {
  it("keeps the average when the restocked cost was unknown", () => {
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
