import {
  InvalidStockMovementError,
  isStockMovementType,
  InventoryVariantNotFoundError,
  projectInventoryQuantity,
  validateStockMovementType,
  type StockMovementType,
} from "@polaris/domain/inventory/inventory";
import { and, eq, sql } from "drizzle-orm";
import { recordTenantAuditEvent } from "./tenant-audit";
import {
  TenantAuthorizationError,
  type TenantRequestIdentity,
  type TenantRequestTransaction,
} from "./tenant-transaction";
import { inventoryBalances, stockMovements } from "./schema/inventory";
import { productVariants, products } from "./schema/product";

export interface RecordStockMovementInput {
  movementType: StockMovementType;
  quantityDelta: number;
  requestId?: string | null;
  variantId: string;
}

export interface InventoryBalance {
  movingAverageCost: string | null;
  quantity: number;
  variantId: string;
  version: number;
}

/**
 * The caller must use withAuthorizedTenantTransaction with inventory:adjust.
 * The product row lock serializes movements for a product and the initial
 * variant-configuration transaction, including the case where no balance row
 * exists yet.
 */
export async function recordStockMovement(
  outerTransaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: RecordStockMovementInput
) {
  if (identity.capability !== "inventory:adjust") {
    throw new TenantAuthorizationError("capability_denied");
  }
  if (!isStockMovementType(input.movementType)) {
    throw new InvalidStockMovementError();
  }
  validateStockMovementType(input.movementType, input.quantityDelta);

  return await outerTransaction.transaction(async (transaction) => {
    const [variantReference] = await transaction
      .select({ productId: productVariants.productId })
      .from(productVariants)
      .where(
        and(
          eq(productVariants.id, input.variantId),
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
      .select({
        id: productVariants.id,
        productId: productVariants.productId,
      })
      .from(productVariants)
      .where(
        and(
          eq(productVariants.id, input.variantId),
          eq(productVariants.organizationId, identity.organizationId),
          eq(productVariants.productId, product.id)
        )
      )
      .limit(1);
    if (!variant) {
      throw new InventoryVariantNotFoundError();
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
          eq(inventoryBalances.variantId, variant.id)
        )
      )
      .for("update")
      .limit(1);

    const quantity = projectInventoryQuantity(
      balance?.quantity ?? 0,
      input.quantityDelta
    );

    const [movement] = await transaction
      .insert(stockMovements)
      .values({
        movementType: input.movementType,
        organizationId: identity.organizationId,
        productId: product.id,
        quantityDelta: input.quantityDelta,
        variantId: variant.id,
      })
      .returning({
        createdAt: stockMovements.createdAt,
        id: stockMovements.id,
        movementType: stockMovements.movementType,
        quantityDelta: stockMovements.quantityDelta,
        variantId: stockMovements.variantId,
      });

    if (!movement) {
      throw new Error("stock_movement_insert_failed");
    }

    let updatedBalance: InventoryBalance;
    if (balance) {
      const [updated] = await transaction
        .update(inventoryBalances)
        .set({
          quantity,
          updatedAt: new Date(),
          version: sql`${inventoryBalances.version} + 1`,
        })
        .where(
          and(
            eq(inventoryBalances.organizationId, identity.organizationId),
            eq(inventoryBalances.variantId, variant.id)
          )
        )
        .returning({
          movingAverageCost: inventoryBalances.movingAverageCost,
          quantity: inventoryBalances.quantity,
          variantId: inventoryBalances.variantId,
          version: inventoryBalances.version,
        });
      if (!updated) {
        throw new Error("inventory_balance_update_failed");
      }
      updatedBalance = updated;
    } else {
      const [created] = await transaction
        .insert(inventoryBalances)
        .values({
          organizationId: identity.organizationId,
          productId: product.id,
          quantity,
          variantId: variant.id,
        })
        .returning({
          movingAverageCost: inventoryBalances.movingAverageCost,
          quantity: inventoryBalances.quantity,
          variantId: inventoryBalances.variantId,
          version: inventoryBalances.version,
        });
      if (!created) {
        throw new Error("inventory_balance_insert_failed");
      }
      updatedBalance = created;
    }

    await recordTenantAuditEvent(transaction, identity, {
      entityId: movement.id,
      entityType: "stock_movement",
      eventType: "inventory.movement_recorded",
      requestId: input.requestId ?? null,
    });

    return { balance: updatedBalance, movement };
  });
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
    .select({
      movingAverageCost: inventoryBalances.movingAverageCost,
      quantity: inventoryBalances.quantity,
      variantId: inventoryBalances.variantId,
      version: inventoryBalances.version,
    })
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
