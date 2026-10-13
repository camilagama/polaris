import type {
  InventoryBalanceEntryReadModel,
  InventoryBalanceReadModel,
} from "@polaris/contracts";
import { formatBrlAmount, formatQuantity } from "../lib/format";

/** The variant a stock command acts on, as the screen last read it. */
export interface StockTarget {
  /** The product is archived: its stock can still be adjusted. */
  archived: boolean;
  movingAverageCost: string | null;
  productName: string;
  quantity: number;
  variantId: string;
  variantText: string;
  /** The optimistic version a count must name. */
  version: number;
}

type EntryVariant = Pick<
  InventoryBalanceEntryReadModel,
  "isDefaultVariant" | "values"
>;

/** "Azul / M", or "Variante padrão" for the product's single default variant. */
export function variantLabelText(entry: EntryVariant): string {
  const values = entry.values.map((value) => value.optionValueName);
  if (values.length > 0) {
    return values.join(" / ");
  }
  return entry.isDefaultVariant ? "Variante padrão" : "Sem opções";
}

/** Product and variant on one line: "Camiseta — Azul / M". */
export function variantFullLabel(
  entry: EntryVariant & { productName: string }
): string {
  return entry.isDefaultVariant && entry.values.length === 0
    ? entry.productName
    : `${entry.productName} — ${variantLabelText(entry)}`;
}

export function stockTarget(
  entry: InventoryBalanceEntryReadModel
): StockTarget {
  return {
    archived: entry.productStatus === "archived",
    movingAverageCost: entry.movingAverageCost,
    productName: entry.productName,
    quantity: entry.quantity,
    variantId: entry.variantId,
    variantText: variantLabelText(entry),
    version: entry.version,
  };
}

/** The same target after a command or a read returned a newer balance. */
export function retarget(
  target: StockTarget,
  balance: InventoryBalanceReadModel
): StockTarget {
  return {
    ...target,
    movingAverageCost: balance.movingAverageCost,
    quantity: balance.quantity,
    version: balance.version,
  };
}

export function unitsText(quantity: number): string {
  return `${formatQuantity(quantity)} ${quantity === 1 ? "unidade" : "unidades"}`;
}

/** Average cost for display; an unknown cost is never shown as zero. */
export function costText(movingAverageCost: string | null): string {
  return movingAverageCost === null
    ? "Custo desconhecido"
    : formatBrlAmount(movingAverageCost);
}
