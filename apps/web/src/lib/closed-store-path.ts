const CLOSED_STORE_PATH = "/loja-encerrada";

const trailingSlashes = /\/+$/;

export function isClosedStorePath(pathname: string): boolean {
  return (pathname.replace(trailingSlashes, "") || "/") === CLOSED_STORE_PATH;
}

export function closedStorePath(
  options: { justClosed?: boolean; storeId?: string | undefined } = {}
): string {
  const query = new URLSearchParams();
  if (options.storeId) {
    query.set("loja", options.storeId);
  }
  if (options.justClosed) {
    query.set("encerrou", "1");
  }
  const search = query.toString();
  return search ? `${CLOSED_STORE_PATH}?${search}` : CLOSED_STORE_PATH;
}

export function closedStoreQuery(search: string): {
  justClosed: boolean;
  storeId: string | null;
} {
  const query = new URLSearchParams(search);
  return {
    justClosed: query.get("encerrou") === "1",
    storeId: query.get("loja"),
  };
}

const NEW_STORE_PARAM = "nova-loja";
const REOPENED_PARAM = "reaberta";

/**
 * "Abrir outra loja" of the panel: the first access opens the form at once, without sending an owner whose only
 * store is closed back to the panel.
 */
export const NEW_STORE_PATH = `/?${NEW_STORE_PARAM}=1`;

export function wantsNewStore(search: string): boolean {
  return new URLSearchParams(search).get(NEW_STORE_PARAM) === "1";
}

/** The Início right after the closure was undone: it says so once, then drops the mark from the address. */
export const REOPENED_PATH = `/?${REOPENED_PARAM}=1`;

export function justReopened(search: string): boolean {
  return new URLSearchParams(search).get(REOPENED_PARAM) === "1";
}

/** The address without the one-time marks, for `history.replaceState`. */
export function withoutOpeningMarks(pathname: string, search: string): string {
  const query = new URLSearchParams(search);
  query.delete(NEW_STORE_PARAM);
  query.delete(REOPENED_PARAM);
  const rest = query.toString();
  return rest ? `${pathname}?${rest}` : pathname;
}
