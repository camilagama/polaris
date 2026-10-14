import {
  InventoryQuantityLimitError,
  InvalidStockMovementError,
  MAX_INVENTORY_QUANTITY,
} from "./inventory";

export const INVENTORY_COST_SCALE = 6;
export const MAX_INVENTORY_COST_INTEGER_DIGITS = 18;

const inventoryCostScaleFactor = 1_000_000n;
const unitCostPattern = /^(\d+)(?:\.(\d{1,6}))?$/;
const leadingZeroPattern = /^0+(?=\d)/;

export class InvalidUnitCostError extends Error {
  readonly code = "invalid_unit_cost";

  constructor() {
    super("invalid_unit_cost");
    this.name = "InvalidUnitCostError";
  }
}

export class InventoryCostLimitError extends Error {
  readonly code = "inventory_cost_limit";

  constructor() {
    super("inventory_cost_limit");
    this.name = "InventoryCostLimitError";
  }
}

export class InventoryCostUnavailableError extends Error {
  readonly code = "inventory_cost_unavailable";

  constructor() {
    super("inventory_cost_unavailable");
    this.name = "InventoryCostUnavailableError";
  }
}

function scaledCost(value: string): bigint {
  const normalized = normalizeUnitCost(value);
  const [whole, fractional] = normalized.split(".");
  return (
    BigInt(whole ?? "0") * inventoryCostScaleFactor + BigInt(fractional ?? "0")
  );
}

function formatScaledCost(value: bigint): string {
  const whole = value / inventoryCostScaleFactor;
  const fractional = (value % inventoryCostScaleFactor)
    .toString()
    .padStart(INVENTORY_COST_SCALE, "0");
  return `${whole}.${fractional}`;
}

/** Normalizes a nonnegative BRL decimal string without IEEE-754 conversion. */
export function normalizeUnitCost(value: string): string {
  if (typeof value !== "string") {
    throw new InvalidUnitCostError();
  }
  const trimmed = value.trim();
  const match = unitCostPattern.exec(trimmed);
  if (!match) {
    throw new InvalidUnitCostError();
  }

  const whole = (match[1] ?? "0").replace(leadingZeroPattern, "");
  if (whole.length > MAX_INVENTORY_COST_INTEGER_DIGITS) {
    throw new InventoryCostLimitError();
  }
  const fractional = (match[2] ?? "").padEnd(INVENTORY_COST_SCALE, "0");
  return `${whole}.${fractional}`;
}

export interface CalculateMovingAverageCostInput {
  currentAverageCost: string | null;
  currentQuantity: number;
  receivedQuantity: number;
  unitCost: string;
}

/**
 * Recalculates the moving average for one accepted receipt. The exact weighted
 * numerator is kept as bigint micro-reais; the result is rounded half-up to
 * six decimal places after this receipt.
 */
export function calculateMovingAverageCost(
  input: CalculateMovingAverageCostInput
): string {
  const { currentAverageCost, currentQuantity, receivedQuantity } = input;
  const unitCostUnits = scaledCost(input.unitCost);

  if (
    !Number.isInteger(currentQuantity) ||
    currentQuantity < 0 ||
    currentQuantity > MAX_INVENTORY_QUANTITY ||
    !Number.isInteger(receivedQuantity) ||
    receivedQuantity < 1 ||
    receivedQuantity > MAX_INVENTORY_QUANTITY
  ) {
    throw new InvalidStockMovementError();
  }

  const resultingQuantity = currentQuantity + receivedQuantity;
  if (resultingQuantity > MAX_INVENTORY_QUANTITY) {
    throw new InventoryQuantityLimitError();
  }

  if (currentQuantity === 0) {
    return formatScaledCost(unitCostUnits);
  }
  if (currentAverageCost === null) {
    throw new InventoryCostUnavailableError();
  }

  const currentCostUnits = scaledCost(currentAverageCost);
  const weightedCostUnits =
    currentCostUnits * BigInt(currentQuantity) +
    unitCostUnits * BigInt(receivedQuantity);
  const denominator = BigInt(resultingQuantity);
  const quotient = weightedCostUnits / denominator;
  const remainder = weightedCostUnits % denominator;
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;

  return formatScaledCost(rounded);
}
