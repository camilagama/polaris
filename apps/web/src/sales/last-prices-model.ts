import type { PreferenceStorage } from "../lib/current-organization-model";
import { formatCalendarDate } from "../lib/format";

/**
 * The catalog has no list price yet, so the sale form remembers, per variant,
 * the last list price and charged price that were confirmed, and offers them
 * as editable starting values. They are only convenience: the server never
 * reads them, and losing them costs nothing.
 */
interface RememberedPrice {
  /** The charged price per unit, e.g. "49.90". */
  charged: string;
  /** The list price per unit, e.g. "59.90". */
  listed: string;
  /** Calendar day (YYYY-MM-DD) the sale was dated. */
  on: string;
}

export type RememberedPrices = Readonly<Record<string, RememberedPrice>>;

/** Variants remembered per organization; the oldest are dropped first. */
export const MAX_REMEMBERED_VARIANTS = 500;

const KEY_PREFIX = "polaris.sale.lastPrices.v1:";
const priceTextPattern = /^\d{1,18}(?:\.\d{1,6})?$/;
const priceParts = /^(\d+)(?:\.(\d+))?$/;
const trailingZeros = /0+$/;
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;

export function lastPricesKey(organizationId: string): string {
  return `${KEY_PREFIX}${organizationId}`;
}

function isRememberedPrice(value: unknown): value is RememberedPrice {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { charged, listed, on } = value as Record<string, unknown>;
  return (
    typeof charged === "string" &&
    typeof listed === "string" &&
    typeof on === "string" &&
    priceTextPattern.test(charged) &&
    priceTextPattern.test(listed) &&
    dayPattern.test(on)
  );
}

/** Reads the remembered prices; anything unreadable is simply not remembered. */
export function readLastPrices(
  storage: PreferenceStorage | null,
  organizationId: string
): RememberedPrices {
  try {
    const text = storage?.getItem(lastPricesKey(organizationId));
    if (!text) {
      return {};
    }
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    const valid: Record<string, RememberedPrice> = {};
    for (const [variantId, price] of Object.entries(parsed)) {
      if (isRememberedPrice(price)) {
        valid[variantId] = price;
      }
    }
    return valid;
  } catch {
    return {};
  }
}

export interface ConfirmedLinePrices {
  chargedUnitPrice: string;
  listedUnitPrice: string;
  variantId: string;
}

/**
 * The remembered prices after a sale: the confirmed lines overwrite their
 * variants, and only the newest `MAX_REMEMBERED_VARIANTS` are kept.
 */
export function mergeLastPrices(
  previous: RememberedPrices,
  lines: readonly ConfirmedLinePrices[],
  day: string
): RememberedPrices {
  const merged: Record<string, RememberedPrice> = { ...previous };
  for (const line of lines) {
    merged[line.variantId] = {
      charged: line.chargedUnitPrice,
      listed: line.listedUnitPrice,
      on: day,
    };
  }
  const newestFirst = Object.entries(merged).sort(([, left], [, right]) =>
    right.on.localeCompare(left.on)
  );
  return Object.fromEntries(newestFirst.slice(0, MAX_REMEMBERED_VARIANTS));
}

/** Returns false when the browser refused to save; the sale is unaffected. */
export function writeLastPrices(
  storage: PreferenceStorage | null,
  organizationId: string,
  prices: RememberedPrices
): boolean {
  try {
    storage?.setItem(lastPricesKey(organizationId), JSON.stringify(prices));
    return storage !== null;
  } catch {
    return false;
  }
}

/** "59.90" becomes "59,90" and "49.9000" becomes "49,90", as typed in the field. */
export function priceFieldText(price: string): string {
  const match = priceParts.exec(price);
  if (!match) {
    return price;
  }
  const fraction = (match[2] ?? "").replace(trailingZeros, "").padEnd(2, "0");
  return `${match[1] ?? "0"},${fraction}`;
}

export interface PriceSuggestion {
  chargedUnitPrice: string;
  listedUnitPrice: string;
}

/**
 * Starting values for a freshly chosen variant, or null when none are known.
 * The last confirmed sale of the variant wins; without one, the variant's list
 * price (when it has one) suggests both the listed and the charged price.
 */
export function suggestPrices(
  prices: RememberedPrices,
  variantId: string,
  listPrice: string | null = null
): PriceSuggestion | null {
  const remembered = Object.hasOwn(prices, variantId)
    ? prices[variantId]
    : undefined;
  if (remembered) {
    return {
      chargedUnitPrice: priceFieldText(remembered.charged),
      listedUnitPrice: priceFieldText(remembered.listed),
    };
  }
  return listPrice === null
    ? null
    : {
        chargedUnitPrice: priceFieldText(listPrice),
        listedUnitPrice: priceFieldText(listPrice),
      };
}

/** Fills only prices the operator has not typed yet. */
export function withSuggestedPrices<
  T extends { chargedUnitPrice: string; listedUnitPrice: string },
>(item: T, suggestion: PriceSuggestion | null): T {
  if (suggestion === null) {
    return item;
  }
  return {
    ...item,
    chargedUnitPrice:
      item.chargedUnitPrice.trim() === ""
        ? suggestion.chargedUnitPrice
        : item.chargedUnitPrice,
    listedUnitPrice:
      item.listedUnitPrice.trim() === ""
        ? suggestion.listedUnitPrice
        : item.listedUnitPrice,
  };
}

/**
 * The hint under the price fields while they still hold the suggested values.
 * Once either is edited the hint goes away: the operator's number rules.
 */
export function suggestionHint(
  prices: RememberedPrices,
  item: {
    chargedUnitPrice: string;
    listedUnitPrice: string;
    variantId: string;
  }
): string | null {
  const suggestion = suggestPrices(prices, item.variantId);
  const remembered = Object.hasOwn(prices, item.variantId)
    ? prices[item.variantId]
    : undefined;
  if (
    suggestion === null ||
    remembered === undefined ||
    item.listedUnitPrice !== suggestion.listedUnitPrice ||
    item.chargedUnitPrice !== suggestion.chargedUnitPrice
  ) {
    return null;
  }
  return `Preços sugeridos pela última venda desta variante (${formatCalendarDate(remembered.on)}). Confira e edite se mudaram.`;
}
