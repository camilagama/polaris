import {
  InventoryVariantNotFoundError,
  InventoryVersionConflictError,
  InvalidStockMovementError,
  isStockMovementType,
  projectInventoryCount,
  projectInventoryQuantity,
  StockCommandConflictError,
  validateStockMovementType,
  type StockMovementType,
} from "@polaris/domain/inventory/inventory";
import {
  InvalidInventoryCountInputError,
  normalizeInventoryCountInput,
  type InventoryCountCommandInput,
} from "@polaris/domain/inventory/inventory-count";
import {
  calculateMovingAverageCost as calculateMovingAverageCostDomain,
  normalizeUnitCost,
  restockMovingAverageCost,
} from "@polaris/domain/inventory/inventory-cost";
import {
  normalizeReceiveStockInput,
  type ReceiveStockCommandInput,
} from "@polaris/domain/inventory/receive-stock";
import {
  normalizeWriteOffStockInput,
  type WriteOffReasonCode,
  type WriteOffStockCommandInput,
} from "@polaris/domain/inventory/write-off-stock";
import { and, eq, sql } from "drizzle-orm";
import { recordTenantAuditEvent } from "./tenant-audit";
import { TenantAuthorizationError } from "./tenant-transaction";
import type {
  TenantRequestIdentity,
  TenantRequestTransaction,
} from "./tenant-transaction";
import { ProductDeletedError } from "@polaris/domain/catalog/product";
import { inventoryBalances, stockMovements } from "./schema/inventory";
import { productVariants, products } from "./schema/product";

export interface RecordStockMovementInput {
  movementType: Exclude<
    StockMovementType,
    "receipt" | "write_off" | "inventory_count" | "sale"
  >;
  quantityDelta: number;
  requestId?: string | null;
  variantId: string;
}

export interface ReceiveStockRepositoryInput extends ReceiveStockCommandInput {
  requestId?: string | null;
}

export interface WriteOffStockRepositoryInput
  extends WriteOffStockCommandInput {
  requestId?: string | null;
}

export interface InventoryCountRepositoryInput
  extends InventoryCountCommandInput {
  requestId?: string | null;
}

export interface InventoryBalance {
  movingAverageCost: string | null;
  quantity: number;
  variantId: string;
  version: number;
}

interface StockMovementWriteInput
  extends Omit<RecordStockMovementInput, "movementType" | "quantityDelta"> {
  movementType: StockMovementType;
  quantityDelta?: number;
  calculateMovingAverageCost?: (balance: {
    currentAverageCost: string | null;
    currentQuantity: number;
  }) => string | null;
  commandId?: string | null;
  commandIndex?: number;
  commandVersion?: number | null;
  captureMovingAverageCost?: boolean;
  occurredOn?: string | null;
  expectedVersion?: number | null;
  physicalQuantity?: number | null;
  reasonCode?: WriteOffReasonCode | null;
  reasonNote?: string | null;
  unitCost?: string | null;
  valuationUnitCost?: string | null;
}

const movementColumns = {
  commandId: stockMovements.commandId,
  commandIndex: stockMovements.commandIndex,
  commandVersion: stockMovements.commandVersion,
  createdAt: stockMovements.createdAt,
  expectedVersion: stockMovements.expectedVersion,
  id: stockMovements.id,
  movementType: stockMovements.movementType,
  organizationId: stockMovements.organizationId,
  occurredOn: stockMovements.occurredOn,
  physicalQuantity: stockMovements.physicalQuantity,
  productId: stockMovements.productId,
  quantityDelta: stockMovements.quantityDelta,
  reasonCode: stockMovements.reasonCode,
  reasonNote: stockMovements.reasonNote,
  unitCost: stockMovements.unitCost,
  valuationUnitCost: stockMovements.valuationUnitCost,
  variantId: stockMovements.variantId,
};

const balanceColumns = {
  movingAverageCost: inventoryBalances.movingAverageCost,
  quantity: inventoryBalances.quantity,
  variantId: inventoryBalances.variantId,
  version: inventoryBalances.version,
};

function requireInventoryCapability(identity: TenantRequestIdentity): void {
  if (identity.capability !== "inventory:adjust") {
    throw new TenantAuthorizationError("capability_denied");
  }
}

function requireInventoryReadCapability(identity: TenantRequestIdentity): void {
  if (
    identity.capability !== "inventory:read" &&
    identity.capability !== "inventory:adjust"
  ) {
    throw new TenantAuthorizationError("capability_denied");
  }
}

function validateCommandMetadata(input: StockMovementWriteInput): void {
  const commandId = input.commandId ?? null;
  const commandVersion = input.commandVersion ?? null;
  const commandIndex = input.commandIndex ?? 0;
  const occurredOn = input.occurredOn ?? null;
  const isInventoryCount = input.movementType === "inventory_count";
  if (
    !Number.isInteger(commandIndex) ||
    commandIndex < 0 ||
    (commandId !== null &&
      (!commandVersion || commandVersion < 1 || occurredOn === null)) ||
    (commandId === null && (commandVersion !== null || occurredOn !== null)) ||
    (isInventoryCount &&
      (commandId === null ||
        commandVersion === null ||
        occurredOn === null ||
        input.expectedVersion === undefined ||
        input.expectedVersion === null ||
        input.physicalQuantity === undefined ||
        input.physicalQuantity === null)) ||
    (!isInventoryCount &&
      (input.expectedVersion !== undefined ||
        input.physicalQuantity !== undefined))
  ) {
    throw new InvalidStockMovementError();
  }
}

function costValueMatches(
  existingCost: string | null,
  expectedCost: string | null
): boolean {
  return expectedCost === null
    ? existingCost === null
    : existingCost !== null && normalizeUnitCost(existingCost) === expectedCost;
}

function commandCostPayloadMatches(
  existing: typeof stockMovements.$inferSelect,
  input: StockMovementWriteInput
): boolean {
  const expectedSnapshotCost =
    input.movementType === "inventory_count"
      ? (input.valuationUnitCost ?? null)
      : (input.unitCost ?? null);
  const snapshotMatches =
    input.captureMovingAverageCost ||
    costValueMatches(existing.unitCost, expectedSnapshotCost);
  const valuationInputMatches =
    input.movementType !== "inventory_count" ||
    costValueMatches(
      existing.valuationUnitCost,
      input.valuationUnitCost ?? null
    );

  return snapshotMatches && valuationInputMatches;
}

function commandQuantityPayloadMatches(
  existing: typeof stockMovements.$inferSelect,
  input: StockMovementWriteInput
): boolean {
  if (input.movementType !== "inventory_count") {
    return existing.quantityDelta === (input.quantityDelta ?? null);
  }
  return (
    existing.physicalQuantity === (input.physicalQuantity ?? null) &&
    existing.expectedVersion === (input.expectedVersion ?? null)
  );
}

function commandPayloadMatches(
  existing: typeof stockMovements.$inferSelect,
  input: StockMovementWriteInput,
  productId: string,
  variantId: string
): boolean {
  return (
    existing.commandVersion === (input.commandVersion ?? null) &&
    existing.commandIndex === (input.commandIndex ?? 0) &&
    existing.movementType === input.movementType &&
    existing.productId === productId &&
    commandQuantityPayloadMatches(existing, input) &&
    existing.occurredOn === (input.occurredOn ?? null) &&
    existing.reasonCode === (input.reasonCode ?? null) &&
    existing.reasonNote === (input.reasonNote ?? null) &&
    existing.variantId === variantId &&
    commandCostPayloadMatches(existing, input)
  );
}

async function readExistingCommand(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: StockMovementWriteInput,
  productId: string,
  variantId: string
) {
  const { commandId } = input;
  if (!commandId) {
    return null;
  }

  const [movement] = await transaction
    .select(movementColumns)
    .from(stockMovements)
    .where(
      and(
        eq(stockMovements.organizationId, identity.organizationId),
        eq(stockMovements.commandId, commandId),
        eq(stockMovements.commandIndex, input.commandIndex ?? 0)
      )
    )
    .limit(1);
  if (!movement) {
    return null;
  }
  if (!commandPayloadMatches(movement, input, productId, variantId)) {
    throw new StockCommandConflictError();
  }

  const [balance] = await transaction
    .select(balanceColumns)
    .from(inventoryBalances)
    .where(
      and(
        eq(inventoryBalances.organizationId, identity.organizationId),
        eq(inventoryBalances.variantId, variantId)
      )
    )
    .limit(1);
  if (!balance) {
    throw new Error("inventory_balance_missing_for_command_replay");
  }

  return { balance, movement, replayed: true as const };
}

async function lockVariantProduct(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  variantId: string
) {
  const [variantReference] = await transaction
    .select({ productId: productVariants.productId })
    .from(productVariants)
    .where(
      and(
        eq(productVariants.id, variantId),
        eq(productVariants.organizationId, identity.organizationId)
      )
    )
    .limit(1);
  if (!variantReference) {
    throw new InventoryVariantNotFoundError();
  }

  const [product] = await transaction
    .select({ deletedAt: products.deletedAt, id: products.id })
    .from(products)
    .where(
      and(
        eq(products.id, variantReference.productId),
        eq(products.organizationId, identity.organizationId)
      )
    )
    .for("update")
    .limit(1);
  if (!product) {
    throw new InventoryVariantNotFoundError();
  }

  const [variant] = await transaction
    .select({ id: productVariants.id })
    .from(productVariants)
    .where(
      and(
        eq(productVariants.id, variantId),
        eq(productVariants.organizationId, identity.organizationId),
        eq(productVariants.productId, product.id)
      )
    )
    .limit(1);
  if (!variant) {
    throw new InventoryVariantNotFoundError();
  }

  return {
    deletedAt: product.deletedAt,
    productId: product.id,
    variantId: variant.id,
  };
}

async function insertStockMovement(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: StockMovementWriteInput & { quantityDelta: number },
  productId: string,
  variantId: string,
  unitCost: string | null
) {
  const [movement] = await transaction
    .insert(stockMovements)
    .values({
      commandId: input.commandId ?? null,
      commandIndex: input.commandIndex ?? 0,
      commandVersion: input.commandVersion ?? null,
      movementType: input.movementType,
      occurredOn: input.occurredOn ?? null,
      expectedVersion: input.expectedVersion ?? null,
      organizationId: identity.organizationId,
      physicalQuantity: input.physicalQuantity ?? null,
      productId,
      quantityDelta: input.quantityDelta,
      reasonCode: input.reasonCode ?? null,
      reasonNote: input.reasonNote ?? null,
      unitCost,
      valuationUnitCost: input.valuationUnitCost ?? null,
      variantId,
    })
    .onConflictDoNothing({
      target: [
        stockMovements.organizationId,
        stockMovements.commandId,
        stockMovements.commandIndex,
      ],
    })
    .returning(movementColumns);
  if (movement) {
    return { kind: "inserted" as const, movement };
  }

  if (input.commandId) {
    const replay = await readExistingCommand(
      transaction,
      identity,
      input,
      productId,
      variantId
    );
    if (replay) {
      return { kind: "replay" as const, result: replay };
    }
  }

  throw new Error("stock_movement_insert_failed");
}

async function writeInventoryBalance(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: {
    existingBalance: { movingAverageCost: string | null } | undefined;
    movingAverageCost: string | null;
    productId: string;
    quantity: number;
    variantId: string;
  }
): Promise<InventoryBalance> {
  if (input.existingBalance) {
    const values = {
      quantity: input.quantity,
      updatedAt: new Date(),
      version: sql`${inventoryBalances.version} + 1`,
    };
    const updateValues =
      input.movingAverageCost === input.existingBalance.movingAverageCost
        ? values
        : { ...values, movingAverageCost: input.movingAverageCost };
    const [updated] = await transaction
      .update(inventoryBalances)
      .set(updateValues)
      .where(
        and(
          eq(inventoryBalances.organizationId, identity.organizationId),
          eq(inventoryBalances.variantId, input.variantId)
        )
      )
      .returning(balanceColumns);
    if (!updated) {
      throw new Error("inventory_balance_update_failed");
    }
    return updated;
  }

  const [created] = await transaction
    .insert(inventoryBalances)
    .values({
      movingAverageCost: input.movingAverageCost,
      organizationId: identity.organizationId,
      productId: input.productId,
      quantity: input.quantity,
      variantId: input.variantId,
    })
    .returning(balanceColumns);
  if (!created) {
    throw new Error("inventory_balance_insert_failed");
  }
  return created;
}

interface InventoryBalanceSnapshot {
  movingAverageCost: string | null;
  quantity: number;
  version: number;
}

function validateStockMovementWriteInput(input: StockMovementWriteInput): void {
  if (!isStockMovementType(input.movementType)) {
    throw new InvalidStockMovementError();
  }
  if (input.movementType === "inventory_count") {
    if (input.quantityDelta !== undefined) {
      throw new InvalidStockMovementError();
    }
  } else {
    if (
      input.quantityDelta === undefined ||
      input.valuationUnitCost !== undefined
    ) {
      throw new InvalidStockMovementError();
    }
    validateStockMovementType(input.movementType, input.quantityDelta);
  }
  validateCommandMetadata(input);
}

function projectStockMovement(
  input: StockMovementWriteInput,
  balance: InventoryBalanceSnapshot | undefined
): { quantity: number; quantityDelta: number } {
  const currentQuantity = balance?.quantity ?? 0;
  if (input.movementType === "inventory_count") {
    if ((balance?.version ?? 0) !== input.expectedVersion) {
      throw new InventoryVersionConflictError();
    }
    if (
      input.physicalQuantity === undefined ||
      input.physicalQuantity === null
    ) {
      throw new InvalidStockMovementError();
    }
    return projectInventoryCount(currentQuantity, input.physicalQuantity);
  }
  if (input.quantityDelta === undefined) {
    throw new InvalidStockMovementError();
  }
  return {
    quantity: projectInventoryQuantity(currentQuantity, input.quantityDelta),
    quantityDelta: input.quantityDelta,
  };
}

function projectMovingAverageCost(
  input: StockMovementWriteInput,
  balance: InventoryBalanceSnapshot | undefined
): string | null {
  const currentAverageCost = balance?.movingAverageCost ?? null;
  let movingAverageCost =
    input.calculateMovingAverageCost?.({
      currentAverageCost,
      currentQuantity: balance?.quantity ?? 0,
    }) ?? currentAverageCost;

  if (
    input.valuationUnitCost !== undefined &&
    input.valuationUnitCost !== null
  ) {
    if (
      input.movementType !== "inventory_count" ||
      currentAverageCost !== null ||
      input.physicalQuantity === 0
    ) {
      throw new InvalidInventoryCountInputError();
    }
    movingAverageCost = normalizeUnitCost(input.valuationUnitCost);
  }

  return movingAverageCost;
}

function movementUnitCost(
  input: StockMovementWriteInput,
  balance: InventoryBalanceSnapshot | undefined
): string | null {
  if (input.unitCost !== undefined && input.unitCost !== null) {
    return normalizeUnitCost(input.unitCost);
  }
  if (
    input.valuationUnitCost !== undefined &&
    input.valuationUnitCost !== null
  ) {
    return normalizeUnitCost(input.valuationUnitCost);
  }
  if (
    input.captureMovingAverageCost &&
    balance?.movingAverageCost !== undefined &&
    balance.movingAverageCost !== null
  ) {
    return normalizeUnitCost(balance.movingAverageCost);
  }
  return null;
}

function requireSaleCapability(identity: TenantRequestIdentity): void {
  if (identity.capability !== "sale:create") {
    throw new TenantAuthorizationError("capability_denied");
  }
}

// Every movement is authorized here. Inventory commands keep the default
// inventory:adjust check; only the sale transaction supplies the sale check.
async function applyStockMovement(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: StockMovementWriteInput,
  authorize: (
    identity: TenantRequestIdentity
  ) => void = requireInventoryCapability
) {
  authorize(identity);
  validateStockMovementWriteInput(input);

  const variant = await lockVariantProduct(
    transaction,
    identity,
    input.variantId
  );
  const existingCommand = await readExistingCommand(
    transaction,
    identity,
    input,
    variant.productId,
    variant.variantId
  );
  if (existingCommand) {
    return existingCommand;
  }
  if (variant.deletedAt) {
    throw new ProductDeletedError();
  }

  const [balance] = await transaction
    .select({
      movingAverageCost: inventoryBalances.movingAverageCost,
      quantity: inventoryBalances.quantity,
      version: inventoryBalances.version,
    })
    .from(inventoryBalances)
    .where(
      and(
        eq(inventoryBalances.organizationId, identity.organizationId),
        eq(inventoryBalances.variantId, variant.variantId)
      )
    )
    .for("update")
    .limit(1);

  const { quantity, quantityDelta } = projectStockMovement(input, balance);
  const movingAverageCost = projectMovingAverageCost(input, balance);
  const unitCost = movementUnitCost(input, balance);

  const resolvedInput = { ...input, quantityDelta };

  const inserted = await insertStockMovement(
    transaction,
    identity,
    resolvedInput,
    variant.productId,
    variant.variantId,
    unitCost
  );
  if (inserted.kind === "replay") {
    return inserted.result;
  }

  const updatedBalance = await writeInventoryBalance(transaction, identity, {
    existingBalance: balance,
    movingAverageCost,
    productId: variant.productId,
    quantity,
    variantId: variant.variantId,
  });
  await recordTenantAuditEvent(transaction, identity, {
    entityId: inserted.movement.id,
    entityType: "stock_movement",
    eventType: "inventory.movement_recorded",
    requestId: input.requestId ?? null,
  });

  return {
    balance: updatedBalance,
    movement: inserted.movement,
    replayed: false as const,
  };
}
/**
 * Internal ledger primitive for later named inventory commands. Public API
 * commands should use their named repository function, such as receiveStock.
 */
export async function recordStockMovement(
  outerTransaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: RecordStockMovementInput
) {
  requireInventoryCapability(identity);
  const movementType: string = input.movementType;
  if (
    !isStockMovementType(movementType) ||
    movementType === "receipt" ||
    movementType === "write_off" ||
    movementType === "inventory_count" ||
    movementType === "sale"
  ) {
    throw new InvalidStockMovementError();
  }
  validateStockMovementType(input.movementType, input.quantityDelta);

  return await outerTransaction.transaction((transaction) =>
    applyStockMovement(transaction, identity, input)
  );
}

export async function receiveStock(
  outerTransaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  rawInput: ReceiveStockRepositoryInput
) {
  requireInventoryCapability(identity);
  const input = normalizeReceiveStockInput(rawInput);

  return await outerTransaction.transaction((transaction) =>
    applyStockMovement(transaction, identity, {
      calculateMovingAverageCost: (balance) =>
        calculateMovingAverageCostDomain({
          currentAverageCost: balance.currentAverageCost,
          currentQuantity: balance.currentQuantity,
          receivedQuantity: input.quantity,
          unitCost: input.unitCost,
        }),
      commandId: input.commandId,
      commandIndex: 0,
      commandVersion: input.commandVersion,
      movementType: "receipt",
      occurredOn: input.occurredOn,
      quantityDelta: input.quantity,
      requestId: rawInput.requestId ?? null,
      unitCost: input.unitCost,
      variantId: input.variantId,
    })
  );
}

export async function writeOffStock(
  outerTransaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  rawInput: WriteOffStockRepositoryInput
) {
  requireInventoryCapability(identity);
  const input = normalizeWriteOffStockInput(rawInput);

  return await outerTransaction.transaction((transaction) =>
    applyStockMovement(transaction, identity, {
      captureMovingAverageCost: true,
      commandId: input.commandId,
      commandIndex: 0,
      commandVersion: input.commandVersion,
      movementType: "write_off",
      occurredOn: input.occurredOn,
      quantityDelta: -input.quantity,
      reasonCode: input.reasonCode,
      reasonNote: input.reasonNote,
      requestId: rawInput.requestId ?? null,
      variantId: input.variantId,
    })
  );
}

export async function inventoryCount(
  outerTransaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  rawInput: InventoryCountRepositoryInput
) {
  requireInventoryCapability(identity);
  const input = normalizeInventoryCountInput(rawInput);

  return await outerTransaction.transaction((transaction) =>
    applyStockMovement(transaction, identity, {
      captureMovingAverageCost: input.valuationUnitCost === null,
      commandId: input.commandId,
      commandIndex: 0,
      commandVersion: input.commandVersion,
      expectedVersion: input.expectedVersion,
      movementType: "inventory_count",
      occurredOn: input.occurredOn,
      physicalQuantity: input.physicalQuantity,
      requestId: rawInput.requestId ?? null,
      valuationUnitCost: input.valuationUnitCost,
      variantId: input.variantId,
    })
  );
}

export interface SaleStockMovementInput {
  commandId: string;
  commandIndex: number;
  occurredOn: string;
  quantity: number;
  requestId?: string | null;
  variantId: string;
}

/**
 * Ledger primitive used only by the sale transaction. It runs inside the
 * caller's transaction (no savepoint), captures the moving-average cost under
 * the balance lock and fails with InsufficientStockError instead of letting the
 * balance go negative. The sale command ID and the item position identify the
 * movement, so a replayed sale cannot write it twice.
 */
export async function recordSaleStockMovement(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: SaleStockMovementInput
) {
  return await applyStockMovement(
    transaction,
    identity,
    {
      captureMovingAverageCost: true,
      commandId: input.commandId,
      commandIndex: input.commandIndex,
      commandVersion: 1,
      movementType: "sale",
      occurredOn: input.occurredOn,
      quantityDelta: -input.quantity,
      requestId: input.requestId ?? null,
      variantId: input.variantId,
    },
    requireSaleCapability
  );
}

export interface SaleRestockMovementInput {
  commandId: string;
  commandIndex: number;
  movementType: "sale_cancellation" | "sale_return";
  occurredOn: string;
  quantity: number;
  requestId?: string | null;
  /** Cost snapshot of the original sale item; null when it was unknown. */
  unitCost: string | null;
  variantId: string;
}

const restockCapability = {
  sale_cancellation: "sale:cancel",
  sale_return: "sale:return",
} as const;

/**
 * Ledger primitive for the compensatory movements of a confirmed sale
 * (cancellation or return): units come back at the cost snapshot of the
 * original item and the moving average follows the restock rule. It runs in
 * the caller's transaction and never touches the original sale movements.
 */
export async function recordSaleRestockMovement(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: SaleRestockMovementInput
) {
  return await applyStockMovement(
    transaction,
    identity,
    {
      calculateMovingAverageCost: (balance) =>
        restockMovingAverageCost({
          currentAverageCost: balance.currentAverageCost,
          currentQuantity: balance.currentQuantity,
          restockedQuantity: input.quantity,
          restockedUnitCost: input.unitCost,
        }),
      commandId: input.commandId,
      commandIndex: input.commandIndex,
      commandVersion: 1,
      movementType: input.movementType,
      occurredOn: input.occurredOn,
      quantityDelta: input.quantity,
      requestId: input.requestId ?? null,
      unitCost: input.unitCost,
      variantId: input.variantId,
    },
    (restockIdentity) => {
      if (
        restockIdentity.capability !== restockCapability[input.movementType]
      ) {
        throw new TenantAuthorizationError("capability_denied");
      }
    }
  );
}

/**
 * A variant with no movements has no materialized balance row and reads as
 * quantity zero, with no moving cost and an initial projection version of 0.
 */
export async function getInventoryBalance(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  variantId: string
): Promise<InventoryBalance> {
  requireInventoryReadCapability(identity);
  const [variant] = await transaction
    .select({ id: productVariants.id })
    .from(productVariants)
    .where(
      and(
        eq(productVariants.id, variantId),
        eq(productVariants.organizationId, identity.organizationId)
      )
    )
    .limit(1);
  if (!variant) {
    throw new InventoryVariantNotFoundError();
  }

  const [balance] = await transaction
    .select(balanceColumns)
    .from(inventoryBalances)
    .where(
      and(
        eq(inventoryBalances.organizationId, identity.organizationId),
        eq(inventoryBalances.variantId, variant.id)
      )
    )
    .limit(1);

  return (
    balance ?? {
      movingAverageCost: null,
      quantity: 0,
      variantId: variant.id,
      version: 0,
    }
  );
}
