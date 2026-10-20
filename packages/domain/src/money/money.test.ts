import { bigInt, integer, property, tuple } from "fast-check";
import { assertProperty } from "../testing/property";
import { describe, expect, it } from "vitest";
import {
  DecimalAmount,
  DecimalAmountScaleError,
  InvalidFinancialQuantityError,
  InvalidMoneyError,
  InvalidPercentageError,
  Money,
  MoneyLimitError,
  Percentage,
} from "./money";

const PROPERTY_MAX_CENTS = 1_000_000_000_000_000_000n;

function decimalFromUnits(units: bigint, scale: number): string {
  const sign = units < 0n ? "-" : "";
  const absolute = units < 0n ? -units : units;
  const digits = absolute.toString().padStart(scale + 1, "0");
  const whole = scale === 0 ? digits : digits.slice(0, -scale);
  const fraction = scale === 0 ? "" : `.${digits.slice(-scale)}`;
  return `${sign}${whole}${fraction}`;
}

function roundedHalfUpUnits(units: bigint, placesToRemove: number): bigint {
  const divisor = 10n ** BigInt(placesToRemove);
  const absolute = units < 0n ? -units : units;
  const quotient = absolute / divisor;
  const remainder = absolute % divisor;
  const rounded = remainder * 2n >= divisor ? quotient + 1n : quotient;
  return units < 0n ? -rounded : rounded;
}

describe("decimal text limits", () => {
  it("strips any number of leading zeros before the 18-digit check", () => {
    expect(Money.from("000000000000000000001.00").toString()).toBe("1.00");
    expect(Money.from("0000000000000000000000000000.5").toString()).toBe(
      "0.50"
    );
    expect(Percentage.from("0000000000000000000000002.5").toString()).toBe(
      "2.500000"
    );
    expect(() => Money.from("1000000000000000000")).toThrow(MoneyLimitError);
  });

  it("refuses absurdly long decimal text before any BigInt work", () => {
    const huge = `${"9".repeat(40)}${"0".repeat(40)}`;
    expect(() => Money.from(huge)).toThrow(InvalidMoneyError);
    expect(() => Percentage.from(huge)).toThrow(InvalidPercentageError);
  });
});

describe("Percentage.fromRate", () => {
  it("accepts 0 through 100 percentage points and refuses anything above", () => {
    expect(Percentage.fromRate("0").toString()).toBe("0.000000");
    expect(Percentage.fromRate("2.5").toString()).toBe("2.500000");
    expect(Percentage.fromRate("100").toString()).toBe("100.000000");
    expect(() => Percentage.fromRate("100.000001")).toThrow(
      InvalidPercentageError
    );
    expect(() => Percentage.fromRate("250")).toThrow(InvalidPercentageError);
    expect(() => Percentage.fromRate("99999999999999999999")).toThrow(
      InvalidPercentageError
    );
    expect(() => Percentage.fromRate("-1")).toThrow(InvalidPercentageError);
  });

  it("agrees with Percentage.from for every rate up to 100 (property)", () => {
    assertProperty(
      property(integer({ max: 100_000_000, min: 0 }), (units) => {
        const text = decimalFromUnits(BigInt(units), 6);
        expect(Percentage.fromRate(text).toString()).toBe(
          Percentage.from(text).toString()
        );
      })
    );
  });
});
describe("Money", () => {
  it("normalizes BRL to cents and rejects excess scale or integer range", () => {
    expect(Money.from("0001.2").toString()).toBe("1.20");
    expect(Money.from("-0.5").toString()).toBe("-0.50");
    expect(Money.from("999999999999999999.99").toString()).toBe(
      "999999999999999999.99"
    );
    expect(() => Money.from("1.001")).toThrow(InvalidMoneyError);
    expect(() => Money.from("1000000000000000000")).toThrow(MoneyLimitError);
    expect(() =>
      Money.from("999999999999999999.99").add(Money.from("0.01"))
    ).toThrow(MoneyLimitError);
  });

  it("adds exact cents for all generated signed values", async () => {
    await assertProperty(
      property(
        bigInt({ max: PROPERTY_MAX_CENTS, min: -PROPERTY_MAX_CENTS }),
        bigInt({ max: PROPERTY_MAX_CENTS, min: -PROPERTY_MAX_CENTS }),
        (leftCents, rightCents) => {
          const result = Money.fromMinorUnits(leftCents).add(
            Money.fromMinorUnits(rightCents)
          );
          expect(result.minorUnits).toBe(leftCents + rightCents);
        }
      )
    );
  });

  it("subtracts a discount without floating-point conversion", async () => {
    await assertProperty(
      property(
        tuple(
          bigInt({ max: PROPERTY_MAX_CENTS, min: 0n }),
          bigInt({ max: PROPERTY_MAX_CENTS, min: 0n })
        ).map(([grossCents, candidateDiscount]) => ({
          discountCents: candidateDiscount % (grossCents + 1n),
          grossCents,
        })),
        ({ grossCents, discountCents }) => {
          const total = Money.fromMinorUnits(grossCents);
          const discount = Money.fromMinorUnits(discountCents);
          expect(total.subtract(discount).minorUnits).toBe(
            grossCents - discountCents
          );
        }
      )
    );
  });

  it("multiplies exact cents by an integer quantity", async () => {
    await assertProperty(
      property(
        bigInt({ max: 1_000_000_000_000_000n, min: -1_000_000_000_000_000n }),
        integer({ max: 1000, min: 1 }),
        (minorUnits, quantity) => {
          expect(
            Money.fromMinorUnits(minorUnits).multiplyByQuantity(quantity)
              .minorUnits
          ).toBe(minorUnits * BigInt(quantity));
        }
      )
    );
  });

  it("rejects invalid quantities before multiplying money", () => {
    const amount = Money.from("1.00");
    expect(() => amount.multiplyByQuantity(0)).toThrow(
      InvalidFinancialQuantityError
    );
    expect(() => amount.multiplyByQuantity(2_147_483_648)).toThrow(
      InvalidFinancialQuantityError
    );
    expect(() => amount.multiplyByQuantity(Number.NaN)).toThrow(
      InvalidFinancialQuantityError
    );
  });
});

describe("DecimalAmount", () => {
  it("adds mixed-scale intermediate decimals exactly", async () => {
    await assertProperty(
      property(
        bigInt({ max: 1_000_000n, min: -1_000_000n }),
        bigInt({ max: 1_000_000_000n, min: -1_000_000_000n }),
        (milliUnits, microUnits) => {
          const left = DecimalAmount.from(decimalFromUnits(milliUnits, 3));
          const right = DecimalAmount.from(decimalFromUnits(microUnits, 6));
          const expected = DecimalAmount.from(
            decimalFromUnits(milliUnits * 1_000n + microUnits, 6)
          );
          expect(left.add(right).toString()).toBe(expected.toString());
        }
      )
    );
  });

  it("subtracts mixed-scale intermediate decimals exactly", async () => {
    await assertProperty(
      property(
        bigInt({ max: 1_000_000n, min: -1_000_000n }),
        bigInt({ max: 1_000_000_000n, min: -1_000_000_000n }),
        (milliUnits, microUnits) => {
          const left = DecimalAmount.from(decimalFromUnits(milliUnits, 3));
          const right = DecimalAmount.from(decimalFromUnits(microUnits, 6));
          const expected = DecimalAmount.from(
            decimalFromUnits(milliUnits * 1_000n - microUnits, 6)
          );
          expect(left.subtract(right).toString()).toBe(expected.toString());
        }
      )
    );
  });

  it("multiplies exact intermediate values by a positive quantity", async () => {
    await assertProperty(
      property(
        bigInt({ max: 1_000_000_000n, min: -1_000_000_000n }),
        integer({ max: 1000, min: 1 }),
        (microUnits, quantity) => {
          const exact = DecimalAmount.from(decimalFromUnits(microUnits, 6));
          const expected = DecimalAmount.from(
            decimalFromUnits(microUnits * BigInt(quantity), 6)
          );
          expect(exact.multiplyByQuantity(quantity).toString()).toBe(
            expected.toString()
          );
        }
      )
    );
  });

  it("converts to persisted BRL money with explicit half-up rounding", () => {
    expect(DecimalAmount.from("1.005").toMoneyHalfUp().toString()).toBe("1.01");
    expect(DecimalAmount.from("-1.005").toMoneyHalfUp().toString()).toBe(
      "-1.01"
    );
  });

  it("rounds positive and negative half-cent ties away from zero", () => {
    expect(DecimalAmount.from("1.005").roundToScale(2).toString()).toBe("1.01");
    expect(DecimalAmount.from("-1.005").roundToScale(2).toString()).toBe(
      "-1.01"
    );
  });

  it("rounds generated three-place values half-up to cents", async () => {
    await assertProperty(
      property(
        bigInt({ max: PROPERTY_MAX_CENTS, min: -PROPERTY_MAX_CENTS }),
        (milliUnits) => {
          const exact = DecimalAmount.from(decimalFromUnits(milliUnits, 3));
          const expectedCents = roundedHalfUpUnits(milliUnits, 1);
          const expected = DecimalAmount.from(
            decimalFromUnits(expectedCents, 2)
          );
          expect(exact.roundToScale(2).toString()).toBe(expected.toString());
        }
      )
    );
  });

  it("rejects an intermediate scale the project does not need", () => {
    expect(() => DecimalAmount.from("0.00000000001")).toThrow(
      DecimalAmountScaleError
    );
  });
});

describe("Percentage", () => {
  it("preserves six decimal places and rejects finer input", () => {
    expect(Percentage.from("2").toString()).toBe("2.000000");
    expect(Percentage.from("2.500001").toString()).toBe("2.500001");
    expect(() => Percentage.from("1.0000001")).toThrow(InvalidPercentageError);
    expect(() => Percentage.from("-1")).toThrow(InvalidPercentageError);
  });

  it("applies percentage points exactly before rounding", async () => {
    await assertProperty(
      property(
        bigInt({ max: 1_000_000_000_000n, min: -1_000_000_000_000n }),
        bigInt({ max: 1_000_000_000n, min: 0n }),
        (minorUnits, percentageUnits) => {
          const amount = Money.fromMinorUnits(minorUnits);
          const percentage = Percentage.from(
            decimalFromUnits(percentageUnits, 6)
          );
          const expected = DecimalAmount.from(
            decimalFromUnits(minorUnits * percentageUnits, 10)
          );
          expect(percentage.applyTo(amount).toString()).toBe(
            expected.toString()
          );
        }
      )
    );
  });
});
