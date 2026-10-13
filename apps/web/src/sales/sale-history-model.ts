import type {
  CustomerReadModel,
  SaleDetailReadModel,
  SaleListEntryReadModel,
} from "@polaris/contracts";
import { customerName } from "./sale-customer-link-model";
import { cancellationReasonLabel } from "./sale-cancellation-model";
import {
  type ConfirmedSaleView,
  confirmedSaleView,
  formatBrlAmount,
  formatInstant,
  type Loadable,
  loadErrorMessage,
  rpcErrorReason,
  SALE_METHODS,
} from "./sale-form-model";

export const SALES_PAGE_SIZE = 50;

const methodLabels = new Map<string, string>(SALE_METHODS);

/** Where a sale's detail lives. The ID is not customer data. */
export function saleDetailHref(saleId: string): string {
  return `/sales/detail?saleId=${saleId}`;
}

/* -------------------------------------------------------------------------- */
/* List state                                                                 */
/* -------------------------------------------------------------------------- */

export interface SalePage {
  hasMore: boolean;
  sales: readonly SaleListEntryReadModel[];
}

export interface HistoryState {
  customers: Loadable<readonly CustomerReadModel[]>;
  hasMore: boolean;
  list: "error" | "loading" | "ready";
  listError: string | null;
  loadingMore: boolean;
  /** A failed refresh or "load more" while a list is already showing. */
  moreError: string | null;
  sales: SaleListEntryReadModel[];
}

export function initialHistoryState(): HistoryState {
  return {
    customers: { status: "loading" },
    hasMore: false,
    list: "loading",
    listError: null,
    loadingMore: false,
    moreError: null,
    sales: [],
  };
}

/** Starts a (re)load of the first page; a showing list stays visible. */
export function historyLoading(state: HistoryState): HistoryState {
  return state.list === "ready"
    ? { ...state, moreError: null }
    : { ...state, list: "loading", listError: null };
}

/** The first page replaces the list. */
export function historyLoaded(
  state: HistoryState,
  page: SalePage
): HistoryState {
  return {
    ...state,
    hasMore: page.hasMore,
    list: "ready",
    listError: null,
    loadingMore: false,
    moreError: null,
    sales: [...page.sales],
  };
}

export function historyLoadFailed(
  state: HistoryState,
  error: unknown
): HistoryState {
  const message = loadErrorMessage(error, "as vendas");
  return state.list === "ready"
    ? { ...state, moreError: message }
    : { ...state, list: "error", listError: message };
}

export function nextOffset(state: HistoryState): number {
  return state.sales.length;
}

export function canLoadMore(state: HistoryState): boolean {
  return state.list === "ready" && state.hasMore && !state.loadingMore;
}

export function loadMoreStarted(state: HistoryState): HistoryState {
  return canLoadMore(state)
    ? { ...state, loadingMore: true, moreError: null }
    : state;
}

/** Appends a page, skipping sales already shown. */
export function moreLoaded(state: HistoryState, page: SalePage): HistoryState {
  const known = new Set(state.sales.map((sale) => sale.id));
  return {
    ...state,
    hasMore: page.hasMore,
    loadingMore: false,
    moreError: null,
    sales: [
      ...state.sales,
      ...page.sales.filter((sale) => !known.has(sale.id)),
    ],
  };
}

export function moreLoadFailed(
  state: HistoryState,
  error: unknown
): HistoryState {
  return {
    ...state,
    loadingMore: false,
    moreError: loadErrorMessage(error, "mais vendas"),
  };
}

export function historyCustomersLoaded(
  state: HistoryState,
  customers: readonly CustomerReadModel[]
): HistoryState {
  return { ...state, customers: { status: "ready", value: customers } };
}

export function historyCustomersFailed(
  state: HistoryState,
  error: unknown
): HistoryState {
  return {
    ...state,
    customers: {
      message: loadErrorMessage(error, "os clientes"),
      status: "error",
    },
  };
}

/* -------------------------------------------------------------------------- */
/* List views                                                                 */
/* -------------------------------------------------------------------------- */

export interface HistoryRow {
  customerText: string;
  detailHref: string;
  id: string;
  itemCountText: string;
  methodText: string;
  occurredText: string;
  statusLabel: string;
  statusTone: "cancelled" | "confirmed";
  totalText: string;
}

function rowCustomerText(
  state: HistoryState,
  customerId: string | null
): string {
  return customerId === null
    ? "Sem cliente"
    : customerName(state.customers, customerId);
}

export function historyRows(state: HistoryState): HistoryRow[] {
  return state.sales.map((sale) => ({
    customerText: rowCustomerText(state, sale.customerId),
    detailHref: saleDetailHref(sale.id),
    id: sale.id,
    itemCountText: `${sale.itemCount} ${sale.itemCount === 1 ? "item" : "itens"}`,
    methodText:
      sale.paymentMethod === null
        ? "Pagamento não informado"
        : (methodLabels.get(sale.paymentMethod) ?? sale.paymentMethod),
    occurredText: formatInstant(sale.occurredAt),
    statusLabel: sale.status === "cancelled" ? "Cancelada" : "Confirmada",
    statusTone: sale.status,
    totalText: formatBrlAmount(sale.totalDue),
  }));
}

export type HistoryView =
  | { kind: "loading"; message: string }
  | { kind: "error"; message: string }
  | { href: string; kind: "empty"; message: string }
  | { kind: "ready"; rows: HistoryRow[] };

export function historyView(state: HistoryState): HistoryView {
  if (state.list === "loading") {
    return { kind: "loading", message: "Carregando vendas…" };
  }
  if (state.list === "error") {
    return {
      kind: "error",
      message: state.listError ?? "Não foi possível carregar as vendas.",
    };
  }
  if (state.sales.length === 0) {
    return {
      href: "/sales",
      kind: "empty",
      message:
        "Nenhuma venda ainda. Registre a primeira venda para vê-la aqui.",
    };
  }
  return { kind: "ready", rows: historyRows(state) };
}

export interface LoadMoreView {
  busy: boolean;
  error: string | null;
  label: string;
  visible: boolean;
}

export function loadMoreView(state: HistoryState): LoadMoreView {
  return {
    busy: state.loadingMore,
    error: state.moreError,
    label: state.loadingMore ? "Carregando…" : "Carregar mais",
    visible: state.list === "ready" && state.hasMore,
  };
}

/* -------------------------------------------------------------------------- */
/* Detail                                                                     */
/* -------------------------------------------------------------------------- */

interface CancellationView {
  rows: Array<{ label: string; value: string }>;
}

export interface SaleDetailView {
  canCancel: boolean;
  cancellation: CancellationView | null;
  sale: ConfirmedSaleView;
  saleId: string;
  statusLabel: string;
  statusTone: "cancelled" | "confirmed";
}

function cancellationView(
  cancellation: NonNullable<SaleDetailReadModel["cancellation"]>
): CancellationView {
  const rows = [
    { label: "Cancelada em", value: formatInstant(cancellation.cancelledAt) },
    {
      label: "Motivo",
      value: cancellationReasonLabel(cancellation.reasonCode),
    },
  ];
  if (cancellation.reasonNote !== null) {
    rows.push({ label: "Observação", value: cancellation.reasonNote });
  }
  rows.push({
    label: "Estoque",
    value: "Devolvido item a item, pelo custo registrado em cada item.",
  });
  return { rows };
}

/**
 * Display model of a sale and its cancellation. A cancelled sale keeps its
 * confirmed snapshot unchanged; only the status and the cancellation record
 * are added, and cancelling again is not offered.
 */
export function saleDetailView(detail: SaleDetailReadModel): SaleDetailView {
  const cancelled = detail.cancellation !== null;
  return {
    canCancel: !cancelled,
    cancellation: detail.cancellation
      ? cancellationView(detail.cancellation)
      : null,
    sale: confirmedSaleView({ ...detail.sale, replayed: false }),
    saleId: detail.sale.sale.id,
    statusLabel: cancelled ? "Cancelada" : "Confirmada",
    statusTone: cancelled ? "cancelled" : "confirmed",
  };
}

/** Message for a sale that failed to load. */
export function detailLoadErrorMessage(error: unknown): string {
  return rpcErrorReason(error) === "sale_not_found"
    ? "Esta venda não foi encontrada nesta organização. Confira o identificador da venda."
    : loadErrorMessage(error, "a venda");
}
