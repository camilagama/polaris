import { SaleNotFoundError } from "@polaris/domain/sales/sale-errors";
import { summarizeConfirmedSaleTotals } from "@polaris/domain/sales/confirm-sale";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { readConfirmedSale } from "./sale-repository";
import type { SaleCancellationRecord } from "./sale-cancellation-repository";
import { saleAdjustments, saleItems, salePayments, sales } from "./schema/sale";
import { saleCancellations } from "./schema/sale-cancellation";
import { saleCustomerLinks } from "./schema/sale-customer-link";
import {
  TenantAuthorizationError,
  type TenantRequestIdentity,
  type TenantRequestTransaction,
} from "./tenant-transaction";

export const SALE_READ_CAPABILITY = "sale:read";
export const MAX_SALE_LIST_LIMIT = 100;

export interface SaleListOptions {
  limit?: number;
  offset?: number;
}

export interface SaleListEntry {
  cancelledAt: Date | null;
  confirmedAt: Date;
  customerId: string | null;
  id: string;
  itemCount: number;
  occurredAt: Date;
  paymentMethod: string | null;
  status: "cancelled" | "confirmed";
  totalDue: string;
}

function requireCapability(identity: TenantRequestIdentity): void {
  if (identity.capability !== SALE_READ_CAPABILITY) {
    throw new TenantAuthorizationError("capability_denied");
  }
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

function groupBy<T>(rows: readonly T[], key: (row: T) => string) {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const bucket = grouped.get(key(row)) ?? [];
    bucket.push(row);
    grouped.set(key(row), bucket);
  }
  return grouped;
}

/**
 * Recent confirmed sales, newest first, with their status and current customer.
 * Money comes from the persisted rows; nothing is recalculated from catalog data.
 */
export async function listSales(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  options: SaleListOptions = {}
): Promise<{ hasMore: boolean; sales: SaleListEntry[] }> {
  requireCapability(identity);
  const limit = Math.min(
    Math.max(Math.trunc(options.limit ?? 50), 1),
    MAX_SALE_LIST_LIMIT
  );
  const offset = Math.max(Math.trunc(options.offset ?? 0), 0);

  const page = await transaction
    .select()
    .from(sales)
    .where(eq(sales.organizationId, identity.organizationId))
    .orderBy(desc(sales.confirmedAt), desc(sales.id))
    .limit(limit + 1)
    .offset(offset);
  const hasMore = page.length > limit;
  const headers = page.slice(0, limit);
  if (headers.length === 0) {
    return { hasMore: false, sales: [] };
  }

  const ids = headers.map((header) => header.id);
  const [items, adjustments, payments, cancellations, links] =
    await Promise.all([
      transaction
        .select({
          chargedUnitPrice: saleItems.chargedUnitPrice,
          quantity: saleItems.quantity,
          saleId: saleItems.saleId,
        })
        .from(saleItems)
        .where(
          and(
            eq(saleItems.organizationId, identity.organizationId),
            inArray(saleItems.saleId, ids)
          )
        ),
      transaction
        .select({
          amount: saleAdjustments.amount,
          kind: saleAdjustments.kind,
          saleId: saleAdjustments.saleId,
        })
        .from(saleAdjustments)
        .where(
          and(
            eq(saleAdjustments.organizationId, identity.organizationId),
            inArray(saleAdjustments.saleId, ids)
          )
        ),
      transaction
        .select({ method: salePayments.method, saleId: salePayments.saleId })
        .from(salePayments)
        .where(
          and(
            eq(salePayments.organizationId, identity.organizationId),
            inArray(salePayments.saleId, ids)
          )
        ),
      transaction
        .select({
          cancelledAt: saleCancellations.cancelledAt,
          saleId: saleCancellations.saleId,
        })
        .from(saleCancellations)
        .where(
          and(
            eq(saleCancellations.organizationId, identity.organizationId),
            inArray(saleCancellations.saleId, ids)
          )
        ),
      transaction
        .select({
          customerId: saleCustomerLinks.customerId,
          saleId: saleCustomerLinks.saleId,
          version: saleCustomerLinks.version,
        })
        .from(saleCustomerLinks)
        .where(
          and(
            eq(saleCustomerLinks.organizationId, identity.organizationId),
            inArray(saleCustomerLinks.saleId, ids)
          )
        )
        .orderBy(asc(saleCustomerLinks.version)),
    ]);

  const itemsBySale = groupBy(items, (row) => row.saleId);
  const adjustmentsBySale = groupBy(adjustments, (row) => row.saleId);
  const paymentBySale = new Map(
    payments.map((row) => [row.saleId, row.method])
  );
  const cancelledAtBySale = new Map(
    cancellations.map((row) => [row.saleId, row.cancelledAt])
  );
  const customerBySale = new Map<string, string | null>();
  for (const link of links) {
    customerBySale.set(link.saleId, link.customerId);
  }

  return {
    hasMore,
    sales: headers.map((header) => {
      const cancelledAt = cancelledAtBySale.get(header.id) ?? null;
      return {
        cancelledAt,
        confirmedAt: header.confirmedAt,
        customerId: customerBySale.get(header.id) ?? null,
        id: header.id,
        itemCount: header.itemCount,
        occurredAt: header.occurredAt,
        paymentMethod: paymentBySale.get(header.id) ?? null,
        status: cancelledAt === null ? "confirmed" : "cancelled",
        totalDue: summarizeConfirmedSaleTotals(
          itemsBySale.get(header.id) ?? [],
          adjustmentsBySale.get(header.id) ?? []
        ).totalDue,
      };
    }),
  };
}

/** One confirmed sale with its snapshots, cancellation and current customer. */
export async function getSale(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  saleId: string
) {
  requireCapability(identity);
  const [header] = await transaction
    .select()
    .from(sales)
    .where(
      and(
        eq(sales.organizationId, identity.organizationId),
        eq(sales.id, saleId)
      )
    )
    .limit(1);
  if (!header) {
    throw new SaleNotFoundError();
  }

  const sale = await readConfirmedSale(transaction, identity, header);
  const [cancellation]: SaleCancellationRecord[] = await transaction
    .select(cancellationColumns)
    .from(saleCancellations)
    .where(
      and(
        eq(saleCancellations.organizationId, identity.organizationId),
        eq(saleCancellations.saleId, saleId)
      )
    )
    .limit(1);
  const [latestLink] = await transaction
    .select({
      customerId: saleCustomerLinks.customerId,
      version: saleCustomerLinks.version,
    })
    .from(saleCustomerLinks)
    .where(
      and(
        eq(saleCustomerLinks.organizationId, identity.organizationId),
        eq(saleCustomerLinks.saleId, saleId)
      )
    )
    .orderBy(desc(saleCustomerLinks.version))
    .limit(1);

  return {
    cancellation: cancellation ?? null,
    customer: {
      customerId: latestLink?.customerId ?? null,
      version: latestLink?.version ?? 0,
    },
    sale,
  };
}
