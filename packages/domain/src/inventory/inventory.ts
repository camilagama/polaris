export const STOCK_MOVEMENT_TYPES = Object.freeze([
  "receipt",
  "write_off",
  "inventory_count",
  "sale",
  "sale_cancellation",
  "sale_return",
] as const);

export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];

export const MAX_INVENTORY_QUANTITY = 2_147_483_647;
const MIN_POSTGRES_INTEGER = -2_147_483_648;

export class InvalidStockMovementError extends Error {
  readonly code = "invalid_stock_movement";

  constructor() {
    super("invalid_stock_movement");
    this.name = "InvalidStockMovementError";
  }
}

export class InsufficientStockError extends Error {
  readonly code = "insufficient_stock";

  constructor() {
    super("insufficient_stock");
    this.name = "InsufficientStockError";
  }
}

export class InventoryQuantityLimitError extends Error {
  readonly code = "inventory_quantity_limit";

  constructor() {
    super("inventory_quantity_limit");
    this.name = "InventoryQuantityLimitError";
  }
}

export class InventoryVariantNotFoundError extends Error {
  readonly code = "inventory_variant_not_found";

  constructor() {
    super("inventory_variant_not_found");
    this.name = "InventoryVariantNotFoundError";
  }
}

export function isStockMovementType(value: string): value is StockMovementType {
  return STOCK_MOVEMENT_TYPES.some((movementType) => movementType === value);
}

export function validateStockMovementType(
  movementType: StockMovementType,
  quantityDelta: number
): void {
  if (
    (movementType === "receipt" && quantityDelta < 1) ||
    (movementType === "write_off" && quantityDelta > -1) ||
    (movementType === "sale" && quantityDelta > -1) ||
    (movementType === "sale_cancellation" && quantityDelta < 1) ||
    (movementType === "sale_return" && quantityDelta < 1)
  ) {
    throw new InvalidStockMovementError();
  }
}

/**
 * Projects the balance from a signed ledger delta. PostgreSQL integer is the
 * persisted quantity type, so the upper bound is the signed 32-bit maximum.
 */
export function projectInventoryQuantity(
  currentQuantity: number,
  quantityDelta: number
): number {
  if (
    !Number.isInteger(quantityDelta) ||
    quantityDelta === 0 ||
    quantityDelta < MIN_POSTGRES_INTEGER ||
    quantityDelta > MAX_INVENTORY_QUANTITY
  ) {
    throw new InvalidStockMovementError();
  }

  if (
    !Number.isInteger(currentQuantity) ||
    currentQuantity < 0 ||
    currentQuantity > MAX_INVENTORY_QUANTITY
  ) {
    throw new InvalidStockMovementError();
  }

  const nextQuantity = currentQuantity + quantityDelta;
  if (nextQuantity < 0) {
    throw new InsufficientStockError();
  }
  if (nextQuantity > MAX_INVENTORY_QUANTITY) {
    throw new InventoryQuantityLimitError();
  }

  return nextQuantity;
}
