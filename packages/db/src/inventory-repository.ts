import {
  InventoryVariantNotFoundError,
  InvalidStockMovementError,
  isStockMovementType,
  projectInventoryQuantity,
  StockCommandConflictError,
  validateStockMovementType,
  type StockMovementType,
} from "@polaris/domain/inventory/inventory";
import {
  calculateMovingAverageCost as calculateMovingAverageCostDomain,
  normalizeUnitCost,
} from "@polaris/domain/inventory/inventory-cost";
import {
  normalizeReceiveStockInput,
  type ReceiveStockCommandInput,
} from "@polaris/domain/inventory/receive-stock";
import { and, eq, sql } from "drizzle-orm";
import { recordTenantAuditEvent } from "./tenant-audit";
import { TenantAuthorizationError } from "./tenant-transaction";
import type {
  TenantRequestIdentity,
  TenantRequestTransaction,
} from "./tenant-transaction";
import { inventoryBalances, stockMovements } from "./schema/inventory";
import { productVariants, products } from "./schema/product";

export interface RecordStockMovementInput {
  movementType: Exclude<StockMovementType, "receipt">;
  quantityDelta: number;
  requestId?: string | null;
  variantId: string;
}

export interface ReceiveStockRepositoryInput extends ReceiveStockCommandInput {
  requestId?: string | null;
}

export interface InventoryBalance {
  movingAverageCost: string | null;
  quantity: number;
  variantId: string;
  version: number;
}

interface StockMovementWriteInput
  extends Omit<RecordStockMovementInput, "movementType"> {
  movementType: StockMovementType;
  calculateMovingAverageCost?: (balance: {
    currentAverageCost: string | null;
    currentQuantity: number;
  }) => string;
  commandId?: string | null;
  commandIndex?: number;
  commandVersion?: number | null;
  occurredOn?: string | null;
  unitCost?: string | null;
}

const movementColumns = {
  commandId: stockMovements.commandId,
  commandIndex: stockMovements.commandIndex,
  commandVersion: stockMovements.commandVersion,
  createdAt: stockMovements.createdAt,
  id: stockMovements.id,
  movementType: stockMovements.movementType,
  organizationId: stockMovements.organizationId,
  occurredOn: stockMovements.occurredOn,
  productId: stockMovements.productId,
  quantityDelta: stockMovements.quantityDelta,
  unitCost: stockMovements.unitCost,
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

function validateCommandMetadata(input: StockMovementWriteInput): void {
  const commandId = input.commandId ?? null;
  const commandVersion = input.commandVersion ?? null;
  const commandIndex = input.commandIndex ?? 0;
  const occurredOn = input.occurredOn ?? null;
  if (
    !Number.isInteger(commandIndex) ||
    commandIndex < 0 ||
    (commandId !== null &&
      (!commandVersion || commandVersion < 1 || occurredOn === null)) ||
    (commandId === null && (commandVersion !== null || occurredOn !== null))
  ) {
    throw new InvalidStockMovementError();
  }
}

function commandPayloadMatches(
  existing: typeof stockMovements.$inferSelect,
  input: StockMovementWriteInput,
  productId: string,
  variantId: string
): boolean {
  const unitCost = input.unitCost ?? null;
  const existingUnitCost = existing.unitCost;
  const costsMatch =
    unitCost === null
      ? existingUnitCost === null
      : existingUnitCost !== null &&
        normalizeUnitCost(existingUnitCost) === unitCost;

  return (
    existing.commandVersion === (input.commandVersion ?? null) &&
    existing.commandIndex === (input.commandIndex ?? 0) &&
    existing.movementType === input.movementType &&
    existing.productId === productId &&
    existing.quantityDelta === input.quantityDelta &&
    existing.occurredOn === (input.occurredOn ?? null) &&
    existing.variantId === variantId &&
    costsMatch
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
    .select({ id: products.id })
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

  return { productId: product.id, variantId: variant.id };
}

async function insertStockMovement(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: StockMovementWriteInput,
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
      organizationId: identity.organizationId,
      productId,
      quantityDelta: input.quantityDelta,
      unitCost,
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

async function applyStockMovement(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: StockMovementWriteInput
) {
  requireInventoryCapability(identity);
  if (!isStockMovementType(input.movementType)) {
    throw new InvalidStockMovementError();
  }
  validateStockMovementType(input.movementType, input.quantityDelta);
  validateCommandMetadata(input);

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

  const [balance] = await transaction
    .select({
      movingAverageCost: inventoryBalances.movingAverageCost,
      quantity: inventoryBalances.quantity,
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

  const currentQuantity = balance?.quantity ?? 0;
  const quantity = projectInventoryQuantity(
    currentQuantity,
    input.quantityDelta
  );
  const movingAverageCost =
    input.calculateMovingAverageCost?.({
      currentAverageCost: balance?.movingAverageCost ?? null,
      currentQuantity,
    }) ??
    balance?.movingAverageCost ??
    null;
  const unitCost =
    input.unitCost === undefined || input.unitCost === null
      ? null
      : normalizeUnitCost(input.unitCost);

  const inserted = await insertStockMovement(
    transaction,
    identity,
    input,
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
  if (!isStockMovementType(movementType) || movementType === "receipt") {
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

/**
 * A variant with no movements has no materialized balance row and reads as
 * quantity zero, with no moving cost and an initial projection version of 0.
 */
export async function getInventoryBalance(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  variantId: string
): Promise<InventoryBalance> {
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
