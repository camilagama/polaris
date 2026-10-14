import { priceFieldText } from "../sales/last-prices-model";
import { parseMoneyText } from "../sales/sale-form-model";

/**
 * What the field holds for a saved price: "59,90" as typed in Brazil, or empty
 * when the variant has no list price.
 */
export function listPriceFieldText(listPrice: string | null): string {
  return listPrice === null ? "" : priceFieldText(listPrice);
}

/**
 * The text of the field as the value the server expects: null clears the price,
 * a normalized "59.90" sets it, and undefined means the text is not a price.
 */
export function listPriceFromField(text: string): string | null | undefined {
  const parsed = parseMoneyText(text);
  if (parsed.kind === "empty") {
    return null;
  }
  return parsed.kind === "ok" ? parsed.value : undefined;
}
