import { hasCapabilityForRole } from "@polaris/domain/authorization/capabilities";
import ArrowRightIcon from "lucide-react/dist/esm/icons/arrow-right";
import { useCallback, useEffect, useRef, useState } from "react";
import { withoutRetryAsk } from "@/lib/retry-notice";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button, buttonVariants } from "@/ui/button";
import { ListBlock } from "@/ui/list-block";
import { RetryButton } from "@/ui/retry-button";
import {
  dropNavigationState,
  navigateInApp,
  readNavigationState,
} from "../app-shell/address";
import { OfflineNotice } from "../app-shell/offline-notice";
import { SCREEN_TITLE_CLASS, TitleLine } from "../app-shell/screen-title";
import {
  HISTORY_PERIOD_STATE,
  HISTORY_STATUS_STATE,
  type Period,
  periodFromState,
  periodRangeLabel,
  RESULT_PERIOD_STATE,
  rangeProblem,
} from "../dashboard/result-period";
import { useCurrentOrganization } from "../lib/current-organization";
import {
  LIST_REFRESH_FAILED_TEXT,
  LIST_REFRESHING_TEXT,
} from "../lib/list-refresh-text";
import { useFocusTitleWhenGone } from "../lib/use-focus-title-when-gone";
import { useLocalWorkspace } from "../offline/runtime/use-local-workspace";
import { todayOr } from "../ui/date-values";
import {
  clearHistoryReturn,
  type HistoryReturn,
  readHistoryReturn,
  rememberHistoryReturn,
} from "./history-return";
import { SavedSalesCard } from "./offline-sale-panels";
import { sessionStorageOrNull } from "./sale-attempt-storage";
import { HistoryEmptyCard, HistoryNothingYet } from "./sale-history-empty";
import { HistoryFiltersBar, HistoryPeriodPicker } from "./sale-history-filters";
import { SaleHistoryList, SaleHistoryNoRows } from "./sale-history-list";
import {
  emptyHistoryFilters,
  type HistoryFilters,
  type HistoryFooterView,
  type HistoryView,
  historyFooterView,
  historyListCount,
  historyView,
  type LoadMoreView,
  loadMoreView,
  PERIOD_TOTAL_HELP,
  PERIOD_TOTAL_LABEL,
  periodTotalPeriod,
  statusFromState,
} from "./sale-history-model";
import { useHistoryPeriodTotal } from "./use-history-period-total";
import { useSaleHistory } from "./use-sale-history";

function OfflineHistoryNotice() {
  return (
    <OfflineNotice>
      Estas são as vendas mais recentes guardadas neste aparelho (as últimas 100
      que o servidor confirmou); detalhes, busca por item e vendas mais antigas
      só com conexão.
    </OfflineNotice>
  );
}

const RESULT_LINK_CLASS = cn(
  buttonVariants({ size: "sm", variant: "ghost" }),
  "w-fit"
);

/** "Ver o resultado deste período": a line of its own under the pills, since everything in the row of the pills filters. */
function ResultLink({ period }: { period: Period }) {
  const handleClick = useCallback(
    () => navigateInApp("/dashboard", { [RESULT_PERIOD_STATE]: period }),
    [period]
  );
  return (
    <button
      aria-label={`Ver o resultado deste período, de ${periodRangeLabel(period, todayOr(undefined))}`}
      className={RESULT_LINK_CLASS}
      data-history-result-link=""
      onClick={handleClick}
      type="button"
    >
      Ver o resultado deste período
      <ArrowRightIcon aria-hidden="true" className="size-4" />
    </button>
  );
}

/** The period of the pill, when the Resultado can read it: both ends, in order, within its limit of a year. */
function resultPeriodOf(filters: { from: string; to: string }): Period | null {
  return filters.from !== "" &&
    filters.to !== "" &&
    rangeProblem(filters.from, filters.to) === null
    ? { from: filters.from, to: filters.to }
    : null;
}

/** With the chevron on the rows (16 px and a gap of 8, 12 from 760 px), the total ends where their figures end. */
const TOTAL_UNDER_VALUES =
  "pr-[calc(0.625rem+1.5rem)] md:pr-[calc(1rem+1.75rem)]";

/** The total as the last line of the frame: a plain call, not a component, because the frame takes the total by the type of its child. */
function historyTotalLine(view: HistoryFooterView, className?: string) {
  return (
    <ListBlock.Total
      className={className}
      count={view.count}
      help={
        view.hasHelp
          ? { about: PERIOD_TOTAL_LABEL, text: PERIOD_TOTAL_HELP }
          : undefined
      }
      label={view.label}
      note={view.note}
      notice={view.notice}
      value={view.value}
      valueLoading={view.valueLoading}
    />
  );
}

/** No filter on: only the empty state. A filter, a search or a period with no result: the frame with the sentence and the total. */
function HistoryNoSales({
  footer,
  onClearFilters,
  view,
}: {
  footer: HistoryFooterView;
  onClearFilters: () => void;
  view: Extract<HistoryView, { kind: "empty" }>;
}) {
  if (!view.clearFilters) {
    return <HistoryNothingYet view={view} />;
  }
  return (
    <SaleHistoryNoRows
      count={historyListCount(view, false)}
      notice={<HistoryEmptyCard onClearFilters={onClearFilters} view={view} />}
      state="filtered-empty"
      total={historyTotalLine(footer)}
    />
  );
}

/** "Carregar mais", the retry of the refresh warning and the retry of the full-screen error never show together, and a re-read always passes through a loading render between them, so the hook sees one render with none. */
function hasFocusableControl(
  more: LoadMoreView,
  fullScreenError: boolean
): boolean {
  return more.visible || more.refreshFailed || fullScreenError;
}

function returnedFilters(
  returned: HistoryReturn | null
): HistoryFilters | null {
  return returned
    ? { ...returned.filters, status: statusFromState(returned.filters.status) }
    : null;
}

/**
 * The filters the Histórico opens with: what "Voltar" of the detail gives back, else the period and the situation the
 * Resultado left in the entry, else none. What was given back is dropped once the page is on screen, as the
 * navigation state is: a reload opens the page as the menu opens it.
 */
function useOpeningHistory(organizationId: string): {
  filters: HistoryFilters;
  scrollY: number;
} {
  const [opening] = useState(() => {
    const returned = readHistoryReturn(sessionStorageOrNull(), organizationId);
    const period = periodFromState(readNavigationState(HISTORY_PERIOD_STATE));
    const status = statusFromState(readNavigationState(HISTORY_STATUS_STATE));
    return {
      filters: returnedFilters(returned) ?? {
        ...emptyHistoryFilters,
        ...(period ? { from: period.from, to: period.to } : {}),
        status,
      },
      scrollY: returned?.scrollY ?? 0,
    };
  });
  useEffect(() => {
    dropNavigationState(HISTORY_PERIOD_STATE);
    dropNavigationState(HISTORY_STATUS_STATE);
    clearHistoryReturn(sessionStorageOrNull());
  }, []);
  return opening;
}

function useRememberHistoryOnOpen(
  organizationId: string,
  filters: HistoryFilters
): (saleId: string) => void {
  const filtersNow = useRef(filters);
  filtersNow.current = filters;
  return useCallback(
    (saleId: string) =>
      rememberHistoryReturn(sessionStorageOrNull(), organizationId, saleId, {
        filters: filtersNow.current,
        scrollY: window.scrollY,
      }),
    [organizationId]
  );
}

function useScrollBackOnce(listReady: boolean, scrollY: number): void {
  const pending = useRef(scrollY);
  useEffect(() => {
    if (listReady && pending.current > 0) {
      window.scrollTo({ top: pending.current });
      pending.current = 0;
    }
  }, [listReady]);
}

/** Newest-first list of confirmed and cancelled sales, filterable on the server. */
export function SaleHistoryPage() {
  const { organization, organizationId } = useCurrentOrganization();
  const workspace = useLocalWorkspace(organizationId);
  // The server's history whenever it is reachable; only without a connection
  // the device's window of recent sales.
  const offlineWorkspace =
    workspace !== null && !workspace.online ? workspace : null;
  const offline = offlineWorkspace !== null;
  const opening = useOpeningHistory(organizationId);
  const {
    filters,
    listKey,
    loadMore,
    reload,
    reloadVersion,
    setFilters,
    state,
  } = useSaleHistory(organizationId, offlineWorkspace, opening.filters);
  const resultPeriod =
    offline || !hasCapabilityForRole(organization.role, "report:read")
      ? null
      : resultPeriodOf(filters);
  const periodRead = useHistoryPeriodTotal(
    organizationId,
    offline ? null : periodTotalPeriod(filters),
    reloadVersion
  );
  const view = historyView(state, filters);
  const footer = historyFooterView({
    filters,
    hasMore: view.kind === "ready" && state.hasMore,
    listLoading: view.kind === "loading",
    offline,
    read: periodRead,
    sales: state.sales,
  });
  const handleClearFilters = useCallback(
    () => setFilters(emptyHistoryFilters),
    [setFilters]
  );
  const more = loadMoreView(state, listKey);
  const handleOpenSale = useRememberHistoryOnOpen(organizationId, filters);
  useScrollBackOnce(view.kind === "ready", opening.scrollY);
  const focus = useFocusTitleWhenGone<HTMLHeadingElement>(
    hasFocusableControl(more, view.kind === "error")
  );

  return (
    <div className="grid gap-4 font-sans text-foreground text-sm antialiased">
      <header className="grid gap-1">
        <TitleLine
          action={
            <HistoryPeriodPicker filters={filters} onChange={setFilters} />
          }
        >
          <h1 className={SCREEN_TITLE_CLASS} ref={focus.title} tabIndex={-1}>
            Histórico de vendas
          </h1>
        </TitleLine>
      </header>
      {offline ? <OfflineHistoryNotice /> : null}
      <SavedSalesCard countStyle="items" workspace={workspace} />
      <HistoryFiltersBar
        filters={filters}
        offline={offline}
        onChange={setFilters}
        onClearAll={handleClearFilters}
      />
      {resultPeriod ? <ResultLink period={resultPeriod} /> : null}
      {more.refreshFailed ? (
        <Alert variant="warning">
          <AlertDescription className="grid justify-items-start gap-2">
            {LIST_REFRESH_FAILED_TEXT}
            <RetryButton
              onBlur={focus.onBlur}
              onClick={reload}
              onFocus={focus.onFocus}
            />
          </AlertDescription>
        </Alert>
      ) : null}
      {view.kind === "loading" ? (
        <SaleHistoryNoRows
          count={historyListCount(view, false)}
          state="loading"
          total={historyTotalLine(footer)}
        />
      ) : null}
      {view.kind === "error" ? (
        <Alert variant="destructive">
          <AlertDescription className="grid justify-items-start gap-2">
            {withoutRetryAsk(view.message)}
            <RetryButton
              onBlur={focus.onBlur}
              onClick={reload}
              onFocus={focus.onFocus}
            />
          </AlertDescription>
        </Alert>
      ) : null}
      {view.kind === "empty" ? (
        <HistoryNoSales
          footer={footer}
          onClearFilters={handleClearFilters}
          view={view}
        />
      ) : null}
      {view.kind === "ready" ? (
        <SaleHistoryList
          count={historyListCount(view, state.hasMore)}
          footer={historyTotalLine(
            footer,
            offline ? undefined : TOTAL_UNDER_VALUES
          )}
          offline={offline}
          onOpen={handleOpenSale}
          rows={view.rows}
        />
      ) : null}
      <div aria-live="polite" role="status">
        {more.busy ? (
          <p className="text-muted-foreground">Carregando mais vendas…</p>
        ) : null}
        {more.refreshing && !offline ? (
          <p className="text-muted-foreground">{LIST_REFRESHING_TEXT}</p>
        ) : null}
      </div>
      {more.error ? (
        <Alert variant="destructive">
          <AlertDescription>{more.error}</AlertDescription>
        </Alert>
      ) : null}
      {more.visible ? (
        <Button
          className="justify-self-start"
          disabled={more.busy}
          onBlur={focus.onBlur}
          onClick={loadMore}
          onFocus={focus.onFocus}
          type="button"
          variant="outline"
        >
          {more.label}
        </Button>
      ) : null}
    </div>
  );
}
