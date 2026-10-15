import {
  periodResult,
  type PeriodResult,
  type SaleAdjustmentFact,
  type SaleFact,
  type SaleReturnLineFact,
} from "@polaris/domain/economics/sale-economics";
import { isValidCalendarDate } from "@polaris/domain/inventory/calendar-date";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { expenses } from "./schema/expense";
import { saleAdjustments, saleItems, salePayments, sales } from "./schema/sale";
import { saleCancellations } from "./schema/sale-cancellation";
import { saleReturnItems } from "./schema/sale-return";
import {
  TenantAuthorizationError,
  type TenantRequestIdentity,
  type TenantRequestTransaction,
} from "./tenant-transaction";

/** Reading the economics of a period needs this capability (owner-only in the V1). */
const REPORT_CAPABILITY = "report:read";
/** A period of at most this many days (the sales of it are read into memory). */
export const MAX_ECONOMICS_PERIOD_DAYS = 366;

export class InvalidEconomicsPeriodError extends Error {
  readonly code = "invalid_economics_period";

  constructor() {
    super("invalid_economics_period");
    this.name = "InvalidEconomicsPeriodError";
  }
}

export interface EconomicsPeriod {
  /** Inclusive, `YYYY-MM-DD`, in the organization's calendar. */
  from: string;
  to: string;
}

function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000
  );
}

function assertPeriod(period: EconomicsPeriod) {
  if (
    !(isValidCalendarDate(period.from) && isValidCalendarDate(period.to)) ||
    period.to < period.from ||
    daysBetween(period.from, period.to) + 1 > MAX_ECONOMICS_PERIOD_DAYS
  ) {
    throw new InvalidEconomicsPeriodError();
  }
}

function group<T, K>(rows: readonly T[], key: (row: T) => K): Map<K, T[]> {
  const grouped = new Map<K, T[]>();
  for (const row of rows) {
    const list = grouped.get(key(row)) ?? [];
    list.push(row);
    grouped.set(key(row), list);
  }
  return grouped;
}

const ADJUSTMENT_KINDS: ReadonlySet<string> = new Set([
  "discount",
  "freight",
  "payment_surcharge",
  "surcharge",
]);

/**
 * The facts the economics engine needs for a period of the organization's
 * calendar: the sales whose commercial date is in it (with their items,
 * adjustments, payment fee snapshots, return lines, cancellation and linked
 * expenses) and the active expenses with no sale whose competence is in it.
 * Everything is read in one transaction; run it at REPEATABLE READ for a
 * consistent snapshot.
 */
export async function readPeriodFacts(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  period: EconomicsPeriod
): Promise<{ operatingExpenses: string[]; sales: SaleFact[] }> {
  if (identity.capability !== REPORT_CAPABILITY) {
    throw new TenantAuthorizationError("capability_denied");
  }
  assertPeriod(period);
  const organization = identity.organizationId;

  const saleRows = await transaction
    .select({ id: sales.id })
    .from(sales)
    .where(
      and(
        eq(sales.organizationId, organization),
        sql`${sales.occurredOn} >= ${period.from}::date`,
        sql`${sales.occurredOn} <= ${period.to}::date`
      )
    )
    .orderBy(asc(sales.occurredOn), asc(sales.id));
  const operatingRows = await transaction
    .select({ amount: expenses.amount })
    .from(expenses)
    .where(
      and(
        eq(expenses.organizationId, organization),
        isNull(expenses.voidedAt),
        isNull(expenses.saleId),
        sql`${expenses.competenceOn} >= ${period.from}::date`,
        sql`${expenses.competenceOn} <= ${period.to}::date`
      )
    );
  const operatingExpenses = operatingRows.map((row) => row.amount);
  if (saleRows.length === 0) {
    return { operatingExpenses, sales: [] };
  }
  const ids = saleRows.map((row) => row.id);

  const [items, adjustments, payments, returnLines, cancelled, linked] =
    await Promise.all([
      transaction
        .select({
          chargedUnitPrice: saleItems.chargedUnitPrice,
          position: saleItems.position,
          quantity: saleItems.quantity,
          saleId: saleItems.saleId,
          unitCost: saleItems.unitCost,
        })
        .from(saleItems)
        .where(
          and(
            eq(saleItems.organizationId, organization),
            inArray(saleItems.saleId, ids)
          )
        )
        .orderBy(asc(saleItems.position)),
      transaction
        .select({
          amount: saleAdjustments.amount,
          kind: saleAdjustments.kind,
          saleId: saleAdjustments.saleId,
        })
        .from(saleAdjustments)
        .where(
          and(
            eq(saleAdjustments.organizationId, organization),
            inArray(saleAdjustments.saleId, ids)
          )
        ),
      transaction
        .select({
          anticipationFee: salePayments.anticipationFeeAmountSnapshot,
          processingFee: salePayments.processingFeeAmountSnapshot,
          saleId: salePayments.saleId,
        })
        .from(salePayments)
        .where(
          and(
            eq(salePayments.organizationId, organization),
            inArray(salePayments.saleId, ids)
          )
        ),
      transaction
        .select({
          itemPosition: saleReturnItems.itemPosition,
          restockedQuantity: saleReturnItems.restockedQuantity,
          returnedQuantity: saleReturnItems.returnedQuantity,
          saleId: saleReturnItems.saleId,
        })
        .from(saleReturnItems)
        .where(
          and(
            eq(saleReturnItems.organizationId, organization),
            inArray(saleReturnItems.saleId, ids)
          )
        ),
      transaction
        .select({ saleId: saleCancellations.saleId })
        .from(saleCancellations)
        .where(
          and(
            eq(saleCancellations.organizationId, organization),
            inArray(saleCancellations.saleId, ids)
          )
        ),
      transaction
        .select({ amount: expenses.amount, saleId: expenses.saleId })
        .from(expenses)
        .where(
          and(
            eq(expenses.organizationId, organization),
            isNull(expenses.voidedAt),
            isNotNull(expenses.saleId),
            inArray(expenses.saleId, ids)
          )
        ),
    ]);

  const itemsBySale = group(items, (row) => row.saleId);
  const adjustmentsBySale = group(adjustments, (row) => row.saleId);
  const paymentBySale = new Map(payments.map((row) => [row.saleId, row]));
  const returnsBySale = group(returnLines, (row) => row.saleId);
  const cancelledSales = new Set(cancelled.map((row) => row.saleId));
  const linkedBySale = group(linked, (row) => row.saleId as string);

  const facts: SaleFact[] = saleRows.map(({ id }) => {
    const payment = paymentBySale.get(id);
    return {
      adjustments: (adjustmentsBySale.get(id) ?? [])
        .filter((row) => ADJUSTMENT_KINDS.has(row.kind))
        .map(
          (row): SaleAdjustmentFact => ({
            amount: row.amount,
            kind: row.kind as SaleAdjustmentFact["kind"],
          })
        ),
      anticipationFee: payment?.anticipationFee ?? null,
      cancelled: cancelledSales.has(id),
      items: (itemsBySale.get(id) ?? []).map((row) => ({
        chargedUnitPrice: row.chargedUnitPrice,
        position: row.position,
        quantity: row.quantity,
        unitCost: row.unitCost,
      })),
      linkedExpenses: (linkedBySale.get(id) ?? []).map((row) => row.amount),
      processingFee: payment?.processingFee ?? null,
      returnLines: (returnsBySale.get(id) ?? []).map(
        (row): SaleReturnLineFact => ({
          itemPosition: row.itemPosition,
          restockedQuantity: row.restockedQuantity,
          returnedQuantity: row.returnedQuantity,
        })
      ),
    };
  });
  return { operatingExpenses, sales: facts };
}

/** The estimated result of a period: facts read from the database, calculated by the pure engine. */
export async function readPeriodResult(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  period: EconomicsPeriod
): Promise<PeriodResult> {
  const facts = await readPeriodFacts(transaction, identity, period);
  return periodResult(facts.sales, facts.operatingExpenses);
}
