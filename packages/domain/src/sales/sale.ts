import { MAX_INVENTORY_QUANTITY } from "../inventory/inventory";
import { normalizeUnitCost } from "../inventory/inventory-cost";

export const SALE_MONEY_SCALE = 2;
export const MAX_SALE_MONEY_INTEGER_DIGITS = 18;

export interface SaleItemSnapshotInput {
  readonly chargedUnitPrice: string;
  readonly listedUnitPrice: string;
  readonly productId: string;
  readonly productLabel: string;
  readonly quantity: number;
  readonly unitCost: string | null;
  readonly variantId: string;
}

export interface SaleItemSnapshot {
  readonly chargedUnitPrice: string;
  readonly listedUnitPrice: string;
  readonly position: number;
  readonly productId: string;
  readonly productLabel: string;
  readonly quantity: number;
  readonly unitCost: string | null;
  readonly variantId: string;
}

export interface ConfirmedSaleSnapshotInput {
  items: readonly SaleItemSnapshotInput[];
}

export interface ConfirmedSaleSnapshot {
  readonly currency: "BRL";
  readonly items: readonly SaleItemSnapshot[];
}

export class InvalidSaleSnapshotError extends Error {
  readonly code = "invalid_sale_snapshot";

  constructor() {
    super("invalid_sale_snapshot");
    this.name = "InvalidSaleSnapshotError";
  }
}

const brlAmountPattern = /^(\d+)(?:\.(\d{1,2}))?$/;
const leadingZeroPattern = /^0+(?=\d)/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeBrlAmount(value: string): string {
  if (typeof value !== "string") {
    throw new InvalidSaleSnapshotError();
  }
  const match = brlAmountPattern.exec(value.trim());
  if (!match) {
    throw new InvalidSaleSnapshotError();
  }

  const whole = (match[1] ?? "0").replace(leadingZeroPattern, "");
  if (whole.length > MAX_SALE_MONEY_INTEGER_DIGITS) {
    throw new InvalidSaleSnapshotError();
  }

  const fractional = (match[2] ?? "").padEnd(SALE_MONEY_SCALE, "0");
  return `${whole}.${fractional}`;
}

function normalizeCostSnapshot(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  return normalizeUnitCost(value);
}

function normalizeSaleItemSnapshot(
  input: SaleItemSnapshotInput,
  position: number
): SaleItemSnapshot {
  if (
    !(
      uuidPattern.test(input.productId) &&
      uuidPattern.test(input.variantId) &&
      Number.isInteger(input.quantity)
    ) ||
    input.quantity < 1 ||
    input.quantity > MAX_INVENTORY_QUANTITY
  ) {
    throw new InvalidSaleSnapshotError();
  }

  const productLabel = input.productLabel.trim();
  if (!productLabel) {
    throw new InvalidSaleSnapshotError();
  }

  return {
    chargedUnitPrice: normalizeBrlAmount(input.chargedUnitPrice),
    listedUnitPrice: normalizeBrlAmount(input.listedUnitPrice),
    position,
    productId: input.productId,
    productLabel,
    quantity: input.quantity,
    unitCost: normalizeCostSnapshot(input.unitCost),
    variantId: input.variantId,
  };
}

/** Validates the immutable, confirmed sale snapshot without doing calculations. */
export function normalizeConfirmedSaleSnapshot(
  input: ConfirmedSaleSnapshotInput
): ConfirmedSaleSnapshot {
  if (input.items.length === 0) {
    throw new InvalidSaleSnapshotError();
  }

  return {
    currency: "BRL",
    items: input.items.map((item, position) =>
      normalizeSaleItemSnapshot(item, position)
    ),
  };
}
