import type {
  InventoryBalanceEntryReadModel,
  InventoryBalanceReadModel,
} from "@polaris/contracts";
import { formatBrlAmount, formatQuantity } from "../lib/format";

/** The variant a stock command acts on, as the screen last read it. */
export interface StockTarget {
  /** The product is archived: its stock can still be adjusted. */
  archived: boolean;
  /**
   * The average cost is not on this device (ADR 0031), so `movingAverageCost` is
   * null without meaning "unknown": the screen neither shows it nor blocks on it.
   */
  costUnavailable?: boolean;
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
  entry: InventoryBalanceEntryReadModel,
  options: { costUnavailable?: boolean } = {}
): StockTarget {
  return {
    archived: entry.productStatus === "archived",
    ...(options.costUnavailable ? { costUnavailable: true } : {}),
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

/** The cost line of a target: unavailable offline, unknown, or the average. */
export function targetCostText(target: StockTarget): string {
  return target.costUnavailable
    ? "Disponível com conexão"
    : costText(target.movingAverageCost);
}

/** Average cost for display; an unknown cost is never shown as zero. */
export function costText(movingAverageCost: string | null): string {
  return movingAverageCost === null
    ? "Custo desconhecido"
    : formatBrlAmount(movingAverageCost);
}
