import {
  DecimalAmountScaleError,
  InvalidFinancialQuantityError,
  InvalidMoneyError,
  InvalidPercentageError,
  Money,
  MoneyLimitError,
  Percentage,
} from "../money/money";

export type SaleAdjustmentKind =
  | "discount"
  | "surcharge"
  | "freight"
  | "payment_surcharge";

export type SaleAdjustmentValue =
  | { amount: string; type: "fixed" }
  | { percentage: string; type: "percentage" };

export interface SaleAdjustmentInput {
  kind: SaleAdjustmentKind;
  value: SaleAdjustmentValue;
}

export interface SaleAdjustmentCalculationInput {
  adjustments: readonly SaleAdjustmentInput[];
  items: readonly { chargedUnitPrice: string; quantity: number }[];
}

export interface NormalizedSaleAdjustment {
  amount: string;
  kind: SaleAdjustmentKind;
  percentage: string | null;
  position: number;
  valueType: "fixed" | "percentage";
}

export interface SaleAdjustmentCalculation {
  adjustments: readonly NormalizedSaleAdjustment[];
  discountTotal: string;
  freightTotal: string;
  paymentSurchargeTotal: string;
  subtotal: string;
  surchargeTotal: string;
  totalDue: string;
}

export class InvalidSaleAdjustmentError extends Error {
  readonly code = "invalid_sale_adjustment";

  constructor() {
    super("invalid_sale_adjustment");
    this.name = "InvalidSaleAdjustmentError";
  }
}

export class SaleDiscountExceedsSubtotalError extends Error {
  readonly code = "sale_discount_exceeds_subtotal";

  constructor() {
    super("sale_discount_exceeds_subtotal");
    this.name = "SaleDiscountExceedsSubtotalError";
  }
}

export class SaleAdjustmentLimitError extends Error {
  readonly code = "sale_adjustment_limit";

  constructor() {
    super("sale_adjustment_limit");
    this.name = "SaleAdjustmentLimitError";
  }
}

function normalizeAmount(value: string): Money {
  const amount = Money.from(value);
  if (amount.minorUnits < 0n) {
    throw new InvalidSaleAdjustmentError();
  }
  return amount;
}

function translateCalculationError(error: unknown): never {
  if (
    error instanceof InvalidMoneyError ||
    error instanceof InvalidPercentageError ||
    error instanceof InvalidFinancialQuantityError ||
    error instanceof DecimalAmountScaleError
  ) {
    throw new InvalidSaleAdjustmentError();
  }
  if (error instanceof MoneyLimitError) {
    throw new SaleAdjustmentLimitError();
  }
  throw error;
}

function assertAdjustmentKind(
  value: unknown
): asserts value is SaleAdjustmentKind {
  if (
    value !== "discount" &&
    value !== "surcharge" &&
    value !== "freight" &&
    value !== "payment_surcharge"
  ) {
    throw new InvalidSaleAdjustmentError();
  }
}

function zeroMoney(): Money {
  return Money.fromMinorUnits(0n);
}

interface CalculatedSaleAdjustment {
  amount: Money;
  normalized: NormalizedSaleAdjustment;
}

interface SaleAdjustmentTotals {
  discount: Money;
  freight: Money;
  paymentSurcharge: Money;
  surcharge: Money;
}

function assertCalculationInput(input: SaleAdjustmentCalculationInput): void {
  if (!input) {
    throw new InvalidSaleAdjustmentError();
  }
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new InvalidSaleAdjustmentError();
  }
  if (!Array.isArray(input.adjustments)) {
    throw new InvalidSaleAdjustmentError();
  }
}

function calculateSubtotal(
  items: SaleAdjustmentCalculationInput["items"]
): Money {
  let subtotal = zeroMoney();
  for (const itemValue of items as readonly unknown[]) {
    if (typeof itemValue !== "object" || itemValue === null) {
      throw new InvalidSaleAdjustmentError();
    }
    const item = itemValue as Record<string, unknown>;
    if (
      typeof item.chargedUnitPrice !== "string" ||
      typeof item.quantity !== "number"
    ) {
      throw new InvalidSaleAdjustmentError();
    }
    const lineTotal = normalizeAmount(item.chargedUnitPrice).multiplyByQuantity(
      item.quantity
    );
    subtotal = subtotal.add(lineTotal);
  }
  return subtotal;
}

function calculateOneAdjustment(
  adjustment: SaleAdjustmentInput,
  position: number,
  subtotal: Money
): CalculatedSaleAdjustment {
  if (!adjustment || typeof adjustment !== "object") {
    throw new InvalidSaleAdjustmentError();
  }
  assertAdjustmentKind(adjustment.kind);
  const value: unknown = adjustment.value;
  if (typeof value !== "object" || value === null) {
    throw new InvalidSaleAdjustmentError();
  }
  const valueRecord = value as Record<string, unknown>;

  if (valueRecord.type === "fixed") {
    if (typeof valueRecord.amount !== "string") {
      throw new InvalidSaleAdjustmentError();
    }
    const amount = normalizeAmount(valueRecord.amount);
    return {
      amount,
      normalized: {
        amount: amount.toString(),
        kind: adjustment.kind,
        percentage: null,
        position,
        valueType: "fixed",
      },
    };
  }

  if (
    valueRecord.type !== "percentage" ||
    (adjustment.kind !== "discount" && adjustment.kind !== "surcharge") ||
    typeof valueRecord.percentage !== "string"
  ) {
    throw new InvalidSaleAdjustmentError();
  }

  const rate = Percentage.from(valueRecord.percentage);
  const amount = rate.applyTo(subtotal).toMoneyHalfUp();
  return {
    amount,
    normalized: {
      amount: amount.toString(),
      kind: adjustment.kind,
      percentage: rate.toString(),
      position,
      valueType: "percentage",
    },
  };
}

function sumAdjustments(
  adjustments: readonly CalculatedSaleAdjustment[]
): SaleAdjustmentTotals {
  const totals: SaleAdjustmentTotals = {
    discount: zeroMoney(),
    freight: zeroMoney(),
    paymentSurcharge: zeroMoney(),
    surcharge: zeroMoney(),
  };

  for (const adjustment of adjustments) {
    switch (adjustment.normalized.kind) {
      case "discount":
        totals.discount = totals.discount.add(adjustment.amount);
        break;
      case "surcharge":
        totals.surcharge = totals.surcharge.add(adjustment.amount);
        break;
      case "freight":
        totals.freight = totals.freight.add(adjustment.amount);
        break;
      case "payment_surcharge":
        totals.paymentSurcharge = totals.paymentSurcharge.add(
          adjustment.amount
        );
        break;
      default:
        throw new InvalidSaleAdjustmentError();
    }
  }

  return totals;
}

function calculateTotalDue(
  subtotal: Money,
  totals: SaleAdjustmentTotals
): Money {
  if (totals.discount.minorUnits > subtotal.minorUnits) {
    throw new SaleDiscountExceedsSubtotalError();
  }

  return subtotal
    .subtract(totals.discount)
    .add(totals.surcharge)
    .add(totals.freight)
    .add(totals.paymentSurcharge);
}

/** Calculates sale-level adjustments without applying a percentage to prior adjustments. */
export function calculateSaleAdjustments(
  input: SaleAdjustmentCalculationInput
): SaleAdjustmentCalculation {
  try {
    assertCalculationInput(input);
    const subtotal = calculateSubtotal(input.items);
    const calculated = input.adjustments.map((adjustment, position) =>
      calculateOneAdjustment(adjustment, position, subtotal)
    );
    const totals = sumAdjustments(calculated);
    const totalDue = calculateTotalDue(subtotal, totals);

    return {
      adjustments: calculated.map(({ normalized }) => normalized),
      discountTotal: totals.discount.toString(),
      freightTotal: totals.freight.toString(),
      paymentSurchargeTotal: totals.paymentSurcharge.toString(),
      subtotal: subtotal.toString(),
      surchargeTotal: totals.surcharge.toString(),
      totalDue: totalDue.toString(),
    };
  } catch (error) {
    if (
      error instanceof InvalidSaleAdjustmentError ||
      error instanceof SaleDiscountExceedsSubtotalError ||
      error instanceof SaleAdjustmentLimitError
    ) {
      throw error;
    }
    translateCalculationError(error);
  }
}
