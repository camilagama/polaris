import type { SaleListEntryReadModel } from "@polaris/contracts";
import type { HistoryFilters, SalePage } from "./sale-history-model";

/**
 * The sale history read from this device (no connection): the most recent sales
 * the server confirmed or cancelled, which the device keeps (the last 100,
 * refreshed on every sync that touches a sale), filtered like the server does.
 * The text search over the items sold is not available here (the local row does
 * not carry item labels), and neither is the detail of a sale.
 */
function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function matches(sale: SaleListEntryReadModel, filters: HistoryFilters) {
  if (filters.from !== "" && sale.occurredOn < filters.from) {
    return false;
  }
  if (filters.to !== "" && sale.occurredOn > filters.to) {
    return false;
  }
  if (filters.status === "confirmed" && sale.status !== "confirmed") {
    return false;
  }
  if (filters.status === "cancelled" && sale.status !== "cancelled") {
    return false;
  }
  if (filters.status === "with_returns" && !sale.hasReturns) {
    return false;
  }
  const customer = fold(filters.customer.trim());
  return customer === "" || fold(sale.customerName ?? "").includes(customer);
}

export function filterLocalSales(
  rows: readonly SaleListEntryReadModel[],
  filters: HistoryFilters
): SalePage {
  const sales = rows
    .filter((sale) => matches(sale, filters))
    .sort(
      (a, b) =>
        b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id)
    );
  return { hasMore: false, sales };
}
