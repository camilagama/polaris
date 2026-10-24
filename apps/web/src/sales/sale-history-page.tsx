import CloudOffIcon from "lucide-react/dist/esm/icons/cloud-off";
import RefreshCwIcon from "lucide-react/dist/esm/icons/refresh-cw";
import type { ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";
import { Skeleton } from "@/ui/skeleton";
import { useCurrentOrganization } from "../lib/current-organization";
import { useLocalWorkspace } from "../offline/runtime/use-local-workspace";
import { SavedSalesCard } from "./offline-sale-panels";
import { HistoryFiltersBar } from "./sale-history-filters";
import { SaleHistoryList } from "./sale-history-list";
import { historyView, loadMoreView } from "./sale-history-model";
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

const LOADING_ROWS = [0, 1, 2];

/** A line of text in a card, for empty: the same card the products and the stock use. */
function StateCard({ children }: { children: ReactNode }) {
  return (
    <Card className="items-center px-(--card-spacing) text-center">
      <p className="text-muted-foreground">{children}</p>
    </Card>
  );
}

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

/** Newest-first list of confirmed and cancelled sales, filterable on the server. */
export function SaleHistoryPage() {
  const { organizationId } = useCurrentOrganization();
  const workspace = useLocalWorkspace(organizationId);
  // The server's history whenever it is reachable; only without a connection
  // the device's window of recent sales.
  const offlineWorkspace =
    workspace !== null && !workspace.online ? workspace : null;
  const offline = offlineWorkspace !== null;
  const { filters, loadMore, period, reload, reset, setFilters, state } =
    useSaleHistory(organizationId, offlineWorkspace);
  const view = historyView(state, filters);
  const more = loadMoreView(state);

  return (
    <div className="grid gap-4 font-sans text-foreground text-sm antialiased">
      <header className="grid gap-1">
        <h1 className="text-title">Histórico de vendas</h1>
        <p className="text-muted-foreground text-support">
          Da mais recente para a mais antiga. Abra uma venda para ver o
          registro, devolver, cancelar ou ajustar o cliente.
        </p>
      </header>
      {offline ? <OfflineHistoryNotice /> : null}
      <SavedSalesCard workspace={workspace} />
      <HistoryFiltersBar
        filters={filters}
        offline={offline}
        onChange={setFilters}
        onReset={reset}
        period={period}
      />
      {view.kind === "loading" && period === null ? (
        <LoadingCard message={view.message} />
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
        <StateCard>
          {view.message}
          {view.href ? (
            <>
              {" "}
              <a
                className="touch-hit focus-ring rounded-sm underline decoration-input underline-offset-4 hover:decoration-foreground"
                href={view.href}
              >
                Registrar uma venda
              </a>
            </>
          ) : null}
        </StateCard>
      ) : null}
      {view.kind === "ready" ? (
        <SaleHistoryList offline={offline} rows={view.rows} />
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
