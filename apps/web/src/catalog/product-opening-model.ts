import { MAX_INVENTORY_QUANTITY } from "@polaris/domain/inventory/inventory";
import { formatQuantity } from "../lib/format";
import { parseUnitCost } from "../inventory/stock-command-model";
import { parseMoneyText } from "../sales/sale-form-model";

/**
 * The price and the opening stock of the form of a new product (§3.3 of the design of the Início): what is typed as
 * text, and what it means. Quantity and cost both empty make only the product; a quantity with no cost opens the
 * stock with the cost unknown; a cost with no quantity is an error of the field, and nothing is saved. A quantity
 * of 0 is an empty quantity, and a cost of 0 is a known cost of zero.
 */
export interface ProductOpeningDraft {
  listPrice: string;
  quantity: string;
  unitCost: string;
}

export const emptyOpeningDraft: ProductOpeningDraft = {
  listPrice: "",
  quantity: "",
  unitCost: "",
};

type OpeningField = keyof ProductOpeningDraft;

interface ProductOpeningValue {
  initialStock: { quantity: number; unitCost: string | null } | null;
  listPrice: string | null;
}

export interface OpeningValidation {
  errors: Partial<Record<OpeningField, string>>;
  /** What the form sends; `null` while any field has an error. */
  value: ProductOpeningValue | null;
}

export const PRICE_INVALID = "Informe um valor em reais, como 59,90.";
export const QUANTITY_INVALID =
  "Informe quantos você tem, só com números. Ex.: 10.";
export const QUANTITY_FOR_COST =
  "Informe quantos você tem para guardar o custo, ou apague o custo.";
export const COST_INVALID =
  "Use um valor em reais, com até 6 casas decimais. Ex.: 12,34.";
const QUANTITY_TOO_LARGE = `O limite é ${formatQuantity(MAX_INVENTORY_QUANTITY)} unidades.`;

const wholeNumberPattern = /^\d{1,10}$/;

type QuantityParse =
  | { kind: "empty" }
  | { kind: "invalid" | "too_large" }
  | { kind: "ok"; value: number };

function parseQuantity(text: string): QuantityParse {
  const trimmed = text.trim();
  if (trimmed === "") {
    return { kind: "empty" };
  }
  if (!wholeNumberPattern.test(trimmed)) {
    return { kind: "invalid" };
  }
  const value = Number(trimmed);
  if (value === 0) {
    return { kind: "empty" };
  }
  return value > MAX_INVENTORY_QUANTITY
    ? { kind: "too_large" }
    : { kind: "ok", value };
}

export function validateOpening(draft: ProductOpeningDraft): OpeningValidation {
  const errors: Partial<Record<OpeningField, string>> = {};

  const price = parseMoneyText(draft.listPrice);
  if (price.kind === "invalid" || price.kind === "too_large") {
    errors.listPrice = PRICE_INVALID;
  }

  const quantity = parseQuantity(draft.quantity);
  if (quantity.kind === "invalid") {
    errors.quantity = QUANTITY_INVALID;
  } else if (quantity.kind === "too_large") {
    errors.quantity = QUANTITY_TOO_LARGE;
  }

  const cost = parseUnitCost(draft.unitCost);
  if (cost.kind === "invalid" || cost.kind === "too_large") {
    errors.unitCost = COST_INVALID;
  } else if (cost.kind === "ok" && quantity.kind === "empty") {
    errors.quantity = QUANTITY_FOR_COST;
  }

  if (Object.keys(errors).length > 0) {
    return { errors, value: null };
  }
  return {
    errors,
    value: {
      initialStock:
        quantity.kind === "ok"
          ? {
              quantity: quantity.value,
              unitCost: cost.kind === "ok" ? cost.value : null,
            }
          : null,
      listPrice: price.kind === "ok" ? price.value : null,
    },
  };
}

/** " com 10 unidades" when the product opened with stock: the notice confirms what the person typed. */
export function openingUnitsText(input: {
  initialStock: { quantity: number } | null;
}): string {
  const quantity = input.initialStock?.quantity;
  if (!quantity) {
    return "";
  }
  return ` com ${formatQuantity(quantity)} ${quantity === 1 ? "unidade" : "unidades"}`;
}
