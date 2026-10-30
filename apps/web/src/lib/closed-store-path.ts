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
