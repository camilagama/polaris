import { SaleNotFoundError } from "@polaris/domain/sales/sale-errors";
import { summarizeConfirmedSaleTotals } from "@polaris/domain/sales/confirm-sale";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  lte,
  type SQL,
  sql,
} from "drizzle-orm";
import { readConfirmedSale } from "./sale-repository";
import { customers } from "./schema/customer";
import type { SaleCancellationRecord } from "./sale-cancellation-repository";
import { saleAdjustments, saleItems, salePayments, sales } from "./schema/sale";
import { saleCancellations } from "./schema/sale-cancellation";
import { saleCustomerLinks } from "./schema/sale-customer-link";
import { saleReturnItems, saleReturns } from "./schema/sale-return";
import {
  TenantAuthorizationError,
  type TenantRequestIdentity,
  type TenantRequestTransaction,
} from "./tenant-transaction";

export const SALE_READ_CAPABILITY = "sale:read";
export const MAX_SALE_LIST_LIMIT = 100;

export type SaleListStatusFilter = "cancelled" | "confirmed" | "with_returns";

/**
 * Optional filters of the sale list. Dates are commercial dates (occurredOn),
 * inclusive. "confirmed" means not cancelled and "with_returns" has at least
 * one return. `query` matches the item labels snapshot and `customerQuery` the
 * current customer's name.
 */
export interface SaleListOptions {
  customerQuery?: string | null | undefined;
  limit?: number;
  occurredFrom?: string | null | undefined;
  occurredTo?: string | null | undefined;
  offset?: number;
  query?: string | null | undefined;
  status?: SaleListStatusFilter | null | undefined;
}

export interface SaleListEntry {
  cancelledAt: Date | null;
  confirmedAt: Date;
  customerId: string | null;
  customerName: string | null;
  hasReturns: boolean;
  id: string;
  itemCount: number;
  occurredAt: Date;
  occurredOn: string;
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

const likeSpecialCharactersPattern = /[\\%_]/g;

function likePattern(text: string): string {
  return `%${text.replace(likeSpecialCharactersPattern, "\\$&")}%`;
}

function saleListConditions(
  organizationId: string,
  options: SaleListOptions
): SQL[] {
  const conditions: SQL[] = [eq(sales.organizationId, organizationId)];
  if (options.occurredFrom) {
    conditions.push(gte(sales.occurredOn, options.occurredFrom));
  }
  if (options.occurredTo) {
    conditions.push(lte(sales.occurredOn, options.occurredTo));
  }
  const cancelled = sql`EXISTS (
    SELECT 1 FROM ${saleCancellations}
    WHERE ${saleCancellations.organizationId} = ${sales.organizationId}
      AND ${saleCancellations.saleId} = ${sales.id}
  )`;
  if (options.status === "cancelled") {
    conditions.push(cancelled);
  } else if (options.status === "confirmed") {
    conditions.push(sql`NOT ${cancelled}`);
  } else if (options.status === "with_returns") {
    conditions.push(sql`EXISTS (
      SELECT 1 FROM ${saleReturns}
      WHERE ${saleReturns.organizationId} = ${sales.organizationId}
        AND ${saleReturns.saleId} = ${sales.id}
    )`);
  }
  const query = options.query?.trim();
  if (query) {
    conditions.push(sql`EXISTS (
      SELECT 1 FROM ${saleItems}
      WHERE ${saleItems.organizationId} = ${sales.organizationId}
        AND ${saleItems.saleId} = ${sales.id}
        AND ${saleItems.productLabel} ILIKE ${likePattern(query)}
    )`);
  }
  const customerQuery = options.customerQuery?.trim();
  if (customerQuery) {
    conditions.push(sql`EXISTS (
      SELECT 1
      FROM ${saleCustomerLinks}
      INNER JOIN ${customers}
        ON ${customers.id} = ${saleCustomerLinks.customerId}
       AND ${customers.organizationId} = ${saleCustomerLinks.organizationId}
      WHERE ${saleCustomerLinks.organizationId} = ${sales.organizationId}
        AND ${saleCustomerLinks.saleId} = ${sales.id}
        AND ${saleCustomerLinks.version} = (
          SELECT max(latest.version) FROM ${saleCustomerLinks} AS latest
          WHERE latest.organization_id = ${sales.organizationId}
            AND latest.sale_id = ${sales.id}
        )
        AND ${customers.name} ILIKE ${likePattern(customerQuery)}
    )`);
  }
  return conditions;
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
    .where(and(...saleListConditions(identity.organizationId, options)))
    .orderBy(desc(sales.confirmedAt), desc(sales.id))
    .limit(limit + 1)
    .offset(offset);
  const hasMore = page.length > limit;
  const headers = page.slice(0, limit);
  if (headers.length === 0) {
    return { hasMore: false, sales: [] };
  }

  const ids = headers.map((header) => header.id);
  const [items, adjustments, payments, cancellations, links, returned] =
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
      transaction
        .select({ saleId: saleReturns.saleId })
        .from(saleReturns)
        .where(
          and(
            eq(saleReturns.organizationId, identity.organizationId),
            inArray(saleReturns.saleId, ids)
          )
        ),
    ]);
  const salesWithReturns = new Set(returned.map((row) => row.saleId));

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
  const customerIds = [
    ...new Set(
      [...customerBySale.values()].filter(
        (customerId): customerId is string => customerId !== null
      )
    ),
  ];
  const customerNames = new Map<string, string>();
  if (customerIds.length > 0) {
    const named = await transaction
      .select({ id: customers.id, name: customers.name })
      .from(customers)
      .where(
        and(
          eq(customers.organizationId, identity.organizationId),
          inArray(customers.id, customerIds)
        )
      );
    for (const customer of named) {
      customerNames.set(customer.id, customer.name);
    }
  }

  return {
    hasMore,
    sales: headers.map((header) => {
      const cancelledAt = cancelledAtBySale.get(header.id) ?? null;
      const customerId = customerBySale.get(header.id) ?? null;
      return {
        cancelledAt,
        confirmedAt: header.confirmedAt,
        customerId,
        customerName:
          customerId === null ? null : (customerNames.get(customerId) ?? null),
        hasReturns: salesWithReturns.has(header.id),
        id: header.id,
        itemCount: header.itemCount,
        occurredAt: header.occurredAt,
        occurredOn: header.occurredOn,
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

  const returnRows = await transaction
    .select({
      commandId: saleReturns.commandId,
      id: saleReturns.id,
      reasonCode: saleReturns.reasonCode,
      reasonNote: saleReturns.reasonNote,
      returnedAt: saleReturns.returnedAt,
      returnedBy: saleReturns.returnedBy,
      saleId: saleReturns.saleId,
    })
    .from(saleReturns)
    .where(
      and(
        eq(saleReturns.organizationId, identity.organizationId),
        eq(saleReturns.saleId, saleId)
      )
    )
    .orderBy(asc(saleReturns.returnedAt), asc(saleReturns.id));
  const returnItemRows = await transaction
    .select({
      position: saleReturnItems.itemPosition,
      restockedQuantity: saleReturnItems.restockedQuantity,
      returnId: saleReturnItems.returnId,
      returnedQuantity: saleReturnItems.returnedQuantity,
    })
    .from(saleReturnItems)
    .where(
      and(
        eq(saleReturnItems.organizationId, identity.organizationId),
        eq(saleReturnItems.saleId, saleId)
      )
    )
    .orderBy(asc(saleReturnItems.itemPosition));
  const returnItemsById = groupBy(returnItemRows, (row) => row.returnId);
  const returns = returnRows.map((saleReturn) => ({
    ...saleReturn,
    items: (returnItemsById.get(saleReturn.id) ?? []).map(
      ({ position, restockedQuantity, returnedQuantity }) => ({
        position,
        restockedQuantity,
        returnedQuantity,
      })
    ),
  }));
  const returnSummary = sale.items.map((item) => {
    const lines = returnItemRows.filter(
      (row) => row.position === item.position
    );
    const returnedQuantity = lines.reduce(
      (sum, row) => sum + row.returnedQuantity,
      0
    );
    return {
      availableToReturn: item.quantity - returnedQuantity,
      position: item.position,
      restockedQuantity: lines.reduce(
        (sum, row) => sum + row.restockedQuantity,
        0
      ),
      returnedQuantity,
      sold: item.quantity,
    };
  });

  return {
    cancellation: cancellation ?? null,
    customer: {
      customerId: latestLink?.customerId ?? null,
      version: latestLink?.version ?? 0,
    },
    returnSummary,
    returns,
    sale,
  };
}
