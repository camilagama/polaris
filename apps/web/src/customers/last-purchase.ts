import { formatDate } from "@/ui/date-values";

const DAY_MS = 86_400_000;
const RELATIVE_LIMIT_DAYS = 30;

function dayNumber(day: string): number {
  const [year, month, date] = day.split("-").map(Number);
  return Date.UTC(year ?? 0, (month ?? 1) - 1, date ?? 1) / DAY_MS;
}

/**
 * Days from the last purchase to the store's today, both calendar days of the store: the device's clock and zone
 * never enter, so the text turns at the store's midnight.
 */
function daysSince(lastPurchaseOn: string, today: string): number {
  return dayNumber(today) - dayNumber(lastPurchaseOn);
}

/** "12/08" in the year of `today`, "12/08/2025" in another one. */
function shortDate(lastPurchaseOn: string, today: string): string {
  return lastPurchaseOn.slice(0, 4) === today.slice(0, 4)
    ? formatDate(lastPurchaseOn).slice(0, 5)
    : formatDate(lastPurchaseOn);
}

/** Up to 30 days the purchase is told in days ("hoje", "ontem", "há 3 dias"); past that, null. */
function relativeText(lastPurchaseOn: string, today: string): string | null {
  const days = daysSince(lastPurchaseOn, today);
  if (days < 0 || days > RELATIVE_LIMIT_DAYS) {
    return null;
  }
  if (days === 0) {
    return "hoje";
  }
  return days === 1 ? "ontem" : `há ${days} dias`;
}

/**
 * The row of the customer list: "Última compra há 3 dias", "… hoje", "… ontem" or "… em 12/08". A customer the
 * server answered as having no purchase says "Sem compras"; one whose purchases are not known (the device's copy,
 * an older server) says nothing, so a missing field is never read as no purchases.
 */
export function lastPurchaseRowText(
  lastPurchaseOn: string | null | undefined,
  today: string
): string | null {
  if (lastPurchaseOn === undefined) {
    return null;
  }
  if (lastPurchaseOn === null) {
    return "Sem compras";
  }
  const relative = relativeText(lastPurchaseOn, today);
  return `Última compra ${relative ?? `em ${shortDate(lastPurchaseOn, today)}`}`;
}

/** The value of "Última compra" in the customer's summary: "Hoje", "Ontem", "Há 3 dias" or the date "12/08/2026". */
export function lastPurchaseValueText(
  lastPurchaseOn: string,
  today: string
): string {
  const relative = relativeText(lastPurchaseOn, today);
  if (relative === null) {
    return formatDate(lastPurchaseOn);
  }
  return relative.charAt(0).toUpperCase() + relative.slice(1);
}
