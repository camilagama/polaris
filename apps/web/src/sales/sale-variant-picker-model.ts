import type {
  InventoryBalanceEntryReadModel,
  InventoryBalanceReadModel,
  PolarisRpcClient,
} from "@polaris/contracts";
import { variantFullLabel } from "../inventory/stock-target";
import { formatBrlAmount, formatQuantity } from "../lib/format";
import { readErrorMessage } from "../lib/rpc-error";
import {
  type ItemDraft,
  type Loadable,
  NEW_PRODUCT_HREF,
  NO_PRODUCT_MESSAGE,
} from "./sale-form-model";

/** How many matches the picker shows; typing narrows them down. */
export const PICKER_RESULT_LIMIT = 20;

type ListBalancesInput = Parameters<
  PolarisRpcClient["inventory"]["listBalances"]
>[0];

/** One read of sellable variants (active products only), searched by text. */
export function variantSearchRequest(
  organizationId: string,
  query: string
): ListBalancesInput {
  const text = query.trim();
  return {
    limit: PICKER_RESULT_LIMIT,
    organizationId,
    productStatus: "active",
    stock: "all",
    ...(text === "" ? {} : { query: text }),
  };
}

/** Re-reads the balances of the variants already on the sale, one call. */
export function lineBalancesRequest(
  organizationId: string,
  variantIds: readonly string[]
): ListBalancesInput {
  return {
    limit: 100,
    organizationId,
    productStatus: "all",
    stock: "all",
    variantIds: [...variantIds],
  };
}

export interface PickerOption {
  detail: string;
  entry: InventoryBalanceEntryReadModel;
  id: string;
  label: string;
  tone: "ok" | "warning";
}

function stockText(entry: InventoryBalanceEntryReadModel): string {
  return entry.quantity === 0
    ? "Sem saldo"
    : `Saldo ${formatQuantity(entry.quantity)}`;
}

export function pickerOptions(
  entries: readonly InventoryBalanceEntryReadModel[]
): PickerOption[] {
  return entries.map((entry) => {
    const parts = [stockText(entry)];
    if (entry.sku) {
      parts.push(`SKU ${entry.sku}`);
    }
    if (entry.movingAverageCost !== null && entry.quantity > 0) {
      parts.push(`custo médio ${formatBrlAmount(entry.movingAverageCost)}`);
    }
    return {
      detail: parts.join(" · "),
      entry,
      id: entry.variantId,
      label: variantFullLabel(entry),
      tone: entry.quantity === 0 ? "warning" : "ok",
    };
  });
}

export type PickerView =
  | { kind: "loading"; message: string }
  | { kind: "error"; message: string }
  | { href: string | null; kind: "empty"; message: string }
  | {
      kind: "ready";
      hint: string | null;
      options: PickerOption[];
      status: string;
    };

export function pickerView(
  load: Loadable<{
    entries: readonly InventoryBalanceEntryReadModel[];
    more: boolean;
  }>,
  query: string
): PickerView {
  if (load.status === "loading") {
    return { kind: "loading", message: "Buscando variantes…" };
  }
  if (load.status === "error") {
    return { kind: "error", message: load.message };
  }
  const text = query.trim();
  if (load.value.entries.length === 0) {
    // a store with nothing to sell is taken to the form of a new product; a search with no match is not
    return text === ""
      ? { href: NEW_PRODUCT_HREF, kind: "empty", message: NO_PRODUCT_MESSAGE }
      : {
          href: null,
          kind: "empty",
          message: `Nenhuma variante encontrada para “${text}”. Confira o nome, a variante ou o SKU.`,
        };
  }
  const options = pickerOptions(load.value.entries);
  return {
    hint: load.value.more
      ? `Mostrando as primeiras ${PICKER_RESULT_LIMIT} variantes. Digite para refinar a busca.`
      : null,
    kind: "ready",
    options,
    status: `${options.length} ${options.length === 1 ? "variante encontrada" : "variantes encontradas"}.`,
  };
}

export function pickerErrorMessage(error: unknown): string {
  return readErrorMessage(error, "as variantes");
}

/** What choosing a variant sets on the line; prices and quantity stay as typed. */
export function itemChangesForEntry(
  entry: InventoryBalanceEntryReadModel
): Pick<ItemDraft, "label" | "productId" | "variantId"> {
  return {
    label: variantFullLabel(entry),
    productId: entry.productId,
    variantId: entry.variantId,
  };
}

/** The line's balance, from the same read that listed the variant. */
export function balanceOfEntry(
  entry: InventoryBalanceEntryReadModel
): InventoryBalanceReadModel {
  return {
    movingAverageCost: entry.movingAverageCost,
    quantity: entry.quantity,
    variantId: entry.variantId,
    version: entry.version,
  };
}

/** Clearing the choice brings the search back; the quantity is kept. */
export const clearedItemChanges: Pick<
  ItemDraft,
  "label" | "productId" | "variantId"
> = { label: "", productId: "", variantId: "" };

const GONE_MESSAGE =
  "Esta variante não aparece mais entre os produtos ativos. Troque a variante ou remova o item.";

/**
 * Applies a re-read of the lines' balances: every requested variant gets its
 * new balance, and one the server no longer lists gets a warning instead.
 */
export function stockAfterRefresh(
  previous: Readonly<Record<string, Loadable<InventoryBalanceReadModel>>>,
  requestedIds: readonly string[],
  entries: readonly InventoryBalanceEntryReadModel[]
): Record<string, Loadable<InventoryBalanceReadModel>> {
  const next = { ...previous };
  const found = new Map(entries.map((entry) => [entry.variantId, entry]));
  for (const variantId of requestedIds) {
    const entry = found.get(variantId);
    next[variantId] = entry
      ? { status: "ready", value: balanceOfEntry(entry) }
      : { message: GONE_MESSAGE, status: "error" };
  }
  return next;
}

/** Splits ids into reads of at most `size`, the server's limit per call. */
export function chunkIds(ids: readonly string[], size = 100): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += size) {
    chunks.push(ids.slice(index, index + size));
  }
  return chunks;
}
