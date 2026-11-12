import { MAX_INVENTORY_QUANTITY } from "@polaris/domain/inventory/inventory";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STOCK_ENTRY_PARAM = "entrada";
const FROM_PARAM = "de";
const QUANTITY_PARAM = "quantidade";
const WHOLE_NUMBER = /^[1-9][0-9]{0,9}$/;

function isOpeningQuantity(value: number): boolean {
  return (
    Number.isSafeInteger(value) && value >= 1 && value <= MAX_INVENTORY_QUANTITY
  );
}

/** `missing` is the quantity the sale lacks; left out when it is not a whole number the panel can take. */
export function stockEntryHref(variantId: string, missing?: number): string {
  const query = new URLSearchParams({
    [STOCK_ENTRY_PARAM]: variantId,
    [FROM_PARAM]: "venda",
  });
  if (missing !== undefined && isOpeningQuantity(missing)) {
    query.set(QUANTITY_PARAM, String(missing));
  }
  return `/inventory?${query.toString()}`;
}

/** A quantity that is absent, zero, negative, decimal, text or above the limit opens as 1, never as an error. */
function readOpeningQuantity(value: string | null): number {
  if (value === null || !WHOLE_NUMBER.test(value)) {
    return 1;
  }
  const quantity = Number(value);
  return isOpeningQuantity(quantity) ? quantity : 1;
}

export function readStockEntryRequest(
  search: string
): { quantity: number; variantId: string | null } | null {
  const params = new URLSearchParams(search);
  const value = params.get(STOCK_ENTRY_PARAM);
  if (value === null) {
    return null;
  }
  return {
    quantity: readOpeningQuantity(params.get(QUANTITY_PARAM)),
    variantId: UUID.test(value) ? value : null,
  };
}

export function withoutStockEntry(search: string): string {
  const params = new URLSearchParams(search);
  params.delete(STOCK_ENTRY_PARAM);
  params.delete(FROM_PARAM);
  params.delete(QUANTITY_PARAM);
  const rest = params.toString();
  return rest === "" ? "" : `?${rest}`;
}
