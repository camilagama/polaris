import { normalizeUnitCost } from "@polaris/domain/inventory/inventory-cost";
import {
  calendarDateInTimeZone,
  SaleProductUnavailableError,
} from "@polaris/domain/sales/confirm-sale";
import { SaleNotFoundError } from "@polaris/domain/sales/sale-errors";
import {
  type NormalizedReturnSaleCommand,
  normalizeReturnSaleCommand,
  planSaleReturn,
  type ReturnSaleCommandInput,
  SaleNotReturnableError,
  SaleReturnCommandConflictError,
} from "@polaris/domain/sales/sale-return";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { recordSaleRestockMovement } from "./inventory-repository";
import { lockSaleForCompensation } from "./sale-locks";
import { organizations } from "./schema/organization";
import { products } from "./schema/product";
import { saleItems, sales } from "./schema/sale";
import { saleCancellations } from "./schema/sale-cancellation";
import { saleReturnItems, saleReturns } from "./schema/sale-return";
import { recordTenantAuditEvent } from "./tenant-audit";
import {
  TenantAuthorizationError,
  type TenantRequestIdentity,
  type TenantRequestTransaction,
} from "./tenant-transaction";

export const SALE_RETURN_CAPABILITY = "sale:return";

export interface CreateSaleReturnRepositoryInput
  extends ReturnSaleCommandInput {
  requestId?: string | null;
}

export interface SaleReturnRecord {
  commandId: string;
  id: string;
  reasonCode: string | null;
  reasonNote: string | null;
  returnedAt: Date;
  returnedBy: string;
  saleId: string;
}

export interface SaleReturnLine {
  position: number;
  restockedQuantity: number;
  returnedQuantity: number;
}

export interface CreateSaleReturnResult {
  lines: SaleReturnLine[];
  replayed: boolean;
  saleReturn: SaleReturnRecord;
}

const returnColumns = {
  commandId: saleReturns.commandId,
  id: saleReturns.id,
  reasonCode: saleReturns.reasonCode,
  reasonNote: saleReturns.reasonNote,
  returnedAt: saleReturns.returnedAt,
  returnedBy: saleReturns.returnedBy,
  saleId: saleReturns.saleId,
};

function requireCapability(identity: TenantRequestIdentity): void {
  if (identity.capability !== SALE_RETURN_CAPABILITY) {
    throw new TenantAuthorizationError("capability_denied");
  }
}

async function readLines(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  returnId: string
): Promise<SaleReturnLine[]> {
  return await transaction
    .select({
      position: saleReturnItems.itemPosition,
      restockedQuantity: saleReturnItems.restockedQuantity,
      returnedQuantity: saleReturnItems.returnedQuantity,
    })
    .from(saleReturnItems)
    .where(
      and(
        eq(saleReturnItems.organizationId, identity.organizationId),
        eq(saleReturnItems.returnId, returnId)
      )
    )
    .orderBy(asc(saleReturnItems.itemPosition));
}

async function replayExisting(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  command: NormalizedReturnSaleCommand
): Promise<CreateSaleReturnResult | null> {
  const [existing] = await transaction
    .select(returnColumns)
    .from(saleReturns)
    .where(
      and(
        eq(saleReturns.organizationId, identity.organizationId),
        eq(saleReturns.commandId, command.commandId)
      )
    )
    .limit(1);
  if (!existing) {
    return null;
  }
  const lines = await readLines(transaction, identity, existing.id);
  const same =
    existing.saleId === command.saleId &&
    existing.reasonCode === command.reasonCode &&
    existing.reasonNote === command.reasonNote &&
    lines.length === command.items.length &&
    lines.every((line, index) => {
      const requested = command.items[index];
      return (
        requested !== undefined &&
        requested.position === line.position &&
        requested.returnedQuantity === line.returnedQuantity &&
        requested.restockedQuantity === line.restockedQuantity
      );
    });
  if (!same) {
    throw new SaleReturnCommandConflictError();
  }
  return { lines, replayed: true, saleReturn: existing };
}

/**
 * Registers a partial return of a confirmed sale as a compensatory record:
 * returned and restocked quantities per item, the inverse ledger movements for
 * the restocked units (at each item's own cost snapshot), the balances and the
 * audit event commit together or not at all. The sale is never edited.
 * `returned <= available_to_return` and `restocked <= returned` are enforced
 * here and again at commit by PostgreSQL. Idempotent by command ID; a cancelled
 * sale is not returnable. Runs in the caller's tenant transaction, so the
 * organization and the actor come from the authorized identity.
 */
export async function createSaleReturn(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  rawInput: CreateSaleReturnRepositoryInput
): Promise<CreateSaleReturnResult> {
  requireCapability(identity);
  const command = normalizeReturnSaleCommand(rawInput);

  const early = await replayExisting(transaction, identity, command);
  if (early) {
    return early;
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
  if (sale.commandId === command.commandId) {
    throw new SaleReturnCommandConflictError();
  }

  // From here on this sale's returns and cancellation run one at a time, so
  // the availability and cancelled checks below cannot go stale before commit.
  await lockSaleForCompensation(transaction, sale.id);
  const afterLock = await replayExisting(transaction, identity, command);
  if (afterLock) {
    return afterLock;
  }
  const [cancellation] = await transaction
    .select({ id: saleCancellations.id })
    .from(saleCancellations)
    .where(
      and(
        eq(saleCancellations.organizationId, identity.organizationId),
        eq(saleCancellations.saleId, sale.id)
      )
    )
    .limit(1);
  if (cancellation) {
    throw new SaleNotReturnableError();
  }

  const items = await transaction
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
        eq(saleItems.saleId, sale.id)
      )
    )
    .orderBy(asc(saleItems.position));
  const returnedRows = await transaction
    .select({
      position: saleReturnItems.itemPosition,
      returned: sql<number>`COALESCE(sum(${saleReturnItems.returnedQuantity}), 0)::int`,
    })
    .from(saleReturnItems)
    .where(
      and(
        eq(saleReturnItems.organizationId, identity.organizationId),
        eq(saleReturnItems.saleId, sale.id)
      )
    )
    .groupBy(saleReturnItems.itemPosition);
  const returnedByPosition = new Map(
    returnedRows.map((row) => [row.position, row.returned])
  );
  const plan = planSaleReturn(
    items.map((item) => ({
      position: item.position,
      productId: item.productId,
      quantity: item.quantity,
      returnedSoFar: returnedByPosition.get(item.position) ?? 0,
      unitCost:
        item.unitCost === null ? null : normalizeUnitCost(item.unitCost),
      variantId: item.variantId,
    })),
    command.items
  );

  const [organization] = await transaction
    .select({ timezone: organizations.timezone })
    .from(organizations)
    .where(eq(organizations.id, identity.organizationId))
    .limit(1);
  if (!organization) {
    throw new TenantAuthorizationError("tenant_access_denied");
  }
  const occurredOn = calendarDateInTimeZone(new Date(), organization.timezone);

  const [created] = await transaction
    .insert(saleReturns)
    .values({
      commandId: command.commandId,
      organizationId: identity.organizationId,
      reasonCode: command.reasonCode,
      reasonNote: command.reasonNote,
      returnedBy: identity.userId,
      saleId: sale.id,
    })
    .onConflictDoNothing()
    .returning(returnColumns);
  if (!created) {
    const concurrent = await replayExisting(transaction, identity, command);
    if (!concurrent) {
      throw new Error("sale_return_insert_failed");
    }
    return concurrent;
  }

  await transaction.insert(saleReturnItems).values(
    plan.map((line) => ({
      itemPosition: line.position,
      organizationId: identity.organizationId,
      restockedQuantity: line.restockedQuantity,
      returnId: created.id,
      returnedQuantity: line.returnedQuantity,
      saleId: sale.id,
    }))
  );

  const restockLines = plan.filter((line) => line.restockedQuantity > 0);
  if (restockLines.length > 0) {
    // Same product lock order as sales and cancellations, so they never deadlock.
    // A removed product has frozen stock and cannot take units back.
    const productIds = [...new Set(restockLines.map((line) => line.productId))];
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

    const lockOrder = [...restockLines].sort(
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
        movementType: "sale_return",
        occurredOn,
        quantity: line.restockedQuantity,
        requestId: rawInput.requestId ?? null,
        unitCost: line.unitCost,
        variantId: line.variantId,
      });
    }
  }

  await recordTenantAuditEvent(transaction, identity, {
    entityId: created.id,
    entityType: "sale_return",
    eventType: "sale.returned",
    requestId: rawInput.requestId ?? null,
  });

  return {
    lines: plan.map(({ position, restockedQuantity, returnedQuantity }) => ({
      position,
      restockedQuantity,
      returnedQuantity,
    })),
    replayed: false,
    saleReturn: created,
  };
}
