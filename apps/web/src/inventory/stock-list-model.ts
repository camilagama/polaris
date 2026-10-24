import type {
  InventoryBalanceEntryReadModel,
  InventoryBalanceReadModel,
  PolarisRpcClient,
} from "@polaris/contracts";
import { formatInstant, formatQuantity } from "../lib/format";
import { readErrorMessage } from "../lib/rpc-error";
import {
  costText,
  type StockTarget,
  stockTarget,
  variantLabelText,
} from "./stock-target";

export const STOCK_PAGE_SIZE = 50;

export type StockFilter = "all" | "with_stock" | "without_stock";

export const STOCK_FILTERS: ReadonlyArray<readonly [StockFilter, string]> = [
  ["all", "Todas"],
  ["with_stock", "Com saldo"],
  ["without_stock", "Sem saldo"],
];

export interface StockFilters {
  includeArchived: boolean;
  query: string;
  stock: StockFilter;
  /** Only the variants whose average cost is not known (it combines with `stock`). */
  unknownCost: boolean;
}

export const defaultStockFilters: StockFilters = {
  includeArchived: false,
  query: "",
  stock: "all",
  unknownCost: false,
};

/**
 * `/inventory?filtro=…`: the two lists the Início links to. Any other value,
 * or none, is the screen without a filter, and the value is never shown.
 */
export function readStockLinkFilters(
  search: string
): Pick<StockFilters, "stock" | "unknownCost"> {
  switch (new URLSearchParams(search).get("filtro")) {
    case "sem-saldo":
      return { stock: "without_stock", unknownCost: false };
    case "sem-custo":
      return { stock: "all", unknownCost: true };
    default:
      return { stock: "all", unknownCost: false };
  }
}

type ListBalancesInput = Parameters<
  PolarisRpcClient["inventory"]["listBalances"]
>[0];

/** The single read behind the screen; an empty search is simply left out. */
export function stockListRequest(
  organizationId: string,
  filters: StockFilters,
  cursor: string | null
): ListBalancesInput {
  const query = filters.query.trim();
  return {
    limit: STOCK_PAGE_SIZE,
    organizationId,
    productStatus: filters.includeArchived ? "all" : "active",
    stock: filters.stock,
    ...(filters.unknownCost ? { cost: "unknown" as const } : {}),
    ...(cursor === null ? {} : { cursor }),
    ...(query === "" ? {} : { query }),
  };
}

/* -------------------------------------------------------------------------- */
/* List state                                                                 */
/* -------------------------------------------------------------------------- */

export interface StockPage {
  entries: readonly InventoryBalanceEntryReadModel[];
  nextCursor: string | null;
}

export interface StockListState {
  entries: InventoryBalanceEntryReadModel[];
  /** A failed first load; a showing list keeps `moreError` instead. */
  error: string | null;
  loadingMore: boolean;
  moreError: string | null;
  nextCursor: string | null;
  status: "error" | "loading" | "ready";
}

export function initialStockListState(): StockListState {
  return {
    entries: [],
    error: null,
    loadingMore: false,
    moreError: null,
    nextCursor: null,
    status: "loading",
  };
}

/** Starts a (re)load of the first page; a showing list stays visible. */
export function stockLoading(state: StockListState): StockListState {
  return state.status === "ready"
    ? { ...state, moreError: null }
    : { ...state, error: null, status: "loading" };
}

export function stockLoaded(
  state: StockListState,
  page: StockPage
): StockListState {
  return {
    ...state,
    entries: [...page.entries],
    error: null,
    loadingMore: false,
    moreError: null,
    nextCursor: page.nextCursor,
    status: "ready",
  };
}

export function stockLoadFailed(
  state: StockListState,
  error: unknown
): StockListState {
  const message = readErrorMessage(error, "o estoque");
  return state.status === "ready"
    ? { ...state, moreError: message }
    : { ...state, error: message, status: "error" };
}

export function canLoadMoreStock(state: StockListState): boolean {
  return (
    state.status === "ready" && state.nextCursor !== null && !state.loadingMore
  );
}

export function stockMoreStarted(state: StockListState): StockListState {
  return canLoadMoreStock(state)
    ? { ...state, loadingMore: true, moreError: null }
    : state;
}

/** Appends a page, skipping variants already shown. */
export function stockMoreLoaded(
  state: StockListState,
  page: StockPage
): StockListState {
  const known = new Set(state.entries.map((entry) => entry.variantId));
  return {
    ...state,
    entries: [
      ...state.entries,
      ...page.entries.filter((entry) => !known.has(entry.variantId)),
    ],
    loadingMore: false,
    moreError: null,
    nextCursor: page.nextCursor,
  };
}

export function stockMoreFailed(
  state: StockListState,
  error: unknown
): StockListState {
  return {
    ...state,
    loadingMore: false,
    moreError: readErrorMessage(error, "mais variantes"),
  };
}

/**
 * Applies the balance a command (or a fresh read) returned to the row it
 * belongs to. The balance comes from the same transaction that moved stock, so
 * the row is current without reading the whole list again.
 */
export function stockBalanceUpdated(
  state: StockListState,
  balance: InventoryBalanceReadModel,
  updatedAt: string | null
): StockListState {
  return {
    ...state,
    entries: state.entries.map((entry) =>
      entry.variantId === balance.variantId
        ? {
            ...entry,
            movingAverageCost: balance.movingAverageCost,
            quantity: balance.quantity,
            updatedAt: updatedAt ?? entry.updatedAt,
            version: balance.version,
          }
        : entry
    ),
  };
}

/* -------------------------------------------------------------------------- */
/* Views                                                                      */
/* -------------------------------------------------------------------------- */

export interface StockRow {
  archived: boolean;
  costText: string;
  /** The cost is not known: margins on this variant are indeterminate. */
  costUnknown: boolean;
  id: string;
  productName: string;
  quantity: number;
  quantityText: string;
  skuText: string | null;
  target: StockTarget;
  tone: "empty" | "ok";
  updatedText: string;
  variantText: string;
}

export function stockRows(
  entries: readonly InventoryBalanceEntryReadModel[],
  costUnavailable = false
): StockRow[] {
  return entries.map((entry) => ({
    archived: entry.productStatus === "archived",
    costText: costUnavailable
      ? "Só com conexão"
      : costText(entry.movingAverageCost),
    costUnknown: !costUnavailable && entry.movingAverageCost === null,
    id: entry.variantId,
    productName: entry.productName,
    quantity: entry.quantity,
    quantityText: formatQuantity(entry.quantity),
    skuText: entry.sku,
    target: stockTarget(entry, { costUnavailable }),
    tone: entry.quantity === 0 ? "empty" : "ok",
    updatedText:
      entry.updatedAt === null
        ? "Sem movimentos"
        : formatInstant(entry.updatedAt),
    variantText: variantLabelText(entry),
  }));
}

export function stockEmptyMessage(
  filters: StockFilters,
  costUnavailable = false
): string {
  const query = filters.query.trim();
  if (query !== "") {
    return `Nenhuma variante encontrada para “${query}”.`;
  }
  if (filters.unknownCost) {
    if (costUnavailable) {
      return "O custo médio só aparece com conexão.";
    }
    return filters.stock === "all"
      ? "Todas as variantes têm custo."
      : "Nenhuma variante sem custo com esse saldo.";
  }
  if (filters.stock === "with_stock") {
    return "Nenhuma variante com saldo. Use “Receber” para dar entrada no estoque.";
  }
  if (filters.stock === "without_stock") {
    return "Todas as variantes têm saldo.";
  }
  return "Nenhuma variante cadastrada. Cadastre um produto para controlar o estoque dele.";
}

export type StockListView =
  | { kind: "loading"; message: string }
  | { kind: "error"; message: string }
  | { kind: "empty"; message: string; showCatalogLink: boolean }
  | { kind: "ready"; rows: StockRow[] };

export function stockListView(
  state: StockListState,
  filters: StockFilters,
  costUnavailable = false
): StockListView {
  if (state.status === "loading") {
    return { kind: "loading", message: "Carregando o estoque…" };
  }
  if (state.status === "error") {
    return {
      kind: "error",
      message: state.error ?? "Não foi possível carregar o estoque.",
    };
  }
  if (state.entries.length === 0) {
    const unfiltered =
      filters.query.trim() === "" &&
      filters.stock === "all" &&
      !filters.unknownCost;
    return {
      kind: "empty",
      message: stockEmptyMessage(filters, costUnavailable),
      showCatalogLink: unfiltered,
    };
  }
  return { kind: "ready", rows: stockRows(state.entries, costUnavailable) };
}

export interface StockMoreView {
  busy: boolean;
  error: string | null;
  label: string;
  visible: boolean;
}

export function stockMoreView(state: StockListState): StockMoreView {
  return {
    busy: state.loadingMore,
    error: state.moreError,
    label: state.loadingMore ? "Carregando…" : "Carregar mais",
    visible: state.status === "ready" && state.nextCursor !== null,
  };
}

/** "12 variantes" / "mais variantes disponíveis" caption above the list. */
export function stockCountText(state: StockListState): string {
  const count = state.entries.length;
  const noun = count === 1 ? "variante" : "variantes";
  return state.nextCursor === null
    ? `${formatQuantity(count)} ${noun}`
    : `${formatQuantity(count)} ${noun} ${count === 1 ? "carregada" : "carregadas"}; há mais`;
}
