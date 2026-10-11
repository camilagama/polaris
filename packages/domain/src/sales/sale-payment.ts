import { Money } from "../money/money";
import type { CardInstallmentPlan } from "./payment-profile";

export const SALE_PAYMENT_METHODS = [
  "pix",
  "cash",
  "credit_card",
  "debit_card",
  "bank_transfer",
  "other",
] as const;

export type SalePaymentMethod = (typeof SALE_PAYMENT_METHODS)[number];

const maxPostgresInteger = 2_147_483_647;
const salePaymentMethodSet: ReadonlySet<string> = new Set(SALE_PAYMENT_METHODS);

export interface SalePaymentInput {
  anticipationRequested?: boolean;
  installmentPlan?: CardInstallmentPlan | null;
  installments?: number | null;
  method: SalePaymentMethod;
}

export interface SalePaymentSnapshot {
  readonly anticipationRequested: boolean;
  readonly amount: string;
  readonly installmentPlanUnknown: false;
  readonly installmentPlan: CardInstallmentPlan | null;
  readonly installments: number | null;
  readonly method: SalePaymentMethod;
}

export class InvalidSalePaymentError extends Error {
  readonly code = "invalid_sale_payment";

  constructor() {
    super("invalid_sale_payment");
    this.name = "InvalidSalePaymentError";
  }
}

function normalizeDueAmount(totalDue: string): Money {
  const amount = Money.from(totalDue);
  if (amount.minorUnits < 0n) {
    throw new InvalidSalePaymentError();
  }
  return amount;
}

function isSalePaymentMethod(value: unknown): value is SalePaymentMethod {
  return typeof value === "string" && salePaymentMethodSet.has(value);
}

function normalizeInstallments(
  method: SalePaymentMethod,
  value: number | null | undefined
): number | null {
  if (method !== "credit_card") {
    if (value !== undefined && value !== null) {
      throw new InvalidSalePaymentError();
    }
    return null;
  }

  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > maxPostgresInteger
  ) {
    throw new InvalidSalePaymentError();
  }
  return value;
}

function normalizeInstallmentPlan(
  method: SalePaymentMethod,
  value: CardInstallmentPlan | null | undefined
): CardInstallmentPlan | null {
  if (method !== "credit_card") {
    if (value !== undefined && value !== null) {
      throw new InvalidSalePaymentError();
    }
    return null;
  }
  if (value !== "merchant" && value !== "issuer") {
    throw new InvalidSalePaymentError();
  }
  return value;
}

/** Snapshots the sale's full amount; this records the method, not settlement evidence. */
export function normalizeSalePayment(
  input: SalePaymentInput,
  totalDue: string
): SalePaymentSnapshot {
  if (
    !input ||
    typeof input !== "object" ||
    !isSalePaymentMethod(input.method)
  ) {
    throw new InvalidSalePaymentError();
  }

  const amount = normalizeDueAmount(totalDue);
  const installments = normalizeInstallments(input.method, input.installments);
  const installmentPlan = normalizeInstallmentPlan(
    input.method,
    input.installmentPlan
  );
  const anticipationRequested = input.anticipationRequested ?? false;
  if (
    typeof anticipationRequested !== "boolean" ||
    (input.method !== "credit_card" && anticipationRequested)
  ) {
    throw new InvalidSalePaymentError();
  }
  return {
    anticipationRequested,
    amount: amount.toString(),
    installmentPlanUnknown: false,
    installmentPlan,
    installments,
    method: input.method,
  };
}
