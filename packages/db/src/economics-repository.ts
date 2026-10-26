import {
  type DailyEconomics,
  dailyEconomics,
  type OperatingExpenseFact,
  type ProductSales,
  topProducts,
} from "@polaris/domain/economics/period-series";
import {
  InvalidSaleFactError,
  periodResult,
  type PeriodResult,
  type SaleAdjustmentFact,
  type SaleFact,
  type SaleReturnLineFact,
  saleEconomics,
} from "@polaris/domain/economics/sale-economics";
import { isValidCalendarDate } from "@polaris/domain/inventory/calendar-date";
import { Money } from "@polaris/domain/money/money";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { expenses } from "./schema/expense";
import { products } from "./schema/product";
import { saleAdjustments, saleItems, salePayments, sales } from "./schema/sale";
import { saleCancellations } from "./schema/sale-cancellation";
import { saleReturnItems } from "./schema/sale-return";
import {
  TenantAuthorizationError,
  type TenantRequestIdentity,
  type TenantRequestTransaction,
} from "./tenant-transaction";

/**
 * Reading the economics of a period needs `report:read`; goals measure their
 * progress from the same result, so `goal:manage` may read it too (owner-only
 * in the V1).
 */
const REPORT_CAPABILITIES: readonly string[] = ["report:read", "goal:manage"];
/** A period of at most this many days (the sales of it are read into memory). */
export const MAX_ECONOMICS_PERIOD_DAYS = 366;

export class InvalidEconomicsPeriodError extends Error {
  readonly code = "invalid_economics_period";

  constructor() {
    super("invalid_economics_period");
    this.name = "InvalidEconomicsPeriodError";
  }
}

/** Reading a period needs one consistent snapshot of several tables. */
export class EconomicsSnapshotRequiredError extends Error {
  readonly code = "economics_snapshot_required";

  constructor() {
    super("economics_snapshot_required");
    this.name = "EconomicsSnapshotRequiredError";
  }
}

/** Sale IDs are bound in blocks of this size (PostgreSQL allows 65,535 parameters per statement). */
const SALE_ID_BLOCK = 5000;

/** Splits a list into consecutive blocks of at most `size`. */
export function inBlocks<T>(values: readonly T[], size: number): T[][] {
  const blocks: T[][] = [];
  for (let start = 0; start < values.length; start += size) {
    blocks.push(values.slice(start, start + size));
  }
  return blocks;
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

function assertPeriod(
  period: EconomicsPeriod,
  maxDays: number = MAX_ECONOMICS_PERIOD_DAYS
) {
  if (
    !(isValidCalendarDate(period.from) && isValidCalendarDate(period.to)) ||
    period.to < period.from ||
    daysBetween(period.from, period.to) + 1 > maxDays
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

type Reader = TenantRequestTransaction;

function readItems(transaction: Reader, organization: string, ids: string[]) {
  return transaction
    .select({
      chargedUnitPrice: saleItems.chargedUnitPrice,
      position: saleItems.position,
      productId: saleItems.productId,
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
    .orderBy(asc(saleItems.position));
}

function readAdjustments(
  transaction: Reader,
  organization: string,
  ids: string[]
) {
  return transaction
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
    );
}

function readPayments(
  transaction: Reader,
  organization: string,
  ids: string[]
) {
  return transaction
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
    );
}

function readReturnLines(
  transaction: Reader,
  organization: string,
  ids: string[]
) {
  return transaction
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
    );
}

function readCancellations(
  transaction: Reader,
  organization: string,
  ids: string[]
) {
  return transaction
    .select({ saleId: saleCancellations.saleId })
    .from(saleCancellations)
    .where(
      and(
        eq(saleCancellations.organizationId, organization),
        inArray(saleCancellations.saleId, ids)
      )
    );
}

function readLinkedExpenses(
  transaction: Reader,
  organization: string,
  ids: string[]
) {
  return transaction
    .select({ amount: expenses.amount, saleId: expenses.saleId })
    .from(expenses)
    .where(
      and(
        eq(expenses.organizationId, organization),
        isNull(expenses.voidedAt),
        isNotNull(expenses.saleId),
        inArray(expenses.saleId, ids)
      )
    );
}

export interface PeriodFacts {
  /** The amounts of the expenses with no sale (or tied to a cancelled one) of the period. */
  operatingExpenses: string[];
  /** The same expenses, in the same order, with the date of their competence. */
  operatingExpenseDays: OperatingExpenseFact[];
  /** How many rows each read brought, for the per-request record (counts only). */
  reads: PeriodReadCounts;
  /** Each sale carries its commercial date and each item its product. */
  sales: SaleFact[];
}

/** Rows read for a period, by table: what the database sent, never what they hold. */
export interface PeriodReadCounts {
  adjustments: number;
  cancellations: number;
  items: number;
  linkedExpenses: number;
  operatingExpenses: number;
  payments: number;
  returnLines: number;
  sales: number;
}

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
): Promise<PeriodFacts> {
  if (!REPORT_CAPABILITIES.includes(identity.capability)) {
    throw new TenantAuthorizationError("capability_denied");
  }
  assertPeriod(period);
  const organization = identity.organizationId;
  const isolation = await transaction.execute(
    sql`SELECT current_setting('transaction_isolation') AS level`
  );
  if (
    (isolation.rows[0] as { level?: string } | undefined)?.level !==
    "repeatable read"
  ) {
    // eight queries over several tables must see one moment, not eight
    throw new EconomicsSnapshotRequiredError();
  }

  const saleRows = await transaction
    .select({ id: sales.id, occurredOn: sales.occurredOn })
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
    .select({ amount: expenses.amount, competenceOn: expenses.competenceOn })
    .from(expenses)
    .where(
      and(
        eq(expenses.organizationId, organization),
        isNull(expenses.voidedAt),
        // an expense with no sale, or tied to a sale that was cancelled: the
        // cost was real and the sale's margin no longer exists to carry it
        sql`(${expenses.saleId} IS NULL OR EXISTS (
          SELECT 1 FROM ${saleCancellations} AS cancelled_sale
          WHERE cancelled_sale.organization_id = ${expenses.organizationId}
            AND cancelled_sale.sale_id = ${expenses.saleId}
        ))`,
        sql`${expenses.competenceOn} >= ${period.from}::date`,
        sql`${expenses.competenceOn} <= ${period.to}::date`
      )
    );
  const operatingExpenses = operatingRows.map((row) => row.amount);
  const operatingExpenseDays = operatingRows.map(
    (row): OperatingExpenseFact => ({
      amount: row.amount,
      competenceOn: row.competenceOn,
    })
  );
  const reads: PeriodReadCounts = {
    adjustments: 0,
    cancellations: 0,
    items: 0,
    linkedExpenses: 0,
    operatingExpenses: operatingRows.length,
    payments: 0,
    returnLines: 0,
    sales: saleRows.length,
  };
  if (saleRows.length === 0) {
    return { operatingExpenseDays, operatingExpenses, reads, sales: [] };
  }
  const ids = saleRows.map((row) => row.id);

  const items: Awaited<ReturnType<typeof readItems>> = [];
  const adjustments: Awaited<ReturnType<typeof readAdjustments>> = [];
  const payments: Awaited<ReturnType<typeof readPayments>> = [];
  const returnLines: Awaited<ReturnType<typeof readReturnLines>> = [];
  const cancelled: Awaited<ReturnType<typeof readCancellations>> = [];
  const linked: Awaited<ReturnType<typeof readLinkedExpenses>> = [];
  for (const block of inBlocks(ids, SALE_ID_BLOCK)) {
    // biome-ignore lint/performance/noAwaitInLoops: one block of IDs at a time keeps each statement under the parameter limit
    const [i, a, p, r, c, l] = await Promise.all([
      readItems(transaction, organization, block),
      readAdjustments(transaction, organization, block),
      readPayments(transaction, organization, block),
      readReturnLines(transaction, organization, block),
      readCancellations(transaction, organization, block),
      readLinkedExpenses(transaction, organization, block),
    ]);
    items.push(...i);
    adjustments.push(...a);
    payments.push(...p);
    returnLines.push(...r);
    cancelled.push(...c);
    linked.push(...l);
  }
  reads.adjustments = adjustments.length;
  reads.cancellations = cancelled.length;
  reads.items = items.length;
  reads.linkedExpenses = linked.length;
  reads.payments = payments.length;
  reads.returnLines = returnLines.length;

  const itemsBySale = group(items, (row) => row.saleId);
  const adjustmentsBySale = group(adjustments, (row) => row.saleId);
  const paymentBySale = new Map(payments.map((row) => [row.saleId, row]));
  const returnsBySale = group(returnLines, (row) => row.saleId);
  const cancelledSales = new Set(cancelled.map((row) => row.saleId));
  const linkedBySale = group(linked, (row) => row.saleId as string);

  const facts: SaleFact[] = saleRows.map(({ id, occurredOn }) => {
    const payment = paymentBySale.get(id);
    return {
      adjustments: (adjustmentsBySale.get(id) ?? []).map(
        (row): SaleAdjustmentFact => {
          if (!ADJUSTMENT_KINDS.has(row.kind)) {
            // a new kind must be given a place in the chain, not vanish from it
            throw new InvalidSaleFactError();
          }
          return {
            amount: row.amount,
            kind: row.kind as SaleAdjustmentFact["kind"],
          };
        }
      ),
      anticipationFee: payment?.anticipationFee ?? null,
      cancelled: cancelledSales.has(id),
      items: (itemsBySale.get(id) ?? []).map((row) => ({
        chargedUnitPrice: row.chargedUnitPrice,
        position: row.position,
        productId: row.productId,
        quantity: row.quantity,
        unitCost: row.unitCost,
      })),
      linkedExpenses: (linkedBySale.get(id) ?? []).map((row) => row.amount),
      occurredOn,
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
  return { operatingExpenseDays, operatingExpenses, reads, sales: facts };
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

/** At most this many products are ranked in a summary. */
export const MAX_TOP_PRODUCTS = 10;

export class InvalidTopProductsError extends Error {
  readonly code = "invalid_top_products";

  constructor() {
    super("invalid_top_products");
    this.name = "InvalidTopProductsError";
  }
}

export interface TopProduct extends ProductSales {
  /** The product was deleted after it sold: shown without a link. */
  deleted: boolean;
  /** The product's current name. */
  name: string;
}

export interface PeriodSummaryRead {
  /** One entry per date of the period, in order, with its costs and result (ADR 0056, D2). */
  daily: DailyEconomics[];
  /** Rows read, by table, plus the product names when ranked. */
  reads: PeriodReadCounts & { products: number };
  result: PeriodResult;
  /** Present only when asked for. */
  topProducts?: TopProduct[];
}

/**
 * The result of a period with its daily series and, when asked, its most sold
 * products: one read of the facts, the engine run once per sale, and the
 * names of the ranked products read in the same snapshot, scoped to the
 * organization (a product deleted since keeps its name and says so).
 */
export async function readPeriodSummary(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  period: EconomicsPeriod,
  options: { topProducts?: number | undefined } = {}
): Promise<PeriodSummaryRead> {
  const limit = options.topProducts;
  if (
    limit !== undefined &&
    !(Number.isInteger(limit) && limit >= 1 && limit <= MAX_TOP_PRODUCTS)
  ) {
    throw new InvalidTopProductsError();
  }
  const facts = await readPeriodFacts(transaction, identity, period);
  const economics = facts.sales.map(saleEconomics);
  const result = periodResult(facts.sales, facts.operatingExpenses, economics);
  const daily = dailyEconomics(
    facts.sales,
    facts.operatingExpenseDays,
    period.from,
    period.to,
    economics
  );
  if (limit === undefined) {
    return { daily, reads: { ...facts.reads, products: 0 }, result };
  }
  const ranked = topProducts(facts.sales, limit);
  const named =
    ranked.length === 0
      ? []
      : await transaction
          .select({
            deletedAt: products.deletedAt,
            id: products.id,
            name: products.name,
          })
          .from(products)
          .where(
            and(
              eq(products.organizationId, identity.organizationId),
              inArray(
                products.id,
                ranked.map((entry) => entry.productId)
              )
            )
          );
  const byId = new Map(named.map((row) => [row.id, row]));
  return {
    daily,
    reads: { ...facts.reads, products: named.length },
    result,
    topProducts: ranked.map((entry) => {
      const product = byId.get(entry.productId);
      if (!product) {
        // the sale item references the product by a foreign key of the same organization
        throw new InvalidSaleFactError();
      }
      return {
        ...entry,
        deleted: product.deletedAt !== null,
        name: product.name,
      };
    }),
  };
}

/** The longest period of the daily sales series: 182 days, half a year of the Início's map. */
export const MAX_DAILY_SALES_DAYS = 182;

/**
 * Net sales and the count of sales of each date of a period, aggregated by the
 * database: one row per date, in order, a date without sales `0` and `0`. The
 * rule is the engine's `netSales` (`saleEconomics`), written in SQL so that no
 * sale goes through the engine in the Worker:
 * - a cancelled sale is left out (zero and not counted);
 * - net sales are the item values minus the discount adjustments minus what the
 *   returns gave back, on the date of the sale;
 * - a returned item gives back its charged price times the units returned
 *   minus its share of the discounts, `round half up (allocation x returned /
 *   quantity)`, where the allocation splits the discount among the items of the
 *   sale by value in whole cents (largest remainder, ties by position).
 * The amounts are in cents. The gate `daily-sales` proves this equals
 * `readPeriodSummary(...).daily` date by date.
 */
export function dailySalesQuery(organization: string, period: EconomicsPeriod) {
  return sql`
    WITH counted AS (
      SELECT sale.id, sale.occurred_on
      FROM public.sales AS sale
      WHERE sale.organization_id = ${organization}
        AND sale.occurred_on >= ${period.from}::date
        AND sale.occurred_on <= ${period.to}::date
        AND NOT EXISTS (
          SELECT 1 FROM public.sale_cancellations AS cancelled
          WHERE cancelled.organization_id = sale.organization_id
            AND cancelled.sale_id = sale.id
        )
    ),
    line AS (
      SELECT item.sale_id, item.position, item.quantity,
        item.charged_unit_price * 100 AS unit_cents,
        item.charged_unit_price * item.quantity * 100 AS value_cents
      FROM public.sale_items AS item
      JOIN counted ON counted.id = item.sale_id
      WHERE item.organization_id = ${organization}
    ),
    gross AS (
      SELECT line.sale_id, sum(line.value_cents) AS cents
      FROM line
      GROUP BY line.sale_id
    ),
    discount AS (
      SELECT adjustment.sale_id, sum(adjustment.amount * 100) AS cents
      FROM public.sale_adjustments AS adjustment
      JOIN counted ON counted.id = adjustment.sale_id
      WHERE adjustment.organization_id = ${organization}
        AND adjustment.kind = 'discount'
      GROUP BY adjustment.sale_id
    ),
    returned AS (
      SELECT return_item.sale_id, return_item.item_position AS position,
        sum(return_item.returned_quantity) AS quantity
      FROM public.sale_return_items AS return_item
      JOIN counted ON counted.id = return_item.sale_id
      WHERE return_item.organization_id = ${organization}
      GROUP BY return_item.sale_id, return_item.item_position
    ),
    allocation AS (
      -- the discount split by value, only for the sales with a return
      SELECT split.sale_id, split.position,
        split.floor_cents
          + CASE WHEN split.rank <= split.leftover THEN 1 ELSE 0 END AS cents
      FROM (
        SELECT line.sale_id, line.position,
          div(discount.cents * line.value_cents, gross.cents) AS floor_cents,
          discount.cents - sum(div(discount.cents * line.value_cents, gross.cents))
            OVER (PARTITION BY line.sale_id) AS leftover,
          row_number() OVER (
            PARTITION BY line.sale_id
            ORDER BY mod(discount.cents * line.value_cents, gross.cents) DESC,
              line.position
          ) AS rank
        FROM line
        JOIN discount ON discount.sale_id = line.sale_id
        JOIN gross ON gross.sale_id = line.sale_id
        WHERE gross.cents <> 0
          AND discount.cents <> 0
          AND EXISTS (SELECT 1 FROM returned WHERE returned.sale_id = line.sale_id)
      ) AS split
    ),
    given_back AS (
      SELECT returned.sale_id,
        sum(
          returned.quantity * line.unit_cents
          - div(
              coalesce(allocation.cents, 0) * returned.quantity * 2 + line.quantity,
              line.quantity::numeric * 2
            )
        ) AS cents
      FROM returned
      JOIN line ON line.sale_id = returned.sale_id
        AND line.position = returned.position
      LEFT JOIN allocation ON allocation.sale_id = returned.sale_id
        AND allocation.position = returned.position
      GROUP BY returned.sale_id
    ),
    per_day AS (
      SELECT counted.occurred_on, count(*) AS sales,
        sum(
          coalesce(gross.cents, 0)
          - coalesce(discount.cents, 0)
          - coalesce(given_back.cents, 0)
        ) AS net_cents
      FROM counted
      LEFT JOIN gross ON gross.sale_id = counted.id
      LEFT JOIN discount ON discount.sale_id = counted.id
      LEFT JOIN given_back ON given_back.sale_id = counted.id
      GROUP BY counted.occurred_on
    )
    SELECT to_char(series.day, 'YYYY-MM-DD') AS date,
      coalesce(per_day.sales, 0)::integer AS count,
      round(coalesce(per_day.net_cents, 0), 0)::text AS net_cents
    FROM generate_series(
      ${period.from}::date::timestamp,
      ${period.to}::date::timestamp,
      interval '1 day'
    ) AS series (day)
    LEFT JOIN per_day ON per_day.occurred_on = series.day::date
    ORDER BY series.day`;
}

export interface DailySalesRead {
  /** Sales counted (confirmed, not cancelled) of each date, from the first. */
  count: number[];
  /** The first date of the series, `YYYY-MM-DD`. */
  from: string;
  /** Net sales of each date, exact BRL text, in the same order. */
  net: string[];
}

/**
 * The daily series of a period of at most `MAX_DAILY_SALES_DAYS` dates, read
 * in one statement (one snapshot) with the same permission as the period
 * summary. Scoped by the organization of the server context and by RLS.
 */
export async function readDailySales(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  period: EconomicsPeriod
): Promise<DailySalesRead> {
  if (!REPORT_CAPABILITIES.includes(identity.capability)) {
    throw new TenantAuthorizationError("capability_denied");
  }
  assertPeriod(period, MAX_DAILY_SALES_DAYS);
  const result = await transaction.execute(
    dailySalesQuery(identity.organizationId, period)
  );
  const rows = result.rows as {
    count: number;
    date: string;
    net_cents: string;
  }[];
  if (
    rows.length !== daysBetween(period.from, period.to) + 1 ||
    rows[0]?.date !== period.from
  ) {
    throw new InvalidSaleFactError();
  }
  return {
    count: rows.map((row) => Number(row.count)),
    from: period.from,
    net: rows.map((row) =>
      Money.fromMinorUnits(BigInt(row.net_cents)).toString()
    ),
  };
}
