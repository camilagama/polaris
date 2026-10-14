import { MAX_INVENTORY_QUANTITY } from "../inventory/inventory";

export const MONEY_SCALE = 2;
export const PERCENTAGE_SCALE = 6;
export const MAX_MONEY_INTEGER_DIGITS = 18;
export const MAX_DECIMAL_AMOUNT_SCALE = MONEY_SCALE + PERCENTAGE_SCALE + 2;

const moneyFactor = 10n ** BigInt(MONEY_SCALE);
const percentageFactor = 10n ** BigInt(PERCENTAGE_SCALE);
const maxMoneyMinorUnits =
  10n ** BigInt(MAX_MONEY_INTEGER_DIGITS + MONEY_SCALE) - 1n;
const decimalPattern = /^(-?)(\d+)(?:\.(\d+))?$/;
const leadingZeroPattern = /^0+(?=\d)$/;
const trailingZeroPattern = /0+$/;

export class InvalidMoneyError extends Error {
  readonly code = "invalid_money";

  constructor() {
    super("invalid_money");
    this.name = "InvalidMoneyError";
  }
}

export class MoneyLimitError extends Error {
  readonly code = "money_limit";

  constructor() {
    super("money_limit");
    this.name = "MoneyLimitError";
  }
}

export class InvalidDecimalAmountError extends Error {
  readonly code = "invalid_decimal_amount";

  constructor() {
    super("invalid_decimal_amount");
    this.name = "InvalidDecimalAmountError";
  }
}

export class DecimalAmountScaleError extends Error {
  readonly code = "decimal_amount_scale";

  constructor() {
    super("decimal_amount_scale");
    this.name = "DecimalAmountScaleError";
  }
}

export class InvalidPercentageError extends Error {
  readonly code = "invalid_percentage";

  constructor() {
    super("invalid_percentage");
    this.name = "InvalidPercentageError";
  }
}

export class InvalidFinancialQuantityError extends Error {
  readonly code = "invalid_financial_quantity";

  constructor() {
    super("invalid_financial_quantity");
    this.name = "InvalidFinancialQuantityError";
  }
}

interface ParsedDecimal {
  coefficient: bigint;
  fraction: string;
  negative: boolean;
  scale: number;
  whole: string;
}

function parseDecimal(
  value: string,
  maxScale: number,
  invalid: () => Error,
  invalidScale: () => Error,
  maxWholeDigits?: number,
  invalidWhole?: () => Error
): ParsedDecimal {
  if (typeof value !== "string") {
    throw invalid();
  }

  const match = decimalPattern.exec(value.trim());
  if (!match) {
    throw invalid();
  }

  const whole = (match[2] ?? "0").replace(leadingZeroPattern, "");
  if (maxWholeDigits !== undefined && whole.length > maxWholeDigits) {
    throw invalidWhole?.() ?? invalid();
  }
  const fraction = match[3] ?? "";
  if (fraction.length > maxScale) {
    throw invalidScale();
  }

  const digits = whole + fraction;
  const absolute = BigInt(digits);
  const negative = match[1] === "-";
  return {
    coefficient: negative ? -absolute : absolute,
    fraction,
    negative,
    scale: fraction.length,
    whole,
  };
}

function powerOfTen(scale: number): bigint {
  return 10n ** BigInt(scale);
}

function formatFixed(value: bigint, scale: number): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const digits = absolute.toString().padStart(scale + 1, "0");
  const whole = scale === 0 ? digits : digits.slice(0, -scale);
  const fraction = scale === 0 ? "" : `.${digits.slice(-scale)}`;
  const sign = negative && absolute !== 0n ? "-" : "";
  return `${sign}${whole}${fraction}`;
}

function validateQuantity(quantity: number): bigint {
  if (
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > MAX_INVENTORY_QUANTITY
  ) {
    throw new InvalidFinancialQuantityError();
  }
  return BigInt(quantity);
}

/** Exact decimal amount for intermediate financial calculations. */
export class DecimalAmount {
  readonly coefficient: bigint;
  readonly scale: number;

  private constructor(coefficient: bigint, scale: number) {
    let normalizedCoefficient = coefficient;
    let normalizedScale = scale;
    while (normalizedScale > 0 && normalizedCoefficient % 10n === 0n) {
      normalizedCoefficient /= 10n;
      normalizedScale -= 1;
    }
    this.coefficient = normalizedCoefficient;
    this.scale = normalizedScale;
  }

  static from(value: string): DecimalAmount {
    const parsed = parseDecimal(
      value,
      MAX_DECIMAL_AMOUNT_SCALE,
      () => new InvalidDecimalAmountError(),
      () => new DecimalAmountScaleError()
    );
    return new DecimalAmount(parsed.coefficient, parsed.scale);
  }

  static fromScaled(coefficient: bigint, scale: number): DecimalAmount {
    if (
      !Number.isInteger(scale) ||
      scale < 0 ||
      scale > MAX_DECIMAL_AMOUNT_SCALE
    ) {
      throw new DecimalAmountScaleError();
    }
    return new DecimalAmount(coefficient, scale);
  }

  add(other: DecimalAmount): DecimalAmount {
    const commonScale = Math.max(this.scale, other.scale);
    const left = this.coefficient * powerOfTen(commonScale - this.scale);
    const right = other.coefficient * powerOfTen(commonScale - other.scale);
    return DecimalAmount.fromScaled(left + right, commonScale);
  }

  subtract(other: DecimalAmount): DecimalAmount {
    const commonScale = Math.max(this.scale, other.scale);
    const left = this.coefficient * powerOfTen(commonScale - this.scale);
    const right = other.coefficient * powerOfTen(commonScale - other.scale);
    return DecimalAmount.fromScaled(left - right, commonScale);
  }

  multiplyByQuantity(quantity: number): DecimalAmount {
    return DecimalAmount.fromScaled(
      this.coefficient * validateQuantity(quantity),
      this.scale
    );
  }

  /** Rounds half-up, sending exact ties away from zero. */
  roundToScale(scale: number): DecimalAmount {
    if (
      !Number.isInteger(scale) ||
      scale < 0 ||
      scale > MAX_DECIMAL_AMOUNT_SCALE
    ) {
      throw new DecimalAmountScaleError();
    }
    if (scale >= this.scale) {
      return this;
    }

    const divisor = powerOfTen(this.scale - scale);
    const absolute =
      this.coefficient < 0n ? -this.coefficient : this.coefficient;
    const quotient = absolute / divisor;
    const remainder = absolute % divisor;
    const rounded = remainder * 2n >= divisor ? quotient + 1n : quotient;
    const signed = this.coefficient < 0n ? -rounded : rounded;
    return DecimalAmount.fromScaled(signed, scale);
  }

  /** Explicit conversion point for a persisted two-place BRL value. */
  toMoneyHalfUp(): Money {
    const rounded = this.roundToScale(MONEY_SCALE);
    return Money.fromMinorUnits(
      rounded.coefficient * powerOfTen(MONEY_SCALE - rounded.scale)
    );
  }

  toString(): string {
    const negative = this.coefficient < 0n;
    const absolute = negative ? -this.coefficient : this.coefficient;
    const whole = absolute / powerOfTen(this.scale);
    const sign = negative && absolute !== 0n ? "-" : "";
    if (this.scale === 0) {
      return sign + whole.toString();
    }

    const fraction = (absolute % powerOfTen(this.scale))
      .toString()
      .padStart(this.scale, "0")
      .replace(trailingZeroPattern, "");
    return fraction.length === 0
      ? `${sign}${whole}`
      : `${sign}${whole}.${fraction}`;
  }
}

/** BRL amount stored internally as exact integer centavos. */
export class Money {
  readonly minorUnits: bigint;

  private constructor(minorUnits: bigint) {
    if (minorUnits > maxMoneyMinorUnits || minorUnits < -maxMoneyMinorUnits) {
      throw new MoneyLimitError();
    }
    this.minorUnits = minorUnits;
  }

  static from(value: string): Money {
    const parsed = parseDecimal(
      value,
      MONEY_SCALE,
      () => new InvalidMoneyError(),
      () => new InvalidMoneyError(),
      MAX_MONEY_INTEGER_DIGITS,
      () => new MoneyLimitError()
    );

    const fractional = BigInt(parsed.fraction.padEnd(MONEY_SCALE, "0") || "0");
    const whole = BigInt(parsed.whole) * moneyFactor;
    return Money.fromMinorUnits(
      parsed.negative ? -(whole + fractional) : whole + fractional
    );
  }

  static fromMinorUnits(minorUnits: bigint): Money {
    return new Money(minorUnits);
  }

  add(other: Money): Money {
    return Money.fromMinorUnits(this.minorUnits + other.minorUnits);
  }

  subtract(other: Money): Money {
    return Money.fromMinorUnits(this.minorUnits - other.minorUnits);
  }

  multiplyByQuantity(quantity: number): Money {
    return Money.fromMinorUnits(this.minorUnits * validateQuantity(quantity));
  }

  toDecimalAmount(): DecimalAmount {
    return DecimalAmount.fromScaled(this.minorUnits, MONEY_SCALE);
  }

  toString(): string {
    return formatFixed(this.minorUnits, MONEY_SCALE);
  }
}

/** Nonnegative rate expressed in percentage points; 2.5 means 2.5%. */
export class Percentage {
  readonly units: bigint;

  private constructor(units: bigint) {
    this.units = units;
  }

  static from(value: string): Percentage {
    const parsed = parseDecimal(
      value,
      PERCENTAGE_SCALE,
      () => new InvalidPercentageError(),
      () => new InvalidPercentageError()
    );
    if (parsed.negative) {
      throw new InvalidPercentageError();
    }
    return new Percentage(
      BigInt(parsed.whole) * percentageFactor +
        BigInt(parsed.fraction.padEnd(PERCENTAGE_SCALE, "0") || "0")
    );
  }

  applyTo(amount: Money): DecimalAmount {
    return DecimalAmount.fromScaled(
      amount.minorUnits * this.units,
      MONEY_SCALE + PERCENTAGE_SCALE + 2
    );
  }

  toString(): string {
    return formatFixed(this.units, PERCENTAGE_SCALE);
  }
}
