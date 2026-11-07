import type {
  PolarisRpcClient,
  SaleDetailReadModel,
  SaleListEntryReadModel,
} from "@polaris/contracts";
import {
  formatBrlAmount,
  formatCalendarDate,
  formatInstant,
} from "../lib/format";
import { rpcErrorReason } from "../lib/rpc-error";
import { sumBrlAmounts } from "../lib/sum-brl";
import { cancellationReasonLabel } from "./sale-cancellation-model";
import {
  type ConfirmedSaleView,
  confirmedSaleView,
  loadErrorMessage,
  localDay,
  SALE_METHOD_CARDS,
} from "./sale-form-model";
import {
  type ReturnTableRow,
  returnPanelKey,
  returnReasonLabel,
  returnTableRows,
  totalAvailable,
} from "./sale-return-model";

export const SALES_PAGE_SIZE = 50;

const methodLabels = new Map<string, string>(SALE_METHOD_CARDS);

/** Shown beside Confirmada/Cancelada when the sale has at least one return. */
const RETURNS_BADGE = "Com devoluções";

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

/* -------------------------------------------------------------------------- */
/* Filters                                                                    */
/* -------------------------------------------------------------------------- */

export type HistoryStatusFilter =
  | ""
  | "cancelled"
  | "confirmed"
  | "with_returns";

export const HISTORY_STATUS_FILTERS: ReadonlyArray<
  readonly [HistoryStatusFilter, string]
> = [
  ["", "Todas"],
  ["confirmed", "Confirmadas"],
  ["cancelled", "Canceladas"],
  ["with_returns", "Com devoluções"],
];

export interface HistoryFilters {
  /** Part of the current customer's name. */
  customer: string;
  /** First commercial date, YYYY-MM-DD, or empty. */
  from: string;
  /** Part of an item's label (product and variant). */
  query: string;
  status: HistoryStatusFilter;
  /** Last commercial date, YYYY-MM-DD, or empty. */
  to: string;
}

export const emptyHistoryFilters: HistoryFilters = {
  customer: "",
  from: "",
  query: "",
  status: "",
  to: "",
};

export function activeFilterCount(filters: HistoryFilters): number {
  return [
    filters.from !== "" || filters.to !== "",
    filters.status !== "",
    filters.customer.trim() !== "",
    filters.query.trim() !== "",
  ].filter(Boolean).length;
}

type ListInput = Parameters<PolarisRpcClient["sale"]["list"]>[0];

/** The list request: only the filters in use are sent. */
export function historyListRequest(
  organizationId: string,
  filters: HistoryFilters,
  offset: number
): ListInput {
  const customerQuery = filters.customer.trim();
  const query = filters.query.trim();
  return {
    limit: SALES_PAGE_SIZE,
    offset,
    organizationId,
    ...(customerQuery === "" ? {} : { customerQuery }),
    ...(filters.from === "" ? {} : { occurredFrom: filters.from }),
    ...(filters.to === "" ? {} : { occurredTo: filters.to }),
    ...(query === "" ? {} : { query }),
    ...(filters.status === "" ? {} : { status: filters.status }),
  };
}

/* -------------------------------------------------------------------------- */
/* List views                                                                 */
/* -------------------------------------------------------------------------- */

export interface HistoryRow {
  /** The sale was dated before the day it was confirmed on the server. */
  backdated: boolean;
  /** The two letters of the circle of the row, or a dash when the sale has no customer name. */
  customerInitials: string;
  customerText: string;
  /** The commercial date (the organization's calendar day), dd/mm/aaaa. */
  dateText: string;
  detailHref: string;
  id: string;
  itemCountText: string;
  methodText: string;
  returnsBadge: string | null;
  statusLabel: string;
  statusTone: "cancelled" | "confirmed";
  /** Local time of the sale on this device, or empty when unreadable. */
  timeText: string;
  totalText: string;
}

const timeFormatter = new Intl.DateTimeFormat("pt-BR", { timeStyle: "short" });

function timeOf(instant: string): string {
  const date = new Date(instant);
  return Number.isNaN(date.getTime()) ? "" : timeFormatter.format(date);
}

function rowCustomerText(sale: SaleListEntryReadModel): string {
  if (sale.customerId === null) {
    return "Sem cliente";
  }
  return sale.customerName ?? "Cliente indisponível";
}

const NAME_SPACES = /\s+/u;

function rowCustomerInitials(sale: SaleListEntryReadModel): string {
  const words = (sale.customerName ?? "").trim().split(NAME_SPACES);
  const [first] = words;
  const last = words.length > 1 ? words.at(-1) : undefined;
  const letters = [first, last].map((word) => Array.from(word ?? "")[0] ?? "");
  return letters.join("").toLocaleUpperCase("pt-BR") || "—";
}

export function historyRows(state: HistoryState): HistoryRow[] {
  return state.sales.map((sale) => ({
    backdated: sale.occurredOn < localDay(sale.confirmedAt),
    customerInitials: rowCustomerInitials(sale),
    customerText: rowCustomerText(sale),
    dateText: formatCalendarDate(sale.occurredOn),
    detailHref: saleDetailHref(sale.id),
    id: sale.id,
    itemCountText: `${sale.itemCount} ${sale.itemCount === 1 ? "item" : "itens"}`,
    methodText:
      sale.paymentMethod === null
        ? "Pagamento não informado"
        : (methodLabels.get(sale.paymentMethod) ?? sale.paymentMethod),
    returnsBadge: sale.hasReturns ? RETURNS_BADGE : null,
    statusLabel: sale.status === "cancelled" ? "Cancelada" : "Confirmada",
    statusTone: sale.status,
    timeText: timeOf(sale.occurredAt),
    totalText: formatBrlAmount(sale.totalDue),
  }));
}

export interface HistoryTotal {
  countText: string;
  noteText: string;
  /** "R$ 1.454,41", or null when an amount cannot be read. */
  totalText: string | null;
}

/**
 * The total of the sales on the screen: the confirmed ones only (a cancelled sale is not money), at the amount
 * each row shows (the total due, returns not taken off). The note says how many cancelled ones stayed out, and the
 * count says "há mais" while another page is pending, so the sum is not read as the total of the period.
 */
export function historyTotal(
  sales: readonly SaleListEntryReadModel[],
  hasMore = false
): HistoryTotal {
  const counted = sales.filter((sale) => sale.status !== "cancelled");
  const left = sales.length - counted.length;
  const sum = sumBrlAmounts(counted.map((sale) => sale.totalDue));
  return {
    countText: `${counted.length} ${counted.length === 1 ? "venda" : "vendas"}${hasMore ? " · há mais" : ""}`,
    noteText:
      left === 0
        ? ""
        : `${left} ${left === 1 ? "cancelada fica fora" : "canceladas ficam fora"} da soma.`,
    totalText: sum === null ? null : formatBrlAmount(sum),
  };
}

export type HistoryView =
  | { kind: "loading"; message: string }
  | { kind: "error"; message: string }
  | {
      clearFilters: boolean;
      href: string | null;
      kind: "empty";
      message: string;
    }
  | { kind: "ready"; rows: HistoryRow[] };

export function historyView(
  state: HistoryState,
  filters: HistoryFilters = emptyHistoryFilters
): HistoryView {
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
    return activeFilterCount(filters) > 0
      ? {
          clearFilters: true,
          href: null,
          kind: "empty",
          message: "Nenhuma venda encontrada com estes filtros.",
        }
      : {
          clearFilters: false,
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

interface ReturnHistoryEntry {
  dateText: string;
  id: string;
  lines: Array<{ key: string; text: string }>;
  noteText: string | null;
  reasonText: string;
}

export interface SaleDetailView {
  /** Set when every unit was already returned (nothing left to return). */
  allReturnedMessage: string | null;
  canCancel: boolean;
  /** A sale with returns is not cancelled as a whole; this says why. */
  cancelBlockedReason: string | null;
  cancellation: CancellationView | null;
  canReturn: boolean;
  hasReturns: boolean;
  returnPanelKey: string;
  returnRows: ReturnTableRow[];
  returnsBadge: string | null;
  returnsHistory: ReturnHistoryEntry[];
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

function returnsHistory(
  detail: SaleDetailReadModel,
  labels: ReadonlyMap<number, string>
): ReturnHistoryEntry[] {
  return [...detail.returns]
    .sort((left, right) => right.returnedAt.localeCompare(left.returnedAt))
    .map((entry) => ({
      dateText: formatInstant(entry.returnedAt),
      id: entry.id,
      lines: entry.items.map((line) => ({
        key: `${entry.id}-${line.position}`,
        text: `${labels.get(line.position) ?? `Item ${line.position + 1}`}: devolvidas ${line.returnedQuantity} · voltaram ao estoque ${line.restockedQuantity}`,
      })),
      noteText: entry.reasonNote,
      reasonText: returnReasonLabel(entry.reasonCode),
    }));
}

/**
 * What the page offers for cancelling the whole sale. Right after a success (a return) the page still holds the
 * old detail until the new one is read: it must not offer a second "Cancelar venda" for a state that is already
 * gone, so it waits (U-20).
 */
export function cancelOffer(
  view: Pick<SaleDetailView, "canCancel">,
  refreshing: boolean
): "none" | "panel" | "waiting" {
  if (!view.canCancel) {
    return "none";
  }
  return refreshing ? "waiting" : "panel";
}

/**
 * Display model of a sale, its cancellation and its returns. The confirmed
 * snapshot is never changed. A cancelled sale takes no returns, and a sale
 * with returns cannot be cancelled as a whole.
 */
export function saleDetailView(detail: SaleDetailReadModel): SaleDetailView {
  const cancelled = detail.cancellation !== null;
  const hasReturns = detail.returns.length > 0;
  const labels = new Map(
    detail.sale.items.map((item) => [item.position, item.productLabel])
  );
  const returnRows = returnTableRows(detail.returnSummary, labels);
  const available = totalAvailable(returnRows);
  return {
    allReturnedMessage:
      !cancelled && hasReturns && available === 0
        ? "Todas as unidades já foram devolvidas."
        : null,
    canCancel: !(cancelled || hasReturns),
    cancelBlockedReason:
      !cancelled && hasReturns
        ? "Esta venda já tem devoluções, por isso não pode ser cancelada por inteiro."
        : null,
    cancellation: detail.cancellation
      ? cancellationView(detail.cancellation)
      : null,
    canReturn: !cancelled && available > 0,
    hasReturns,
    returnPanelKey: returnPanelKey(returnRows),
    returnRows,
    returnsBadge: hasReturns ? RETURNS_BADGE : null,
    returnsHistory: returnsHistory(detail, labels),
    sale: confirmedSaleView({ ...detail.sale, replayed: false }),
    saleId: detail.sale.sale.id,
    statusLabel: cancelled ? "Cancelada" : "Confirmada",
    statusTone: cancelled ? "cancelled" : "confirmed",
  };
}

type SaleTimelineKind = "cancelled" | "registered" | "return" | "sale";

export interface SaleTimelineEvent {
  /** The instant, for the `datetime` of the line. */
  at: string;
  key: string;
  kind: SaleTimelineKind;
  label: string;
  /** Where the sale stands: the only dot with a color of its own. */
  tone: "cancelled" | "muted" | "sale";
  /** The device's local time, with the year only when it differs from the sale's. */
  timeText: string;
}

/** A confirmation less than this long after the sale says the same as "Venda feita", so it is not a line. */
const REGISTERED_GAP_MS = 60_000;

/** Newest first, a tie goes to the later step of the story. */
const TIMELINE_TIE_ORDER: Record<SaleTimelineKind, number> = {
  cancelled: 0,
  return: 1,
  registered: 2,
  sale: 3,
};

const timelineFormatter = new Intl.DateTimeFormat("pt-BR", {
  day: "numeric",
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  month: "short",
  year: "numeric",
});

function timelineParts(instant: string): Map<string, string> | null {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return new Map(
    timelineFormatter.formatToParts(date).map((part) => [part.type, part.value])
  );
}

function timelineText(instant: string, saleInstant: string): string {
  const parts = timelineParts(instant);
  if (parts === null) {
    return instant;
  }
  const month = (parts.get("month") ?? "").replace(".", "");
  const year = parts.get("year") ?? "";
  const sameYear = timelineParts(saleInstant)?.get("year") === year;
  const date = `${parts.get("day")} ${month}${sameYear ? "" : ` ${year}`}`;
  return `${date} ${parts.get("hour")}:${parts.get("minute")}`;
}

/**
 * What happened to a sale and when, newest first: made, registered (only when the server took it 60 s or more after
 * it happened), each return, cancelled. Two instants that are the same moment keep the order of the story, and the
 * comparison is by instant, not by day. The caller shows the list only with two events or more.
 */
export function saleTimelineEvents(
  detail: SaleDetailReadModel
): SaleTimelineEvent[] {
  const { confirmedAt, occurredAt } = detail.sale.sale;
  const cancelled = detail.cancellation !== null;
  const at = (instant: string) => timelineText(instant, occurredAt);
  const events: SaleTimelineEvent[] = [
    {
      at: occurredAt,
      key: "sale",
      kind: "sale",
      label: "Venda feita",
      timeText: at(occurredAt),
      tone: cancelled ? "muted" : "sale",
    },
  ];
  if (Date.parse(confirmedAt) - Date.parse(occurredAt) >= REGISTERED_GAP_MS) {
    events.push({
      at: confirmedAt,
      key: "registered",
      kind: "registered",
      label: "Confirmada no servidor",
      timeText: at(confirmedAt),
      tone: "muted",
    });
  }
  for (const entry of detail.returns) {
    events.push({
      at: entry.returnedAt,
      key: `return-${entry.id}`,
      kind: "return",
      label: "Devolução",
      timeText: at(entry.returnedAt),
      tone: "muted",
    });
  }
  if (detail.cancellation) {
    events.push({
      at: detail.cancellation.cancelledAt,
      key: "cancelled",
      kind: "cancelled",
      label: "Cancelada",
      timeText: at(detail.cancellation.cancelledAt),
      tone: "cancelled",
    });
  }
  return events.sort(
    (left, right) =>
      Date.parse(right.at) - Date.parse(left.at) ||
      TIMELINE_TIE_ORDER[left.kind] - TIMELINE_TIE_ORDER[right.kind] ||
      left.key.localeCompare(right.key)
  );
}

/** Message for a sale that failed to load. */
export function detailLoadErrorMessage(error: unknown): string {
  return rpcErrorReason(error) === "sale_not_found"
    ? "Esta venda não foi encontrada nesta loja. Confira o identificador da venda."
    : loadErrorMessage(error, "a venda");
}
