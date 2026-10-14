import { ProductDeletedError } from "@polaris/domain/catalog/product";
import {
  InvalidStockMovementError,
  InventoryOccurredInFutureError,
  InventoryVariantNotFoundError,
  InventoryVersionConflictError,
  isStockMovementType,
  projectInventoryCount,
  projectInventoryQuantity,
  StockCommandConflictError,
  type StockMovementType,
  validateStockMovementType,
} from "@polaris/domain/inventory/inventory";
import {
  calculateMovingAverageCost as calculateMovingAverageCostDomain,
  normalizeUnitCost,
  restockMovingAverageCost,
} from "@polaris/domain/inventory/inventory-cost";
import {
  InvalidInventoryCountInputError,
  type InventoryCountCommandInput,
  normalizeInventoryCountInput,
} from "@polaris/domain/inventory/inventory-count";
import {
  normalizeReceiveStockInput,
  type ReceiveStockCommandInput,
} from "@polaris/domain/inventory/receive-stock";
import {
  normalizeWriteOffStockInput,
  type WriteOffReasonCode,
  type WriteOffStockCommandInput,
} from "@polaris/domain/inventory/write-off-stock";
import { calendarDateInTimeZone } from "@polaris/domain/sales/confirm-sale";
import { and, asc, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import { inventoryBalances, stockMovements } from "./schema/inventory";
import { organizations } from "./schema/organization";
import { products, productVariants } from "./schema/product";
import {
  productOptions,
  productOptionValues,
  variantOptionValues,
} from "./schema/product-variants";
import { recordTenantAuditEvent } from "./tenant-audit";
import {
  TenantAuthorizationError,
  type TenantRequestIdentity,
  type TenantRequestTransaction,
} from "./tenant-transaction";
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
  calculateMovingAverageCost?: (balance: {
    currentAverageCost: string | null;
    currentQuantity: number;
  }) => string | null;
  captureMovingAverageCost?: boolean;
  commandId?: string | null;
  commandIndex?: number;
  commandVersion?: number | null;
  expectedVersion?: number | null;
  movementType: StockMovementType;
  occurredOn?: string | null;
  physicalQuantity?: number | null;
  quantityDelta?: number;
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
  occurredOn: stockMovements.occurredOn,
  organizationId: stockMovements.organizationId,
  physicalQuantity: stockMovements.physicalQuantity,
  productId: stockMovements.productId,
  quantityDelta: stockMovements.quantityDelta,
  reasonCode: stockMovements.reasonCode,
  reasonNote: stockMovements.reasonNote,
  unitCost: stockMovements.unitCost,
  valuationUnitCost: stockMovements.valuationUnitCost,
  variantId: stockMovements.variantId,
  variantSequence: stockMovements.variantSequence,
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
      expectedVersion: input.expectedVersion ?? null,
      movementType: input.movementType,
      occurredOn: input.occurredOn ?? null,
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
  // A calculator may legitimately answer null (average unknown), so only a
  // missing calculator keeps the current average.
  let movingAverageCost = input.calculateMovingAverageCost
    ? input.calculateMovingAverageCost({
        currentAverageCost,
        currentQuantity: balance?.quantity ?? 0,
      })
    : currentAverageCost;

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

// Operator-dated movements (receipt, write-off, count) cannot be dated after the
// organization's today. Replays were answered before this check, and sale
// movements have their own commercial-date rules.
async function assertOperatorDateNotInFuture(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: StockMovementWriteInput
) {
  const operatorDated =
    input.movementType === "receipt" ||
    input.movementType === "write_off" ||
    input.movementType === "inventory_count";
  if (!(operatorDated && input.occurredOn)) {
    return;
  }
  const [organization] = await transaction
    .select({ timezone: organizations.timezone })
    .from(organizations)
    .where(eq(organizations.id, identity.organizationId))
    .limit(1);
  if (!organization) {
    throw new TenantAuthorizationError("tenant_access_denied");
  }
  if (
    input.occurredOn > calendarDateInTimeZone(new Date(), organization.timezone)
  ) {
    throw new InventoryOccurredInFutureError();
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
  await assertOperatorDateNotInFuture(transaction, identity, input);

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

/* -------------------------------------------------------------------------- */
/* Balance listing                                                            */
/* -------------------------------------------------------------------------- */

export const MAX_INVENTORY_BALANCE_LIST_LIMIT = 100;

export type InventoryStockFilter = "all" | "with_stock" | "without_stock";
type InventoryVariantOptionName = "color" | "model" | "size";

export interface ListInventoryBalancesOptions {
  cursor?: string | null;
  /** Archived products stay listed (their stock may still need a write-off). */
  includeArchived?: boolean;
  limit?: number;
  query?: string | null;
  stock?: InventoryStockFilter;
  variantIds?: readonly string[] | undefined;
}

export interface InventoryBalanceEntry {
  isDefaultVariant: boolean;
  movingAverageCost: string | null;
  productId: string;
  productName: string;
  productStatus: "active" | "archived";
  quantity: number;
  sku: string | null;
  updatedAt: Date | null;
  values: Array<{
    optionName: InventoryVariantOptionName;
    optionValueName: string;
  }>;
  variantId: string;
  version: number;
}

export class InvalidInventoryBalanceCursorError extends Error {
  readonly code = "invalid_inventory_balance_cursor";

  constructor(options?: ErrorOptions) {
    super("invalid_inventory_balance_cursor", options);
    this.name = "InvalidInventoryBalanceCursorError";
  }
}

interface InventoryBalanceCursor {
  name: string;
  position: number;
  productId: string;
  variantId: string;
}

const cursorUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const base64PlusPattern = /\+/g;
const base64SlashPattern = /\//g;
const base64PaddingPattern = /[=]+$/;
const base64UrlDashPattern = /-/g;
const base64UrlUnderscorePattern = /_/g;
const likeSpecialCharactersPattern = /[\\%_]/g;

/** Opaque keyset cursor: name, product, position and variant of the last row. */
export function encodeInventoryBalanceCursor(
  cursor: InventoryBalanceCursor
): string {
  const bytes = new TextEncoder().encode(
    JSON.stringify([
      cursor.name,
      cursor.productId,
      cursor.position,
      cursor.variantId,
    ])
  );
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(base64PlusPattern, "-")
    .replace(base64SlashPattern, "_")
    .replace(base64PaddingPattern, "");
}

export function decodeInventoryBalanceCursor(
  text: string
): InventoryBalanceCursor {
  let parsed: unknown;
  try {
    const base64 = text
      .replace(base64UrlDashPattern, "+")
      .replace(base64UrlUnderscorePattern, "/");
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0)
    );
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: InvalidInventoryBalanceCursorError forwards this cause to Error.
    throw new InvalidInventoryBalanceCursorError({ cause: error });
  }
  if (!(Array.isArray(parsed) && parsed.length === 4)) {
    throw new InvalidInventoryBalanceCursorError();
  }
  const [name, productId, position, variantId] = parsed as unknown[];
  if (
    typeof name !== "string" ||
    typeof productId !== "string" ||
    typeof variantId !== "string" ||
    !cursorUuidPattern.test(productId) ||
    !cursorUuidPattern.test(variantId) ||
    typeof position !== "number" ||
    !Number.isInteger(position) ||
    position < 0 ||
    position > 2_147_483_647
  ) {
    throw new InvalidInventoryBalanceCursorError();
  }
  return { name, position, productId, variantId };
}

function isVariantOptionName(
  value: string
): value is InventoryVariantOptionName {
  return value === "model" || value === "color" || value === "size";
}

function likePattern(text: string): string {
  return `%${text.replace(likeSpecialCharactersPattern, "\\$&")}%`;
}

/**
 * Every variant of the organization's non-deleted products with its balance,
 * ordered by product name, then variant position. A variant without a
 * materialized balance row reads as quantity zero and version 0. One query for
 * the page and one for the option values of exactly that page.
 */
export async function listInventoryBalances(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  options: ListInventoryBalancesOptions = {}
): Promise<{ entries: InventoryBalanceEntry[]; nextCursor: string | null }> {
  requireInventoryReadCapability(identity);
  const limit = Math.min(
    Math.max(Math.trunc(options.limit ?? 50), 1),
    MAX_INVENTORY_BALANCE_LIST_LIMIT
  );
  const lowerName = sql`lower(${products.name})`;
  const position = sql`coalesce(${productVariants.position}, 0)`;
  const quantity = sql`coalesce(${inventoryBalances.quantity}, 0)`;

  const conditions: SQL[] = [
    eq(productVariants.organizationId, identity.organizationId),
    isNull(products.deletedAt),
  ];
  if (!options.includeArchived) {
    conditions.push(isNull(products.archivedAt));
  }
  if (options.variantIds && options.variantIds.length > 0) {
    conditions.push(inArray(productVariants.id, [...options.variantIds]));
  }
  if (options.stock === "with_stock") {
    conditions.push(sql`${quantity} > 0`);
  } else if (options.stock === "without_stock") {
    conditions.push(sql`${quantity} = 0`);
  }
  const queryText = options.query?.trim();
  if (queryText) {
    const pattern = likePattern(queryText);
    conditions.push(
      sql`(
        ${products.name} ILIKE ${pattern}
        OR ${productVariants.sku} ILIKE ${pattern}
        OR EXISTS (
          SELECT 1
          FROM ${variantOptionValues}
          INNER JOIN ${productOptionValues}
            ON ${productOptionValues.id} = ${variantOptionValues.optionValueId}
           AND ${productOptionValues.organizationId} = ${variantOptionValues.organizationId}
          WHERE ${variantOptionValues.variantId} = ${productVariants.id}
            AND ${variantOptionValues.organizationId} = ${productVariants.organizationId}
            AND ${productOptionValues.name} ILIKE ${pattern}
        )
      )`
    );
  }
  if (options.cursor) {
    const cursor = decodeInventoryBalanceCursor(options.cursor);
    conditions.push(
      sql`(${lowerName}, ${products.id}, ${position}, ${productVariants.id}) > (${cursor.name}::text, ${cursor.productId}::uuid, ${cursor.position}::integer, ${cursor.variantId}::uuid)`
    );
  }

  const page = await transaction
    .select({
      archivedAt: products.archivedAt,
      isDefault: productVariants.isDefault,
      movingAverageCost: inventoryBalances.movingAverageCost,
      position: sql<number>`${position}`.mapWith(Number),
      productId: products.id,
      productName: products.name,
      quantity: inventoryBalances.quantity,
      sku: productVariants.sku,
      sortName: sql<string>`${lowerName}`,
      updatedAt: inventoryBalances.updatedAt,
      variantId: productVariants.id,
      version: inventoryBalances.version,
    })
    .from(productVariants)
    .innerJoin(
      products,
      and(
        eq(products.organizationId, productVariants.organizationId),
        eq(products.id, productVariants.productId)
      )
    )
    .leftJoin(
      inventoryBalances,
      and(
        eq(inventoryBalances.organizationId, productVariants.organizationId),
        eq(inventoryBalances.variantId, productVariants.id)
      )
    )
    .where(and(...conditions))
    .orderBy(lowerName, products.id, position, productVariants.id)
    .limit(limit + 1);

  const hasMore = page.length > limit;
  const rows = page.slice(0, limit);
  if (rows.length === 0) {
    return { entries: [], nextCursor: null };
  }

  const optionRows = await transaction
    .select({
      optionName: productOptions.name,
      optionPosition: productOptions.position,
      optionValueName: productOptionValues.name,
      variantId: variantOptionValues.variantId,
    })
    .from(variantOptionValues)
    .innerJoin(
      productOptions,
      and(
        eq(productOptions.organizationId, variantOptionValues.organizationId),
        eq(productOptions.id, variantOptionValues.optionId)
      )
    )
    .innerJoin(
      productOptionValues,
      and(
        eq(
          productOptionValues.organizationId,
          variantOptionValues.organizationId
        ),
        eq(productOptionValues.id, variantOptionValues.optionValueId)
      )
    )
    .where(
      and(
        eq(variantOptionValues.organizationId, identity.organizationId),
        inArray(
          variantOptionValues.variantId,
          rows.map((row) => row.variantId)
        )
      )
    )
    .orderBy(asc(productOptions.position));
  const valuesByVariant = new Map<string, InventoryBalanceEntry["values"]>();
  for (const optionRow of optionRows) {
    if (!isVariantOptionName(optionRow.optionName)) {
      throw new Error("inventory_balance_option_integrity_failed");
    }
    const values = valuesByVariant.get(optionRow.variantId) ?? [];
    values.push({
      optionName: optionRow.optionName,
      optionValueName: optionRow.optionValueName,
    });
    valuesByVariant.set(optionRow.variantId, values);
  }

  const lastRow = rows.at(-1);
  return {
    entries: rows.map((row) => ({
      isDefaultVariant: row.isDefault,
      movingAverageCost:
        row.movingAverageCost === null
          ? null
          : normalizeUnitCost(row.movingAverageCost),
      productId: row.productId,
      productName: row.productName,
      productStatus: row.archivedAt === null ? "active" : "archived",
      quantity: row.quantity ?? 0,
      sku: row.sku,
      updatedAt: row.updatedAt,
      values: valuesByVariant.get(row.variantId) ?? [],
      variantId: row.variantId,
      version: row.version ?? 0,
    })),
    nextCursor:
      hasMore && lastRow
        ? encodeInventoryBalanceCursor({
            name: lastRow.sortName,
            position: lastRow.position,
            productId: lastRow.productId,
            variantId: lastRow.variantId,
          })
        : null,
  };
}
