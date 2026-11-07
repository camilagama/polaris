import { formatQuantity } from "../lib/format";

/** How many rows a long list draws at a time; "Carregar mais" adds as many again. */
export const LIST_PAGE_SIZE = 50;

export interface ListPage<T> {
  hasMore: boolean;
  items: T[];
}

/** The first `size` rows of a list read whole from the server or the device, and whether more are left. */
export function listPage<T>(items: readonly T[], size: number): ListPage<T> {
  return { hasMore: items.length > size, items: items.slice(0, size) };
}

/** Whether the count line has its place: while the list loads, and while it has rows (even if a search hides them). */
export function countLineShown(
  isLoading: boolean,
  listIsShown: boolean,
  total: number
): boolean {
  return isLoading || (listIsShown && total > 0);
}

/** The count of a list that is on screen with rows, or null (loading, error, empty or no result say it themselves). */
export function shownListCount(
  listIsShown: boolean,
  found: number,
  total: number,
  query: string,
  noun: readonly [singular: string, plural: string]
): string | null {
  return listIsShown && found > 0
    ? listCountText(found, total, query, noun)
    : null;
}

/**
 * The count above a list: "1.248 produtos" with no search, "37 de 1.248 produtos" with one. The total is what the
 * state has before the search, never how many rows are drawn: "Carregar mais" does not change it.
 */
export function listCountText(
  found: number,
  total: number,
  query: string,
  noun: readonly [singular: string, plural: string]
): string {
  const word = total === 1 ? noun[0] : noun[1];
  if (query.trim() === "") {
    return `${formatQuantity(total)} ${word}`;
  }
  return `${formatQuantity(found)} de ${formatQuantity(total)} ${word}`;
}
