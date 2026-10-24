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
 * date, inside the period. Pass `economics` (`saleEconomics` of each sale, in
 * order) when the caller already computed it.
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
