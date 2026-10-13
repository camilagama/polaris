import { normalizeUnitCost } from "@polaris/domain/inventory/inventory-cost";
import {
  calendarDateInTimeZone,
  SaleProductUnavailableError,
} from "@polaris/domain/sales/confirm-sale";
import {
  type CancelSaleCommandInput,
  type NormalizedCancelSaleCommand,
  normalizeCancelSaleCommand,
  planCancellationRestock,
  SaleAlreadyCancelledError,
  SaleCancellationCommandConflictError,
} from "@polaris/domain/sales/sale-cancellation";
import { SaleNotFoundError } from "@polaris/domain/sales/sale-errors";
import { and, asc, eq, inArray } from "drizzle-orm";
import { recordSaleRestockMovement } from "./inventory-repository";
import { organizations } from "./schema/organization";
import { products } from "./schema/product";
import { saleItems, sales } from "./schema/sale";
import { saleCancellations } from "./schema/sale-cancellation";
import { recordTenantAuditEvent } from "./tenant-audit";
import {
  TenantAuthorizationError,
  type TenantRequestIdentity,
  type TenantRequestTransaction,
} from "./tenant-transaction";

export const SALE_CANCEL_CAPABILITY = "sale:cancel";

export interface CancelSaleRepositoryInput extends CancelSaleCommandInput {
  requestId?: string | null;
}

export interface SaleCancellationRecord {
  cancelledAt: Date;
  cancelledBy: string;
  commandId: string;
  id: string;
  reasonCode: string | null;
  reasonNote: string | null;
  saleId: string;
}

export interface CancelSaleResult {
  cancellation: SaleCancellationRecord;
  replayed: boolean;
  /** One inverse movement per sale item, in item position order. */
  restocked: Array<{ position: number; quantity: number; variantId: string }>;
}

const cancellationColumns = {
  cancelledAt: saleCancellations.cancelledAt,
  cancelledBy: saleCancellations.cancelledBy,
  commandId: saleCancellations.commandId,
  id: saleCancellations.id,
  reasonCode: saleCancellations.reasonCode,
  reasonNote: saleCancellations.reasonNote,
  saleId: saleCancellations.saleId,
};

function requireCapability(identity: TenantRequestIdentity): void {
  if (identity.capability !== SALE_CANCEL_CAPABILITY) {
    throw new TenantAuthorizationError("capability_denied");
  }
}

async function readItems(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  saleId: string
) {
  return await transaction
    .select({
      position: saleItems.position,
      productId: saleItems.productId,
      quantity: saleItems.quantity,
      unitCost: saleItems.unitCost,
      variantId: saleItems.variantId,
    })
    .from(saleItems)
    .where(
      and(
        eq(saleItems.organizationId, identity.organizationId),
        eq(saleItems.saleId, saleId)
      )
    )
    .orderBy(asc(saleItems.position));
}

async function replayOrConflict(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  command: NormalizedCancelSaleCommand
): Promise<CancelSaleResult | null> {
  const [existing] = await transaction
    .select(cancellationColumns)
    .from(saleCancellations)
    .where(
      and(
        eq(saleCancellations.organizationId, identity.organizationId),
        eq(saleCancellations.commandId, command.commandId)
      )
    )
    .limit(1);
  if (existing) {
    if (
      existing.saleId !== command.saleId ||
      existing.reasonCode !== command.reasonCode ||
      existing.reasonNote !== command.reasonNote
    ) {
      throw new SaleCancellationCommandConflictError();
    }
    const items = await readItems(transaction, identity, existing.saleId);
    return {
      cancellation: existing,
      replayed: true,
      restocked: items.map(({ position, quantity, variantId }) => ({
        position,
        quantity,
        variantId,
      })),
    };
  }

  const [other] = await transaction
    .select({ id: saleCancellations.id })
    .from(saleCancellations)
    .where(
      and(
        eq(saleCancellations.organizationId, identity.organizationId),
        eq(saleCancellations.saleId, command.saleId)
      )
    )
    .limit(1);
  if (other) {
    throw new SaleAlreadyCancelledError();
  }
  return null;
}

/**
 * Cancels a whole confirmed sale as a compensatory record: one inverse ledger
 * movement per item (at the item's own cost snapshot), the balances and the
 * audit event commit together or not at all. The confirmed sale and its
 * original movements are never edited. Idempotent by command ID; a sale is
 * cancelled once. Runs in the caller's tenant transaction, so the organization
 * and the actor come from the authorized identity.
 */
export async function cancelSale(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  rawInput: CancelSaleRepositoryInput
): Promise<CancelSaleResult> {
  requireCapability(identity);
  const command = normalizeCancelSaleCommand(rawInput);

  const replay = await replayOrConflict(transaction, identity, command);
  if (replay) {
    return replay;
  }

  const [sale] = await transaction
    .select({ commandId: sales.commandId, id: sales.id })
    .from(sales)
    .where(
      and(
        eq(sales.organizationId, identity.organizationId),
        eq(sales.id, command.saleId)
      )
    )
    .limit(1);
  if (!sale) {
    throw new SaleNotFoundError();
  }
  // The cancellation writes ledger rows keyed by its own command ID, so it
  // cannot reuse the sale's.
  if (sale.commandId === command.commandId) {
    throw new SaleCancellationCommandConflictError();
  }

  const [organization] = await transaction
    .select({ timezone: organizations.timezone })
    .from(organizations)
    .where(eq(organizations.id, identity.organizationId))
    .limit(1);
  if (!organization) {
    throw new TenantAuthorizationError("tenant_access_denied");
  }
  const occurredOn = calendarDateInTimeZone(new Date(), organization.timezone);

  // The unique sale and command indexes serialize racing cancellations: the
  // loser inserts nothing and is classified as a replay or as already cancelled.
  const [created] = await transaction
    .insert(saleCancellations)
    .values({
      cancelledBy: identity.userId,
      commandId: command.commandId,
      organizationId: identity.organizationId,
      reasonCode: command.reasonCode,
      reasonNote: command.reasonNote,
      saleId: command.saleId,
    })
    .onConflictDoNothing()
    .returning(cancellationColumns);
  if (!created) {
    const concurrent = await replayOrConflict(transaction, identity, command);
    if (!concurrent) {
      throw new Error("sale_cancellation_insert_failed");
    }
    return concurrent;
  }

  const items = await readItems(transaction, identity, sale.id);
  const plan = planCancellationRestock(
    items.map((item) => ({
      position: item.position,
      productId: item.productId,
      quantity: item.quantity,
      unitCost:
        item.unitCost === null ? null : normalizeUnitCost(item.unitCost),
      variantId: item.variantId,
    }))
  );

  // Lock products in id order (as sales do) so concurrent sales, returns and
  // cancellations over the same products cannot deadlock. A removed product has
  // frozen stock and cannot take units back.
  const productIds = [...new Set(plan.map((line) => line.productId))];
  const lockedProducts = await transaction
    .select({ deletedAt: products.deletedAt, id: products.id })
    .from(products)
    .where(
      and(
        eq(products.organizationId, identity.organizationId),
        inArray(products.id, productIds)
      )
    )
    .orderBy(asc(products.id))
    .for("update");
  if (
    lockedProducts.length !== productIds.length ||
    lockedProducts.some((product) => product.deletedAt !== null)
  ) {
    throw new SaleProductUnavailableError();
  }

  const lockOrder = [...plan].sort(
    (left, right) =>
      left.productId.localeCompare(right.productId) ||
      left.variantId.localeCompare(right.variantId) ||
      left.position - right.position
  );
  for (const line of lockOrder) {
    // Sequential by design: each restock locks its balance row in product order.
    // biome-ignore lint/performance/noAwaitInLoops: sequential by design
    await recordSaleRestockMovement(transaction, identity, {
      commandId: command.commandId,
      commandIndex: line.position,
      movementType: "sale_cancellation",
      occurredOn,
      quantity: line.quantity,
      requestId: rawInput.requestId ?? null,
      unitCost: line.unitCost,
      variantId: line.variantId,
    });
  }

  await recordTenantAuditEvent(transaction, identity, {
    entityId: created.id,
    entityType: "sale_cancellation",
    eventType: "sale.cancelled",
    requestId: rawInput.requestId ?? null,
  });

  return {
    cancellation: created,
    replayed: false,
    restocked: plan.map(({ position, quantity, variantId }) => ({
      position,
      quantity,
      variantId,
    })),
  };
}
