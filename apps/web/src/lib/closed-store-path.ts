/**
 * The panel of a closed store (ADR 0081): outside the shell, like the acceptance, since the store no longer opens as a
 * tenant. The e-mails of the closure link to the bare path (no store, no token in the address); the panel lists the
 * owner's closed stores and opens the one of `loja`.
 */
const CLOSED_STORE_PATH = "/loja-encerrada";

const trailingSlashes = /\/+$/;

export function isClosedStorePath(pathname: string): boolean {
  return (pathname.replace(trailingSlashes, "") || "/") === CLOSED_STORE_PATH;
}

/** The panel of one closed store; `justClosed` adds the sentence of the moment after the closure. */
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

/** What the address asks of the panel. */
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
