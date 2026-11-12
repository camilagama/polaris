import type { SaleListEntryReadModel } from "@polaris/contracts";
import { hasCapabilityForRole } from "@polaris/domain/authorization/capabilities";
import ArrowRightIcon from "lucide-react/dist/esm/icons/arrow-right";
import CloudOffIcon from "lucide-react/dist/esm/icons/cloud-off";
import RefreshCwIcon from "lucide-react/dist/esm/icons/refresh-cw";
import { useCallback, useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";
import { Skeleton } from "@/ui/skeleton";
import {
  dropNavigationState,
  navigateInApp,
  readNavigationState,
} from "../app-shell/address";
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
import { useLocalWorkspace } from "../offline/runtime/use-local-workspace";
import { todayOr } from "../ui/date-values";
import { SavedSalesCard } from "./offline-sale-panels";
import { HistoryEmptyCard } from "./sale-history-empty";
import { HistoryFiltersBar } from "./sale-history-filters";
import { SaleHistoryList } from "./sale-history-list";
import {
  emptyHistoryFilters,
  historyTotal,
  historyView,
  loadMoreView,
  statusFromState,
} from "./sale-history-model";
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

/** "Ver o resultado deste período": a line of its own under the pills, since everything in the row of the pills filters. */
function ResultLink({ period }: { period: Period }) {
  const handleClick = useCallback(
    () => navigateInApp("/dashboard", { [RESULT_PERIOD_STATE]: period }),
    [period]
  );
  return (
    <button
      aria-label={`Ver o resultado deste período, de ${periodRangeLabel(period, todayOr(undefined))}`}
      className="touch-hit focus-ring inline-flex h-ctl-sm w-fit items-center gap-1 whitespace-nowrap rounded-sm font-medium text-foreground text-sm hover:underline"
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

/** The total of the sales on the screen; while the first page loads it is a dash, in a box of the same height. */
function HistoryTotalFooter({
  className,
  hasMore,
  loading,
  sales,
}: {
  className?: string | undefined;
  loading: boolean;
  hasMore: boolean;
  sales: readonly SaleListEntryReadModel[];
}) {
  const total = historyTotal(sales, hasMore);
  return (
    <ListTotalFooter
      className={className}
      count={loading ? "" : total.countText}
      note={loading ? "" : total.noteText}
      value={loading ? "…" : (total.totalText ?? "—")}
    />
  );
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
  const [initialPeriod] = useState(() =>
    periodFromState(readNavigationState(HISTORY_PERIOD_STATE))
  );
  const [initialStatus] = useState(() =>
    statusFromState(readNavigationState(HISTORY_STATUS_STATE))
  );
  useEffect(() => {
    dropNavigationState(HISTORY_PERIOD_STATE);
    dropNavigationState(HISTORY_STATUS_STATE);
  }, []);
  const { filters, loadMore, reload, setFilters, state } = useSaleHistory(
    organizationId,
    offlineWorkspace,
    {
      ...emptyHistoryFilters,
      ...(initialPeriod
        ? { from: initialPeriod.from, to: initialPeriod.to }
        : {}),
      status: initialStatus,
    }
  );
  const resultPeriod =
    offline || !hasCapabilityForRole(organization.role, "report:read")
      ? null
      : resultPeriodOf(filters);
  const view = historyView(state, filters);
  const handleClearFilters = useCallback(
    () => setFilters(emptyHistoryFilters),
    [setFilters]
  );
  const more = loadMoreView(state);

  return (
    <div className="grid gap-4 font-sans text-foreground text-sm antialiased">
      <h1 className="text-title">Histórico de vendas</h1>
      {offline ? <OfflineHistoryNotice /> : null}
      <SavedSalesCard workspace={workspace} />
      <HistoryFiltersBar
        filters={filters}
        offline={offline}
        onChange={setFilters}
      />
      {resultPeriod ? <ResultLink period={resultPeriod} /> : null}
      {view.kind === "loading" ? (
        <>
          <LoadingCard message={view.message} />
          <Card className="gap-0 overflow-hidden py-0">
            <HistoryTotalFooter hasMore={false} loading sales={state.sales} />
          </Card>
        </>
      ) : null}
      {view.kind === "error" ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {view.message}
            <Button onClick={reload} size="sm" type="button" variant="link">
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
              hasMore={false}
              loading={false}
              sales={state.sales}
            />
          </Card>
        </>
      ) : null}
      {view.kind === "ready" ? (
        <SaleHistoryList
          footer={
            <HistoryTotalFooter
              className={offline ? "border-t" : TOTAL_UNDER_VALUES}
              hasMore={state.hasMore}
              loading={false}
              sales={state.sales}
            />
          }
          offline={offline}
          rows={view.rows}
        />
      ) : null}
      <div aria-live="polite" role="status">
        {more.busy ? (
          <p className="text-muted-foreground">Carregando mais vendas…</p>
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
          onClick={loadMore}
          type="button"
          variant="outline"
        >
          {more.label}
        </Button>
      ) : null}
    </div>
  );
}
