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
  /**
   * When the balance last moved, as the list read it; null when it never moved. Absent once a newer balance replaced
   * the one the list read (a balance read carries no date), so the panel says nothing rather than a stale date.
   */
  updatedAt?: string | null | undefined;
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

/** Product and variant on one line: "Camiseta · Azul / M". */
export function variantFullLabel(
  entry: EntryVariant & { productName: string }
): string {
  return entry.isDefaultVariant && entry.values.length === 0
    ? entry.productName
    : `${entry.productName} · ${variantLabelText(entry)}`;
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
    updatedAt: entry.updatedAt,
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
  const { updatedAt: _stale, ...rest } = target;
  return {
    ...rest,
    movingAverageCost: balance.movingAverageCost,
    quantity: balance.quantity,
    version: balance.version,
  };
}

export function unitsText(quantity: number): string {
  return `${formatQuantity(quantity)} ${quantity === 1 ? "unidade" : "unidades"}`;
}

const movementDateFormatter = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  month: "2-digit",
});
const movementYearFormatter = new Intl.DateTimeFormat("pt-BR", {
  year: "numeric",
});

/** Day, month and time in the device's time zone; the year only when it is not the current one. */
function movementInstantText(value: string, now: Date): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const parts = Object.fromEntries(
    movementDateFormatter
      .formatToParts(date)
      .map((part) => [part.type, part.value])
  );
  const year = movementYearFormatter.format(date);
  const showYear = year !== movementYearFormatter.format(now);
  return `${parts.day}/${parts.month}${showYear ? `/${year}` : ""} ${parts.hour}:${parts.minute}`;
}

/**
 * The line under the title of the movement panel: balance, average cost and the instant of the last movement.
 * Without a connection the balance is the device's, and the cost and the instant are not on it.
 */
export function targetBalanceText(
  target: StockTarget,
  now: Date = new Date()
): string {
  if (target.costUnavailable) {
    return `Saldo do aparelho: ${formatQuantity(target.quantity)} · custo médio só com conexão`;
  }
  const cost =
    target.movingAverageCost === null
      ? "custo médio desconhecido"
      : `custo médio ${formatBrlAmount(target.movingAverageCost)}`;
  const parts = [`Saldo atual: ${formatQuantity(target.quantity)}`, cost];
  if (target.updatedAt === null) {
    parts.push("sem movimentos");
  } else if (target.updatedAt !== undefined) {
    const moved = movementInstantText(target.updatedAt, now);
    if (moved !== null) {
      parts.push(`último movimento ${moved}`);
    }
  }
  return parts.join(" · ");
}

/** Average cost for display; an unknown cost is never shown as zero. */
export function costText(movingAverageCost: string | null): string {
  return movingAverageCost === null
    ? "Custo desconhecido"
    : formatBrlAmount(movingAverageCost);
}
