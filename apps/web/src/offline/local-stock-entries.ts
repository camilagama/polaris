import type {
  InventoryBalanceEntryReadModel,
  LocalInventoryReadModel,
  LocalProductReadModel,
  LocalVariantReadModel,
} from "@polaris/contracts";
import type { LocalWriter } from "./bootstrap";
import type { OutboxCommand } from "./outbox/command";
import type { Outbox } from "./outbox/outbox";
import { applyQueuedStock, queuedCommandsByVariant } from "./stock-commands";

/**
 * Variants with their balances, built from this device's collections: the shape
 * the sale picker and the stock screen already render, so they need no second
 * model for offline. The balance is the server's row plus what is still queued
 * (`applyQueuedStock`), so a pending sale or movement already counts.
 *
 * The device never holds the average cost (ADR 0031), so `movingAverageCost` is
 * always null here: screens that need the cost stay online.
 */
export interface LocalCatalogRows {
  commands: readonly OutboxCommand[];
  inventory: readonly LocalInventoryReadModel[];
  products: readonly LocalProductReadModel[];
  variants: readonly LocalVariantReadModel[];
}

export function localStockEntries(
  rows: LocalCatalogRows
): InventoryBalanceEntryReadModel[] {
  const products = new Map(
    rows.products
      .filter((product) => product.deletedAt === null)
      .map((product) => [product.id, product])
  );
  const balances = new Map(rows.inventory.map((row) => [row.variantId, row]));
  const queued = queuedCommandsByVariant(rows.commands);
  const entries: InventoryBalanceEntryReadModel[] = [];
  for (const variant of rows.variants) {
    const product = products.get(variant.productId);
    if (!product) {
      continue;
    }
    const balance = balances.get(variant.id);
    const effective = applyQueuedStock(
      { quantity: balance?.quantity ?? 0, version: balance?.version ?? 0 },
      queued.get(variant.id) ?? [],
      variant.id
    );
    entries.push({
      isDefaultVariant: variant.isDefault,
      listPrice: variant.listPrice,
      movingAverageCost: null,
      productId: product.id,
      productName: product.name,
      productStatus: product.archivedAt === null ? "active" : "archived",
      quantity: effective.quantity,
      sku: variant.sku,
      updatedAt: balance?.updatedAt ?? null,
      // the server writes only the names the entry contract lists
      values: variant.values as InventoryBalanceEntryReadModel["values"],
      variantId: variant.id,
      version: effective.version,
    });
  }
  return entries.sort(
    (a, b) =>
      a.productName.localeCompare(b.productName, "pt-BR") ||
      a.variantId.localeCompare(b.variantId)
  );
}

const WHITESPACE = /\s+/;

function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

export interface LocalStockFilter {
  limit?: number;
  productStatus: "active" | "all";
  /** Text matched against the product, the option values and the SKU. */
  query?: string;
  stock?: "all" | "with_stock" | "without_stock";
  /** Only these variants (re-reading the lines already on a sale). */
  variantIds?: readonly string[];
}

/** The search the server does on `listBalances`, over the local entries. */
export function filterLocalStockEntries(
  entries: readonly InventoryBalanceEntryReadModel[],
  filter: LocalStockFilter
): { entries: InventoryBalanceEntryReadModel[]; more: boolean } {
  const wanted = filter.variantIds ? new Set(filter.variantIds) : null;
  const query = fold((filter.query ?? "").trim());
  const matches = entries.filter((entry) => {
    if (wanted && !wanted.has(entry.variantId)) {
      return false;
    }
    if (filter.productStatus === "active" && entry.productStatus !== "active") {
      return false;
    }
    if (filter.stock === "with_stock" && entry.quantity === 0) {
      return false;
    }
    if (filter.stock === "without_stock" && entry.quantity > 0) {
      return false;
    }
    if (query === "") {
      return true;
    }
    const haystack = fold(
      [
        entry.productName,
        ...entry.values.map((value) => value.optionValueName),
        entry.sku ?? "",
      ].join(" ")
    );
    return query.split(WHITESPACE).every((word) => haystack.includes(word));
  });
  const limit = filter.limit ?? matches.length;
  return { entries: matches.slice(0, limit), more: matches.length > limit };
}

/** Reads what `localStockEntries` needs: the collections and the queue, once. */
export async function readLocalCatalog(
  writer: LocalWriter,
  outbox: Outbox
): Promise<LocalCatalogRows> {
  const [products, variants, inventory, snapshot] = await Promise.all([
    writer.rows("products"),
    writer.rows("variants"),
    writer.rows("inventory"),
    outbox.snapshot(),
  ]);
  return { commands: snapshot.commands, inventory, products, variants };
}
