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

export class StockCommandConflictError extends Error {
  readonly code = "stock_command_conflict";

  constructor() {
    super("stock_command_conflict");
    this.name = "StockCommandConflictError";
  }
}

export class InventoryVersionConflictError extends Error {
  readonly code = "inventory_version_conflict";

  constructor() {
    super("inventory_version_conflict");
    this.name = "InventoryVersionConflictError";
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
    !Number.isInteger(quantityDelta) ||
    (quantityDelta === 0 && movementType !== "inventory_count") ||
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
 * Projects an absolute physical count against the serialized current balance.
 * A zero delta is valid here because the count event itself remains auditable.
 */
export function projectInventoryCount(
  currentQuantity: number,
  physicalQuantity: number
): { quantity: number; quantityDelta: number } {
  if (
    !Number.isInteger(currentQuantity) ||
    currentQuantity < 0 ||
    currentQuantity > MAX_INVENTORY_QUANTITY ||
    !Number.isInteger(physicalQuantity) ||
    physicalQuantity < 0
  ) {
    throw new InvalidStockMovementError();
  }
  if (physicalQuantity > MAX_INVENTORY_QUANTITY) {
    throw new InventoryQuantityLimitError();
  }

  return {
    quantity: physicalQuantity,
    quantityDelta: physicalQuantity - currentQuantity,
  };
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
