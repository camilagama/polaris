import type { InventoryBalanceEntryReadModel } from "@polaris/contracts";

/**
 * The stock reads of the Início come from ONE list of up to 100 variants (`inventory/listBalances`, every product
 * status). When the list is the whole catalog (no next page) the checklist, "sem estoque" and "sem custo" are taken
 * from it here, the same as the filtered reads of the server would say: the filters are `coalesce(quantity, 0)` over
 * the LEFT JOIN of the balances (a variant with no balance row reads quantity 0 and no cost) and active products only.
 * With a next page the list is not the catalog and nothing is derived: the page reads the filtered lists.
 */

/** A count of variants as the stock lines of the Início take it (`BalancesPage` of `home-model.ts`, which has the same shape). */
interface CountedPage {
  count: number;
  more: boolean;
}

/** What the derivations look at in a variant. */
export type WideEntry = Pick<
  InventoryBalanceEntryReadModel,
  "movingAverageCost" | "productId" | "productStatus" | "quantity"
>;

/** The most the list carries in one call (the contract's own limit). */
export const WIDE_LIMIT = 100;

/** The list the opening reads, and whether it is the whole catalog (no next page). */
export function wholeCatalog(list: {
  entries: readonly WideEntry[];
  nextCursor: string | null;
}): readonly WideEntry[] | null {
  return list.nextCursor === null ? list.entries : null;
}

const isActive = (entry: WideEntry) => entry.productStatus === "active";

/** The first product, in the order of the server's list (archived ones included); null for an empty catalog. */
export function firstProductId(entries: readonly WideEntry[]): string | null {
  return entries[0]?.productId ?? null;
}

/** Some variant of an active product has stock. */
export function hasStock(entries: readonly WideEntry[]): boolean {
  return entries.some((entry) => isActive(entry) && entry.quantity > 0);
}

/** The variants of active products with no stock (S). */
export function withoutStockPage(entries: readonly WideEntry[]): CountedPage {
  return {
    count: entries.filter((entry) => isActive(entry) && entry.quantity === 0)
      .length,
    more: false,
  };
}

/** The variants of active products whose average cost is not known (C), those with no balance row included. */
export function unknownCostPage(entries: readonly WideEntry[]): CountedPage {
  return {
    count: entries.filter(
      (entry) => isActive(entry) && entry.movingAverageCost === null
    ).length,
    more: false,
  };
}

/** The checklist of a store that never sold, from the whole catalog. */
export function checklistOf(entries: readonly WideEntry[]): {
  firstProductId: string | null;
  hasStock: boolean;
} {
  return {
    firstProductId: firstProductId(entries),
    hasStock: hasStock(entries),
  };
}

/** The stock lines (S, and C only when the page is to show it) from the whole catalog. */
export function stockOf(
  entries: readonly WideEntry[],
  withUnknownCost: boolean
): { unknownCost: CountedPage | null; withoutStock: CountedPage } {
  return {
    unknownCost: withUnknownCost ? unknownCostPage(entries) : null,
    withoutStock: withoutStockPage(entries),
  };
}

/**
 * What this tab learned of the store's catalog: the store whose list had a next page, kept in `sessionStorage` (the
 * menu's links load the page again, so the page's memory would not carry it to the next screen; `sessionStorage` is the
 * tab's own and ends with it), or in the page's memory where the browser refuses it. Never `localStorage`. One store at
 * a time: it goes with the session (`leave-browser.ts`) and when another store opens.
 */
export const LARGE_CATALOG_KEY = "polaris.home.largeCatalog";

type SessionStore = Pick<Storage, "getItem" | "removeItem" | "setItem">;

function sessionStore(): SessionStore | null {
  try {
    return window.sessionStorage ?? null;
  } catch {
    return null;
  }
}

let inMemory: string | null = null;

function readHint(store: SessionStore | null): string | null {
  try {
    return store === null
      ? inMemory
      : (store.getItem(LARGE_CATALOG_KEY) ?? inMemory);
  } catch {
    return inMemory;
  }
}

/** Drops what the tab learned (the session ended, "Sair", another store). */
export function forgetLargeCatalog(
  store: SessionStore | null = sessionStore()
): void {
  inMemory = null;
  try {
    store?.removeItem(LARGE_CATALOG_KEY);
  } catch {
    // the page's memory is already clear
  }
}

/** This tab already found the store's catalog past 100 variants: the wide read would only be thrown away. */
export function knowsLargeCatalog(
  organizationId: string,
  store: SessionStore | null = sessionStore()
): boolean {
  const kept = readHint(store);
  if (kept === organizationId) {
    return true;
  }
  if (kept !== null) {
    // another store is open now: what was learned of the former is dropped
    forgetLargeCatalog(store);
  }
  return false;
}

/** Keeps that the catalog of the store is past 100 variants, for this tab only. */
export function rememberLargeCatalog(
  organizationId: string,
  store: SessionStore | null = sessionStore()
): void {
  inMemory = organizationId;
  try {
    store?.setItem(LARGE_CATALOG_KEY, organizationId);
  } catch {
    // the page's memory carries it
  }
}
