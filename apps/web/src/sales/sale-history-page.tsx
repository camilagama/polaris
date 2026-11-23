import type { SaleListEntryReadModel } from "@polaris/contracts";
import { hasCapabilityForRole } from "@polaris/domain/authorization/capabilities";
import ArrowRightIcon from "lucide-react/dist/esm/icons/arrow-right";
import CloudOffIcon from "lucide-react/dist/esm/icons/cloud-off";
import RefreshCwIcon from "lucide-react/dist/esm/icons/refresh-cw";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { Button, buttonVariants } from "@/ui/button";
import { Card } from "@/ui/card";
import { Skeleton } from "@/ui/skeleton";
import {
  dropNavigationState,
  navigateInApp,
  readNavigationState,
} from "../app-shell/address";
import { TitleLine } from "../app-shell/screen-title";
import { ListTotalFooter } from "../catalog/screen-parts";
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
import { SavedSalesCard } from "./offline-sale-panels";
import { HistoryEmptyCard } from "./sale-history-empty";
import { HistoryFiltersBar, HistoryPeriodPicker } from "./sale-history-filters";
import { SaleHistoryList } from "./sale-history-list";
import {
  emptyHistoryFilters,
  type HistoryFilters,
  historyFooterView,
  historyView,
  type LoadMoreView,
  loadMoreView,
  PERIOD_TOTAL_HELP,
  PERIOD_TOTAL_LABEL,
  type PeriodTotalRead,
  periodTotalPeriod,
  statusFromState,
} from "./sale-history-model";
import {
  clearHistoryReturn,
  type HistoryReturn,
  readHistoryReturn,
  rememberHistoryReturn,
} from "./history-return";
import { sessionStorageOrNull } from "./sale-attempt-storage";
import { useHistoryPeriodTotal } from "./use-history-period-total";
import { useSaleHistory } from "./use-sale-history";

function OfflineHistoryNotice() {
  return (
    <Alert variant="warning">
      <CloudOffIcon aria-hidden="true" />
      <AlertTitle>Sem conexão.</AlertTitle>
      <AlertDescription>
        Estas são as vendas mais recentes guardadas neste aparelho (as últimas
        100 que o servidor confirmou); detalhes, busca por item e vendas mais
        antigas só com conexão.
      </AlertDescription>
    </Alert>
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

const LOADING_ROWS = [0, 1, 2];

/** Loading: three rows of skeleton in the card, and the line that says it for the screen reader. */
function LoadingCard({ message }: { message: string }) {
  return (
    <Card aria-busy="true" className="gap-3 px-(--card-spacing)" role="status">
      <p className="sr-only">{message}</p>
      {LOADING_ROWS.map((row) => (
        <div aria-hidden="true" className="grid gap-1.5" key={row}>
          <Skeleton className="h-3.5 w-2/3" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      ))}
    </Card>
  );
}

/** With the chevron on the rows (16 px and a gap of 8, 12 from 760 px), the total ends where their figures end. */
const TOTAL_UNDER_VALUES =
  "border-t pr-[calc(0.625rem+1.5rem)] md:pr-[calc(1rem+1.75rem)]";

/** What the foot of the history needs to say its total: see `historyFooterView`. */
interface HistoryFooterInput {
  filters: HistoryFilters;
  hasMore: boolean;
  listLoading: boolean;
  offline: boolean;
  read: PeriodTotalRead;
  sales: readonly SaleListEntryReadModel[];
}

function HistoryTotalFooter({
  className,
  ...input
}: HistoryFooterInput & { className?: string | undefined }) {
  const view = historyFooterView(input);
  return (
    <ListTotalFooter
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
  const footerInput = { filters, offline, read: periodRead };
  const view = historyView(state, filters);
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
          <h1 className="text-title" ref={focus.title} tabIndex={-1}>
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
          <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {LIST_REFRESH_FAILED_TEXT}
            <Button
              onBlur={focus.onBlur}
              onClick={reload}
              onFocus={focus.onFocus}
              size="sm"
              type="button"
              variant="link"
            >
              <RefreshCwIcon aria-hidden="true" data-icon="inline-start" />
              Tentar novamente
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {view.kind === "loading" ? (
        <>
          <LoadingCard message={view.message} />
          <Card className="gap-0 overflow-hidden py-0">
            <HistoryTotalFooter
              {...footerInput}
              hasMore={false}
              listLoading
              sales={state.sales}
            />
          </Card>
        </>
      ) : null}
      {view.kind === "error" ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {view.message}
            <Button
              onBlur={focus.onBlur}
              onClick={reload}
              onFocus={focus.onFocus}
              size="sm"
              type="button"
              variant="link"
            >
              <RefreshCwIcon aria-hidden="true" data-icon="inline-start" />
              Tentar novamente
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {view.kind === "empty" ? (
        <>
          <HistoryEmptyCard onClearFilters={handleClearFilters} view={view} />
          <Card className="gap-0 overflow-hidden py-0">
            <HistoryTotalFooter
              {...footerInput}
              hasMore={false}
              listLoading={false}
              sales={state.sales}
            />
          </Card>
        </>
      ) : null}
      {view.kind === "ready" ? (
        <SaleHistoryList
          footer={
            <HistoryTotalFooter
              {...footerInput}
              className={offline ? "border-t" : TOTAL_UNDER_VALUES}
              hasMore={state.hasMore}
              listLoading={false}
              sales={state.sales}
            />
          }
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
