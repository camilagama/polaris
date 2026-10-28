import type {
  DailyEconomics,
  OperatingExpenseFact,
  ProductSales,
} from "@polaris/domain/economics/period-series";
import {
  InvalidSaleFactError,
  type PeriodResult,
  periodResult,
  type SaleAdjustmentFact,
  type SaleFact,
  type SaleReturnLineFact,
} from "@polaris/domain/economics/sale-economics";
import { isValidCalendarDate } from "@polaris/domain/inventory/calendar-date";
import { Money } from "@polaris/domain/money/money";
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

/** Several statements over several tables must see one moment, not one each. */
async function assertSnapshot(transaction: TenantRequestTransaction) {
  const isolation = await transaction.execute(
    sql`SELECT current_setting('transaction_isolation') AS level`
  );
  if (
    (isolation.rows[0] as { level?: string } | undefined)?.level !==
    "repeatable read"
  ) {
    throw new EconomicsSnapshotRequiredError();
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
  /** The same expenses, in the same order, with the date of their competence. */
  operatingExpenseDays: OperatingExpenseFact[];
  /** The amounts of the expenses with no sale (or tied to a cancelled one) of the period. */
  operatingExpenses: string[];
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
 * The sales of a period of the organization's calendar, by commercial date. Apart so that the gate `daily-sales` can
 * EXPLAIN this very statement and prove it reads `sales` by the (organization_id, occurred_on) index.
 */
export function periodSalesSelect(
  transaction: TenantRequestTransaction,
  organization: string,
  period: EconomicsPeriod
) {
  return transaction
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
  await assertSnapshot(transaction);

  const saleRows = await periodSalesSelect(transaction, organization, period);
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

/** Rows the database sent for a summary: what it read was aggregated by the database itself. */
export interface PeriodSummaryReadCounts {
  /** One row per date of the period. */
  days: number;
  /** One row per ranked product (0 without a ranking). */
  products: number;
}

export interface PeriodSummaryRead {
  /** One entry per date of the period, in order, with its costs and result (ADR 0056, D2). */
  daily: DailyEconomics[];
  reads: PeriodSummaryReadCounts;
  result: PeriodResult;
  /** Present only when asked for. */
  topProducts?: TopProduct[];
}

/*
 * The rules of the engine (`saleEconomics`, ADR 0053) written in SQL, in pieces
 * shared by the statements that aggregate a period in the database, so that no
 * sale goes through the engine in the Worker. Every amount is in cents. The
 * engine stays the definition: the gates `daily-sales` and
 * `period-summary-sql` prove each statement equals it, and a change to a rule
 * of the engine changes these pieces in the same pull request.
 */

/**
 * The sales of the period that count: confirmed and not cancelled, by
 * commercial date. `OFFSET 0` keeps the test of the cancellation a probe of its
 * unique index per sale: turned into a join, an estimate of the sales of the
 * period far below the real one (a large organization among many small ones)
 * made the planner compare every sale with every cancellation of the store.
 */
function countedCte(organization: string, period: EconomicsPeriod) {
  return sql`counted AS (
      SELECT sale.id, sale.occurred_on
      FROM public.sales AS sale
      WHERE sale.organization_id = ${organization}
        AND sale.occurred_on >= ${period.from}::date
        AND sale.occurred_on <= ${period.to}::date
        AND NOT EXISTS (
          SELECT 1 FROM public.sale_cancellations AS cancelled
          WHERE cancelled.organization_id = sale.organization_id
            AND cancelled.sale_id = sale.id
          OFFSET 0
        )
    )`;
}

/** The items of the counted sales, with their value. */
function lineCte(organization: string) {
  return sql`line AS (
      SELECT item.sale_id, item.position, item.quantity, item.product_id, item.unit_cost,
        item.charged_unit_price * 100 AS unit_cents,
        item.charged_unit_price * item.quantity * 100 AS value_cents
      FROM public.sale_items AS item
      JOIN counted ON counted.id = item.sale_id
      WHERE item.organization_id = ${organization}
    )`;
}

/**
 * Gross sales of each sale, with its item lines, its units, the lines of
 * unknown cost and the exact cost of the lines of known cost (six places).
 */
const grossCte = sql`gross AS (
      SELECT line.sale_id, sum(line.value_cents) AS cents, count(*) AS lines,
        sum(line.quantity) AS units,
        count(*) FILTER (WHERE line.unit_cost IS NULL) AS unknown_cost,
        sum(line.unit_cost * line.quantity) AS cost
      FROM line
      GROUP BY line.sale_id
    )`;

/**
 * The adjustments of each sale in one pass: its discounts, its additions
 * (surcharge, freight and payment surcharge, never given back) and how many
 * are of a kind the chain does not know.
 */
function adjustmentCte(organization: string) {
  return sql`adjustment AS (
      SELECT adjustment.sale_id,
        sum(adjustment.amount * 100) FILTER (
          WHERE adjustment.kind = 'discount'
        ) AS discount_cents,
        sum(adjustment.amount * 100) FILTER (
          WHERE adjustment.kind IN ('freight', 'payment_surcharge', 'surcharge')
        ) AS addition_cents,
        count(*) FILTER (
          WHERE adjustment.kind NOT IN ('discount', 'freight', 'payment_surcharge', 'surcharge')
        ) AS unknown_kinds
      FROM public.sale_adjustments AS adjustment
      JOIN counted ON counted.id = adjustment.sale_id
      WHERE adjustment.organization_id = ${organization}
      GROUP BY adjustment.sale_id
    )`;
}

/** The units returned (and restocked) of each item, every return of it together. */
function returnedCte(organization: string) {
  return sql`returned AS (
      SELECT return_item.sale_id, return_item.item_position AS position,
        sum(return_item.returned_quantity) AS quantity,
        sum(return_item.restocked_quantity) AS restocked
      FROM public.sale_return_items AS return_item
      JOIN counted ON counted.id = return_item.sale_id
      WHERE return_item.organization_id = ${organization}
      GROUP BY return_item.sale_id, return_item.item_position
    )`;
}

/**
 * The discount of a sale split among its items by value in whole cents that add
 * up to it (largest remainder, ties by position). Only the sales with a return
 * need it for the chain; the ranking needs it for every discounted sale.
 */
function allocationCte(scope: "every_sale" | "returned_sales") {
  const returnedOnly =
    scope === "returned_sales"
      ? sql`AND EXISTS (SELECT 1 FROM returned WHERE returned.sale_id = line.sale_id)`
      : sql``;
  return sql`allocation AS (
      SELECT split.sale_id, split.position,
        split.floor_cents
          + CASE WHEN split.rank <= split.leftover THEN 1 ELSE 0 END AS cents
      FROM (
        SELECT line.sale_id, line.position,
          div(adjustment.discount_cents * line.value_cents, gross.cents) AS floor_cents,
          adjustment.discount_cents
            - sum(div(adjustment.discount_cents * line.value_cents, gross.cents))
            OVER (PARTITION BY line.sale_id) AS leftover,
          row_number() OVER (
            PARTITION BY line.sale_id
            ORDER BY mod(adjustment.discount_cents * line.value_cents, gross.cents) DESC,
              line.position
          ) AS rank
        FROM line
        JOIN adjustment ON adjustment.sale_id = line.sale_id
        JOIN gross ON gross.sale_id = line.sale_id
        WHERE gross.cents <> 0
          AND adjustment.discount_cents <> 0
          ${returnedOnly}
      ) AS split
    )`;
}

/**
 * What each returned item gives back: its charged price times the units
 * returned minus its share of the discounts, `round half up (allocation x
 * returned / quantity)`. `line` is null for a return of an item the sale does
 * not have (refused as an invalid fact).
 */
const givenBackCte = sql`given_back AS (
      SELECT returned.sale_id, returned.position, returned.quantity, returned.restocked,
        line.quantity AS sold, line.unit_cost,
        returned.quantity * line.unit_cents
          - div(
              coalesce(allocation.cents, 0) * returned.quantity * 2 + line.quantity,
              line.quantity::numeric * 2
            ) AS cents
      FROM returned
      LEFT JOIN line ON line.sale_id = returned.sale_id
        AND line.position = returned.position
      LEFT JOIN allocation ON allocation.sale_id = returned.sale_id
        AND allocation.position = returned.position
    )`;

/** The dates of the period, in order. */
function seriesOf(period: EconomicsPeriod) {
  return sql`generate_series(
      ${period.from}::date::timestamp,
      ${period.to}::date::timestamp,
      interval '1 day'
    ) AS series (day)`;
}

/**
 * The economics of a period of the organization's calendar aggregated by the
 * database: one row per date, in order, with the parts of the chain of the
 * sales of that date (`saleEconomics` summed), the counts the quality account
 * needs, and the expenses with no sale (or tied to a cancelled one) whose
 * competence is that date. A cancelled sale is left out; an unknown cost or
 * fee is left out of the amount and counted; the cost of the goods is the
 * exact cost of the items minus the restocked units, rounded half up once per
 * sale; surcharges, freight and the payment surcharge are never given back;
 * an adjustment of a kind the chain does not know, or a return the items do
 * not hold, is counted in `invalid`.
 *
 * With `topProducts`, the first date also carries the ranking of the period
 * (`rankingCtes`) as JSON text, so that the items are read once for both.
 */
export function periodSummaryQuery(
  organization: string,
  period: EconomicsPeriod,
  topProducts?: number
) {
  const ranking = topProducts !== undefined;
  return sql`
    WITH ${countedCte(organization, period)},
    ${lineCte(organization)},
    ${grossCte},
    ${adjustmentCte(organization)},
    ${returnedCte(organization)},
    ${allocationCte(ranking ? "every_sale" : "returned_sales")},
    ${givenBackCte},
    given_back_by_sale AS (
      SELECT given_back.sale_id, sum(given_back.cents) AS cents,
        sum(given_back.quantity) AS units,
        sum(given_back.unit_cost * given_back.restocked) AS restocked_cost,
        count(*) FILTER (
          WHERE given_back.sold IS NULL OR given_back.quantity > given_back.sold
        ) AS invalid
      FROM given_back
      GROUP BY given_back.sale_id
    ),
    linked AS (
      SELECT expense.sale_id, sum(expense.amount * 100) AS cents, count(*) AS count
      FROM public.expenses AS expense
      JOIN counted ON counted.id = expense.sale_id
      WHERE expense.organization_id = ${organization}
        AND expense.voided_at IS NULL
      GROUP BY expense.sale_id
    ),
    per_sale AS (
      SELECT counted.occurred_on,
        coalesce(gross.cents, 0) AS gross,
        coalesce(adjustment.discount_cents, 0) AS discounts,
        coalesce(given_back_by_sale.cents, 0) AS returns,
        round(coalesce(gross.cost, 0) - coalesce(given_back_by_sale.restocked_cost, 0), 2) * 100 AS cogs,
        coalesce(adjustment.addition_cents, 0) AS surcharges,
        coalesce(payment.processing_fee_amount_snapshot * 100, 0) AS processing,
        coalesce(payment.anticipation_fee_amount_snapshot * 100, 0) AS anticipation,
        coalesce(linked.cents, 0) AS linked,
        coalesce(linked.count, 0) AS linked_count,
        coalesce(gross.lines, 0) AS lines,
        coalesce(gross.units, 0) - coalesce(given_back_by_sale.units, 0) AS units,
        coalesce(gross.unknown_cost, 0) AS unknown_cost,
        payment.processing_fee_amount_snapshot IS NULL AS unknown_processing,
        payment.anticipation_fee_amount_snapshot IS NULL AS unknown_anticipation,
        coalesce(adjustment.unknown_kinds, 0) + coalesce(given_back_by_sale.invalid, 0) AS invalid
      FROM counted
      LEFT JOIN gross ON gross.sale_id = counted.id
      LEFT JOIN adjustment ON adjustment.sale_id = counted.id
      LEFT JOIN given_back_by_sale ON given_back_by_sale.sale_id = counted.id
      LEFT JOIN linked ON linked.sale_id = counted.id
      LEFT JOIN public.sale_payments AS payment
        ON payment.organization_id = ${organization}
        AND payment.sale_id = counted.id
    ),
    per_day AS (
      SELECT per_sale.occurred_on, count(*) AS sales,
        sum(per_sale.gross) AS gross, sum(per_sale.discounts) AS discounts,
        sum(per_sale.returns) AS returns, sum(per_sale.cogs) AS cogs,
        sum(per_sale.surcharges) AS surcharges, sum(per_sale.processing) AS processing,
        sum(per_sale.anticipation) AS anticipation, sum(per_sale.linked) AS linked,
        sum(per_sale.linked_count) AS linked_count, sum(per_sale.lines) AS lines,
        sum(per_sale.units) AS units, sum(per_sale.unknown_cost) AS unknown_cost,
        count(*) FILTER (WHERE per_sale.unknown_processing) AS unknown_processing,
        count(*) FILTER (WHERE per_sale.unknown_anticipation) AS unknown_anticipation,
        count(*) FILTER (
          WHERE per_sale.unknown_cost > 0 OR per_sale.unknown_processing
            OR per_sale.unknown_anticipation
        ) AS unknown_sales,
        sum(per_sale.invalid) AS invalid
      FROM per_sale
      GROUP BY per_sale.occurred_on
    ),
    operating AS (
      -- an expense with no sale, or tied to a sale that was cancelled: the
      -- cost was real and the sale's margin no longer exists to carry it
      SELECT expense.competence_on, sum(expense.amount * 100) AS cents, count(*) AS count
      FROM public.expenses AS expense
      WHERE expense.organization_id = ${organization}
        AND expense.voided_at IS NULL
        AND (expense.sale_id IS NULL OR EXISTS (
          SELECT 1 FROM public.sale_cancellations AS cancelled_sale
          WHERE cancelled_sale.organization_id = expense.organization_id
            AND cancelled_sale.sale_id = expense.sale_id
        ))
        AND expense.competence_on >= ${period.from}::date
        AND expense.competence_on <= ${period.to}::date
      GROUP BY expense.competence_on
    )${
      ranking
        ? sql`,
    ${rankingCtes(organization, topProducts)}`
        : sql``
    }
    SELECT to_char(series.day, 'YYYY-MM-DD') AS date,
      coalesce(per_day.sales, 0)::integer AS sales,
      round(coalesce(per_day.gross, 0), 0)::text AS gross,
      round(coalesce(per_day.discounts, 0), 0)::text AS discounts,
      round(coalesce(per_day.returns, 0), 0)::text AS returns,
      round(coalesce(per_day.cogs, 0), 0)::text AS cogs,
      round(coalesce(per_day.surcharges, 0), 0)::text AS surcharges,
      round(coalesce(per_day.processing, 0), 0)::text AS processing,
      round(coalesce(per_day.anticipation, 0), 0)::text AS anticipation,
      round(coalesce(per_day.linked, 0), 0)::text AS linked,
      coalesce(per_day.linked_count, 0)::integer AS linked_count,
      coalesce(per_day.lines, 0)::integer AS lines,
      coalesce(per_day.units, 0)::integer AS units,
      coalesce(per_day.unknown_cost, 0)::integer AS unknown_cost,
      coalesce(per_day.unknown_processing, 0)::integer AS unknown_processing,
      coalesce(per_day.unknown_anticipation, 0)::integer AS unknown_anticipation,
      coalesce(per_day.unknown_sales, 0)::integer AS unknown_sales,
      coalesce(per_day.invalid, 0)::integer AS invalid,
      round(coalesce(operating.cents, 0), 0)::text AS operating,
      coalesce(operating.count, 0)::integer AS operating_count${
        ranking
          ? sql`,
      CASE WHEN series.day = ${period.from}::date THEN (
        SELECT coalesce(json_agg(json_build_object(
            'deleted', top.deleted,
            'name', top.name,
            'netCents', round(top.net_cents, 0)::text,
            'productId', top.product_id::text,
            'quantity', top.units::integer
          ) ORDER BY top.rank), '[]'::json)::text
        FROM top
      ) END AS top_products`
          : sql``
      }
    FROM ${seriesOf(period)}
    LEFT JOIN per_day ON per_day.occurred_on = series.day::date
    LEFT JOIN operating ON operating.competence_on = series.day::date
    ORDER BY series.day`;
}

/**
 * The `limit` most sold products of the counted sales of a period, by units
 * net of returns, then by net sales, then by product ID (`topProducts`): each
 * item's net sales are its value minus its share of the discounts (the
 * allocation of every discounted sale) minus what its returns gave back. A
 * product whose units all came back is left out. With the product's current
 * name, scoped to the organization.
 */
function rankingCtes(organization: string, limit: number) {
  return sql`ranked AS (
      SELECT line.product_id,
        sum(line.quantity - coalesce(given_back.quantity, 0)) AS units,
        sum(
          line.value_cents - coalesce(allocation.cents, 0) - coalesce(given_back.cents, 0)
        ) AS net_cents
      FROM line
      LEFT JOIN allocation ON allocation.sale_id = line.sale_id
        AND allocation.position = line.position
      LEFT JOIN given_back ON given_back.sale_id = line.sale_id
        AND given_back.position = line.position
      GROUP BY line.product_id
    ),
    top AS (
      SELECT ranked.product_id, ranked.units, ranked.net_cents, product.name,
        product.deleted_at IS NOT NULL AS deleted,
        row_number() OVER (
          ORDER BY ranked.units DESC, ranked.net_cents DESC,
            ranked.product_id::text COLLATE "C"
        ) AS rank
      FROM ranked
      LEFT JOIN public.products AS product
        ON product.organization_id = ${organization}
        AND product.id = ranked.product_id
      WHERE ranked.units > 0
      ORDER BY rank
      LIMIT ${limit}
    )`;
}

interface SummaryDayRow {
  anticipation: string;
  cogs: string;
  date: string;
  discounts: string;
  gross: string;
  invalid: number;
  lines: number;
  linked: string;
  linked_count: number;
  operating: string;
  operating_count: number;
  processing: string;
  returns: string;
  sales: number;
  surcharges: string;
  /** Only with a ranking, and only on the first date. */
  top_products?: string | null;
  units: number;
  unknown_anticipation: number;
  unknown_cost: number;
  unknown_processing: number;
  unknown_sales: number;
}

/** An entry of `top_products`, the JSON text of the ranking on the first date. */
interface RankedProduct {
  deleted: boolean | null;
  name: string | null;
  netCents: string;
  productId: string;
  quantity: number;
}

const brl = (cents: bigint) => Money.fromMinorUnits(cents).toString();

/** The amounts of a day's row, in cents, and the result of the chain. */
function centsOf(row: SummaryDayRow) {
  const cents = {
    anticipation: BigInt(row.anticipation),
    cogs: BigInt(row.cogs),
    discounts: BigInt(row.discounts),
    gross: BigInt(row.gross),
    linked: BigInt(row.linked),
    operating: BigInt(row.operating),
    processing: BigInt(row.processing),
    returns: BigInt(row.returns),
    surcharges: BigInt(row.surcharges),
  };
  const net = cents.gross - cents.discounts - cents.returns;
  const margin =
    net -
    cents.cogs +
    cents.surcharges -
    cents.processing -
    cents.anticipation -
    cents.linked;
  return { ...cents, margin, net };
}

type DayCents = ReturnType<typeof centsOf>;

/** A date of the series as `dailyEconomics` says it: costs and result are null when an input of a sale is unknown. */
function dayOf(row: SummaryDayRow, cents: DayCents): DailyEconomics {
  const known = row.unknown_sales === 0;
  // built as `dailyEconomics` builds it: the order of the keys is part of the bytes of the answer
  const ofDate = {
    date: row.date,
    netSales: brl(cents.net),
    salesCount: row.sales,
  };
  return {
    ...ofDate,
    costs: known
      ? brl(cents.net + cents.surcharges - cents.margin + cents.operating)
      : null,
    operatingExpenses: brl(cents.operating),
    operatingResult: known ? brl(cents.margin - cents.operating) : null,
  };
}

/** The period as `periodResult` says it: the dates added up. */
function resultOf(rows: readonly SummaryDayRow[], days: readonly DayCents[]) {
  const total = (part: keyof DayCents) =>
    days.reduce((sum, day) => sum + day[part], 0n);
  const count = (field: keyof SummaryDayRow) =>
    rows.reduce((sum, row) => sum + (row[field] as number), 0);
  const margin = total("margin");
  const operating = total("operating");
  const result: PeriodResult = {
    anticipationFees: brl(total("anticipation")),
    cogs: brl(total("cogs")),
    commercialSurcharges: brl(total("surcharges")),
    contributionMargin: brl(margin),
    discounts: brl(total("discounts")),
    estimatedOperatingResult: brl(margin - operating),
    grossProfit: brl(total("net") - total("cogs")),
    grossSales: brl(total("gross")),
    itemLines: count("lines"),
    linkedExpenseCount: count("linked_count"),
    linkedExpenses: brl(total("linked")),
    netSales: brl(total("net")),
    operatingExpenseCount: count("operating_count"),
    operatingExpenses: brl(operating),
    processingFees: brl(total("processing")),
    returns: brl(total("returns")),
    salesCount: count("sales"),
    unitsSold: count("units"),
    unknown: {
      anticipationFees: count("unknown_anticipation"),
      costItems: count("unknown_cost"),
      processingFees: count("unknown_processing"),
    },
  };
  return result;
}

function rankedOf(text: string | null | undefined): TopProduct[] {
  if (typeof text !== "string") {
    throw new InvalidSaleFactError();
  }
  return (JSON.parse(text) as RankedProduct[]).map((entry) => {
    if (entry.name === null) {
      // the sale item references the product by a foreign key of the same organization
      throw new InvalidSaleFactError();
    }
    return {
      deleted: entry.deleted === true,
      name: entry.name,
      netSales: brl(BigInt(entry.netCents)),
      productId: entry.productId,
      quantity: entry.quantity,
    };
  });
}

/**
 * The result of a period with its daily series and, when asked, its most sold
 * products, aggregated by the database in one statement
 * (`periodSummaryQuery`, so one snapshot at any isolation level): the Worker
 * only adds up one row per date, so its work does not grow with the sales. The same result as the
 * engine over `readPeriodFacts` (ADR 0054), scoped by the organization of the
 * server context and by RLS.
 */
export async function readPeriodSummary(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  period: EconomicsPeriod,
  options: { topProducts?: number | undefined } = {}
): Promise<PeriodSummaryRead> {
  if (!REPORT_CAPABILITIES.includes(identity.capability)) {
    throw new TenantAuthorizationError("capability_denied");
  }
  const limit = options.topProducts;
  if (
    limit !== undefined &&
    !(Number.isInteger(limit) && limit >= 1 && limit <= MAX_TOP_PRODUCTS)
  ) {
    throw new InvalidTopProductsError();
  }
  assertPeriod(period);
  const read = await transaction.execute(
    periodSummaryQuery(identity.organizationId, period, limit)
  );
  const rows = read.rows as unknown as SummaryDayRow[];
  if (
    rows.length !== daysBetween(period.from, period.to) + 1 ||
    rows[0]?.date !== period.from ||
    rows.some((row) => row.invalid > 0)
  ) {
    throw new InvalidSaleFactError();
  }
  const days = rows.map(centsOf);
  const daily = rows.map((row, index) => dayOf(row, days[index] as DayCents));
  const result = resultOf(rows, days);
  if (limit === undefined) {
    return { daily, reads: { days: rows.length, products: 0 }, result };
  }
  const ranked = rankedOf(rows[0]?.top_products);
  return {
    daily,
    reads: { days: rows.length, products: ranked.length },
    result,
    topProducts: ranked,
  };
}

/** The longest period of the daily sales series: 182 days, half a year of the Início's map. */
export const MAX_DAILY_SALES_DAYS = 182;

/**
 * Net sales and the count of sales of each date of a period, aggregated by the
 * database: one row per date, in order, a date without sales `0` and `0`. The
 * rule is the engine's `netSales` (`saleEconomics`), with the pieces of
 * `periodSummaryQuery`:
 * - a cancelled sale is left out (zero and not counted);
 * - net sales are the item values minus the discount adjustments minus what
 *   the returns gave back, on the date of the sale;
 * - a returned item gives back its charged price times the units returned
 *   minus its share of the discounts, `round half up (allocation x returned /
 *   quantity)`, where the allocation splits the discount among the items of the
 *   sale by value in whole cents (largest remainder, ties by position).
 * The amounts are in cents. The gate `daily-sales` proves this equals
 * `readPeriodSummary(...).daily` date by date.
 */
export function dailySalesQuery(organization: string, period: EconomicsPeriod) {
  return sql`
    WITH ${countedCte(organization, period)},
    ${lineCte(organization)},
    ${grossCte},
    ${adjustmentCte(organization)},
    ${returnedCte(organization)},
    ${allocationCte("returned_sales")},
    ${givenBackCte},
    given_back_by_sale AS (
      SELECT given_back.sale_id, sum(given_back.cents) AS cents
      FROM given_back
      GROUP BY given_back.sale_id
    ),
    per_day AS (
      SELECT counted.occurred_on, count(*) AS sales,
        sum(
          coalesce(gross.cents, 0)
          - coalesce(adjustment.discount_cents, 0)
          - coalesce(given_back_by_sale.cents, 0)
        ) AS net_cents
      FROM counted
      LEFT JOIN gross ON gross.sale_id = counted.id
      LEFT JOIN adjustment ON adjustment.sale_id = counted.id
      LEFT JOIN given_back_by_sale ON given_back_by_sale.sale_id = counted.id
      GROUP BY counted.occurred_on
    )
    SELECT to_char(series.day, 'YYYY-MM-DD') AS date,
      coalesce(per_day.sales, 0)::integer AS count,
      round(coalesce(per_day.net_cents, 0), 0)::text AS net_cents
    FROM ${seriesOf(period)}
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
