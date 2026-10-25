import { isValidCalendarDate } from "../inventory/calendar-date";
import { Money } from "../money/money";
import {
  InvalidSaleFactError,
  type SaleEconomics,
  type SaleFact,
  saleEconomics,
  saleItemEconomics,
} from "./sale-economics";

/**
 * The period split by commercial date and the products that sold the most
 * (ADR 0056, D2): pure calculations over the same facts and with the same
 * engine as `periodResult`, so a day of the series is the result of that day
 * and the series adds up to the period. A sale belongs to its commercial date:
 * a return lowers the date of the sale it returns, never the day it was made,
 * and a cancelled sale is zero on its date.
 */

export interface DailySales {
  /** `YYYY-MM-DD`, in the organization's calendar. */
  date: string;
  /** Net sales of the sales of that date, exact BRL text. */
  netSales: string;
  /** Confirmed, not cancelled sales of that date. */
  salesCount: number;
}

/** Every calendar date from `from` to `to`, both included, in order. */
export function calendarDates(from: string, to: string): string[] {
  if (!(isValidCalendarDate(from) && isValidCalendarDate(to)) || to < from) {
    throw new InvalidSaleFactError();
  }
  const dates: string[] = [];
  const cursor = new Date(`${from}T00:00:00.000Z`);
  for (;;) {
    const date = cursor.toISOString().slice(0, 10);
    dates.push(date);
    if (date === to) {
      return dates;
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}

/**
 * Net sales and the count of sales of each date of the period. A date without
 * sales is `"0.00"` and 0, never missing. Every sale must carry its commercial
 * date, inside the period. Pass `economics` (`saleEconomics` of each of these
 * sales, in the same order; only the length is checked) when the caller
 * already computed it.
 */
export function dailySales(
  sales: readonly SaleFact[],
  from: string,
  to: string,
  economics: readonly SaleEconomics[] = sales.map(saleEconomics)
): DailySales[] {
  if (economics.length !== sales.length) {
    throw new InvalidSaleFactError();
  }
  const days = new Map(
    calendarDates(from, to).map((date) => [
      date,
      { count: 0, net: Money.fromMinorUnits(0n) },
    ])
  );
  sales.forEach((sale, index) => {
    const day =
      sale.occurredOn === undefined ? undefined : days.get(sale.occurredOn);
    const entry = economics[index];
    if (!(day && entry)) {
      // a sale outside the period, or without a date, cannot be placed
      throw new InvalidSaleFactError();
    }
    day.net = day.net.add(Money.from(entry.netSales));
    day.count += entry.counted ? 1 : 0;
  });
  return [...days].map(([date, day]) => ({
    date,
    netSales: day.net.toString(),
    salesCount: day.count,
  }));
}

/** An expense with no sale (or tied to a cancelled one) and the date of its competence. */
export interface OperatingExpenseFact {
  /** Exact BRL text. */
  amount: string;
  /** `YYYY-MM-DD`: the day the cost belongs to, no apportioning. */
  competenceOn: string;
}

export interface DailyEconomics extends DailySales {
  /**
   * The costs of the day, exact BRL text: the cost of goods, the processing and
   * anticipation fees and the expenses linked to the sales of the date, plus
   * the expenses with no sale whose competence is that date. It is the sum of
   * the parts (commercial surcharges never lower it, so it is never negative),
   * and `null` when a cost, processing fee or anticipation fee of a sale of
   * the date is unknown: an unknown amount is never zero.
   */
  costs: string | null;
  /**
   * The expenses with no sale whose competence is that date, exact BRL text:
   * the part of `costs` that never depends on a sale, so it is known even when
   * `costs` is `null`. "0.00" on a day without expenses, never null.
   */
  operatingExpenses: string;
  /**
   * The estimated operating result of the day, exact BRL text: net sales minus
   * the costs of the day plus the commercial surcharges. `null` exactly when
   * `costs` is.
   */
  operatingResult: string | null;
}

interface DayTotals {
  known: boolean;
  /** Σ contribution margin of the day's sales, in minor units. */
  margin: bigint;
  /** Σ expenses with no sale of the day, in minor units. */
  operating: bigint;
  /** Σ commercial surcharges of the day's sales, in minor units. */
  surcharges: bigint;
}

/**
 * The daily series with the costs and the result of each date (ADR 0056, D2).
 * Every date of the period is present, also those after today: an expense
 * belongs to its competence date wherever it falls, and the caller decides
 * what to show. The days add up to the period: Σ `costs` (when no day is
 * `null`) is the cost of goods plus the fees plus the linked and the operating
 * expenses of `periodResult`, and Σ `operatingResult` is its
 * `estimatedOperatingResult`. Pass `economics` as for `dailySales`.
 *
 * This runs over every sale of the period (a year at most), so each sale is
 * read twice, not five times: the costs of a day come from the chain's own
 * identity, margin = net sales + surcharges - (cost of goods + fees + linked
 * expenses), so costs = net sales + surcharges - margin (+ the day's expenses
 * with no sale). The properties in the tests hold it to the sum of the parts.
 */
export function dailyEconomics(
  sales: readonly SaleFact[],
  operatingExpenses: readonly OperatingExpenseFact[],
  from: string,
  to: string,
  economics: readonly SaleEconomics[] = sales.map(saleEconomics)
): DailyEconomics[] {
  const series = dailySales(sales, from, to, economics);
  const days = new Map<string, DayTotals>(
    series.map((day) => [
      day.date,
      { known: true, margin: 0n, operating: 0n, surcharges: 0n },
    ])
  );
  sales.forEach((fact, index) => {
    // dailySales already refused a sale without a date or outside the period
    const day = days.get(fact.occurredOn as string) as DayTotals;
    const entry = economics[index] as SaleEconomics;
    day.margin += Money.from(entry.contributionMargin).minorUnits;
    day.surcharges += Money.from(entry.commercialSurcharges).minorUnits;
    day.known &&=
      entry.unknown.costItems === 0 &&
      entry.unknown.processingFees === 0 &&
      entry.unknown.anticipationFees === 0;
  });
  for (const expense of operatingExpenses) {
    const day = days.get(expense.competenceOn);
    if (!day) {
      // an expense outside the period cannot be placed
      throw new InvalidSaleFactError();
    }
    day.operating += Money.from(expense.amount).minorUnits;
  }
  return series.map((day) => {
    const totals = days.get(day.date) as DayTotals;
    const expensesOfDay = Money.fromMinorUnits(totals.operating).toString();
    if (!totals.known) {
      return {
        ...day,
        costs: null,
        operatingExpenses: expensesOfDay,
        operatingResult: null,
      };
    }
    const net = Money.from(day.netSales).minorUnits;
    return {
      ...day,
      costs: Money.fromMinorUnits(
        net + totals.surcharges - totals.margin + totals.operating
      ).toString(),
      operatingExpenses: expensesOfDay,
      operatingResult: Money.fromMinorUnits(
        totals.margin - totals.operating
      ).toString(),
    };
  });
}

export interface ProductSales {
  /** Net sales of the product's items, exact BRL text. */
  netSales: string;
  productId: string;
  /** Units sold, net of returns (0 when every unit came back). */
  quantity: number;
}

function compareProducts(a: ProductTotal, b: ProductTotal): number {
  if (a.quantity !== b.quantity) {
    return b.quantity - a.quantity;
  }
  if (a.net.minorUnits !== b.net.minorUnits) {
    return a.net.minorUnits > b.net.minorUnits ? -1 : 1;
  }
  if (a.productId === b.productId) {
    return 0;
  }
  return a.productId < b.productId ? -1 : 1;
}

interface ProductTotal {
  net: Money;
  productId: string;
  quantity: number;
}

/**
 * Every product sold in the counted (not cancelled) sales, with its units and
 * net sales, most sold first: by units, then by net sales, then by product ID
 * (so the order never depends on the order of the sales). Every item must
 * carry its product. The units add up to the period's `unitsSold`.
 */
export function productSales(sales: readonly SaleFact[]): ProductSales[] {
  const totals = new Map<string, ProductTotal>();
  for (const sale of sales) {
    for (const item of saleItemEconomics(sale)) {
      if (item.productId === undefined) {
        throw new InvalidSaleFactError();
      }
      const total = totals.get(item.productId) ?? {
        net: Money.fromMinorUnits(0n),
        productId: item.productId,
        quantity: 0,
      };
      total.net = total.net.add(item.netSales);
      total.quantity += item.unitsSold;
      totals.set(item.productId, total);
    }
  }
  return [...totals.values()].sort(compareProducts).map((total) => ({
    netSales: total.net.toString(),
    productId: total.productId,
    quantity: total.quantity,
  }));
}

/** The `limit` most sold products; a product whose units all came back is left out. */
export function topProducts(
  sales: readonly SaleFact[],
  limit: number
): ProductSales[] {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new InvalidSaleFactError();
  }
  return productSales(sales)
    .filter((entry) => entry.quantity > 0)
    .slice(0, limit);
}
