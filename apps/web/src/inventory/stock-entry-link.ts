const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STOCK_ENTRY_PARAM = "entrada";
const FROM_PARAM = "de";

export function stockEntryHref(variantId: string): string {
  const query = new URLSearchParams({
    [STOCK_ENTRY_PARAM]: variantId,
    [FROM_PARAM]: "venda",
  });
  return `/inventory?${query.toString()}`;
}

export function readStockEntryRequest(
  search: string
): { variantId: string | null } | null {
  const value = new URLSearchParams(search).get(STOCK_ENTRY_PARAM);
  if (value === null) {
    return null;
  }
  return { variantId: UUID.test(value) ? value : null };
}

export function withoutStockEntry(search: string): string {
  const params = new URLSearchParams(search);
  params.delete(STOCK_ENTRY_PARAM);
  params.delete(FROM_PARAM);
  const rest = params.toString();
  return rest === "" ? "" : `?${rest}`;
}
