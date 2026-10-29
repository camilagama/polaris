import CloudOffIcon from "lucide-react/dist/esm/icons/cloud-off";
import RefreshCwIcon from "lucide-react/dist/esm/icons/refresh-cw";
import {
  type MouseEvent,
  type ReactNode,
  useCallback,
  useMemo,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";
import { Checkbox } from "@/ui/checkbox";
import { Field, FieldLabel } from "@/ui/field";
import { SearchField } from "@/ui/search-field";
import { Skeleton } from "@/ui/skeleton";
import { StatusNav } from "../catalog/screen-parts";
import { useCurrentOrganization } from "../lib/current-organization";
import { calendarDayInTimezone } from "../lib/dates";
import { focusLater } from "../lib/focus";
import { useLocalWorkspace } from "../offline/runtime/use-local-workspace";
import { STOCK_ACTIONS, type StockAction } from "./stock-command-model";
import { StockCommandPanel } from "./stock-command-panel";
import {
  PANEL_OPEN_REASON,
  PANEL_OPEN_REASON_ID,
  RowActions,
  triggerId,
} from "./stock-row-actions";
import {
  STOCK_FILTERS,
  type StockFilter,
  type StockRow,
  stockCountText,
  stockListView,
  stockMoreView,
  readStockLinkFilters,
} from "./stock-list-model";
import { type StockTarget, stockTarget } from "./stock-target";
import { useStockList } from "./use-stock-list";

interface OpenCommand {
  action: StockAction;
  /** The balance as the row showed it when the panel opened. */
  target: StockTarget;
}

/** A link inside a sentence: no touch area of its own (a line of text), only the focus ring. */
const LINK =
  "focus-ring rounded-sm underline decoration-input underline-offset-4 hover:decoration-foreground";
/** A link on a line of its own: it gets the 44 px touch area. */
const STANDALONE_LINK = `touch-hit ${LINK}`;

function isStockAction(value: string | undefined): value is StockAction {
  return STOCK_ACTIONS.some((action) => action === value);
}

/** Said at the top of the screen while there is no connection. */
function OfflineStockNotice() {
  return (
    <Alert variant="warning">
      <CloudOffIcon aria-hidden="true" />
      <AlertTitle>Sem conexão.</AlertTitle>
      <AlertDescription>
        O saldo é o do aparelho, com o que está na fila. Receber, contar e
        baixar ficam guardados e vão quando a conexão voltar (acompanhe em{" "}
        <a className={LINK} href="/attention">
          Pendências
        </a>
        ). O custo médio só aparece com conexão.
      </AlertDescription>
    </Alert>
  );
}

interface FigureProps {
  children: ReactNode;
  className?: string | undefined;
  label: string;
}

function Figure({ children, className, label }: FigureProps) {
  return (
    <div className={cn("grid min-w-0 content-start gap-0.5", className)}>
      <dt className="text-muted-foreground text-support">{label}</dt>
      <dd className="[overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

interface StockItemProps {
  children: ReactNode;
  onOpen: (event: MouseEvent<HTMLButtonElement>) => void;
  otherPanelOpen: boolean;
  panelOpen: boolean;
  row: StockRow;
}

function StockItem({
  children,
  onOpen,
  otherPanelOpen,
  panelOpen,
  row,
}: StockItemProps) {
  return (
    <li
      className={cn(
        "grid gap-3 p-(--card-spacing)",
        panelOpen && "bg-muted/50"
      )}
      data-open={panelOpen ? "" : undefined}
    >
      <div className="grid gap-3 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1.5fr)_auto] md:items-center md:gap-6">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium [overflow-wrap:anywhere]">
            {row.productName}
            {row.archived ? <Badge variant="outline">Arquivado</Badge> : null}
          </p>
          <p className="text-muted-foreground text-support [overflow-wrap:anywhere]">
            {row.variantText}
            {row.skuText ? (
              <>
                {" "}
                · <span className="font-mono">SKU {row.skuText}</span>
              </>
            ) : null}
          </p>
        </div>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-support md:grid-cols-3">
          <Figure label="Saldo">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span
                className={cn(
                  "font-semibold text-value-md tabular-nums",
                  row.tone === "empty" && "text-warning"
                )}
              >
                {row.quantityText}
              </span>
              {row.tone === "empty" ? (
                <Badge variant="warning">Sem saldo</Badge>
              ) : null}
            </span>
          </Figure>
          <Figure label="Custo médio">
            <span
              className={cn(
                "tabular-nums",
                row.costUnknown && "text-warning italic"
              )}
            >
              {row.costText}
            </span>
          </Figure>
          <Figure className="col-span-2 md:col-span-1" label="Atualizado">
            <span className="tabular-nums">{row.updatedText}</span>
          </Figure>
        </dl>
        <RowActions
          disabled={panelOpen || otherPanelOpen}
          onOpen={onOpen}
          row={row}
        />
      </div>
      {children}
    </li>
  );
}

/** The empty state: a card with one line, centered under the toolbar. */
function StateCard({ children }: { children: ReactNode }) {
  return (
    <Card className="items-center px-(--card-spacing) text-center">
      <p className="text-muted-foreground">{children}</p>
    </Card>
  );
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

/**
 * Current balance of every variant, with the three stock commands: receive,
 * count and write off. Balances change only through those commands.
 */
export function InventoryPage() {
  const { organization, organizationId } = useCurrentOrganization();
  const workspace = useLocalWorkspace(organizationId);
  // Stock is read from the server whenever it is reachable; only without a
  // connection does the screen work from the device (and queue movements).
  const offlineWorkspace =
    workspace !== null && !workspace.online ? workspace : null;
  const offline = offlineWorkspace !== null;
  // `?filtro=sem-saldo` / `?filtro=sem-custo` open the list already filtered
  const [linkFilters] = useState(() =>
    readStockLinkFilters(window.location.search)
  );
  const { applyBalance, filters, loadMore, reload, setFilters, state } =
    useStockList(organizationId, offlineWorkspace, linkFilters);
  const [open, setOpen] = useState<OpenCommand | null>(null);
  const today = useMemo(
    () => calendarDayInTimezone(new Date(), organization.timezone),
    [organization.timezone]
  );
  const view = stockListView(state, filters, offline);
  const more = stockMoreView(state);
  const countText =
    state.status === "ready" ? stockCountText(state, filters, offline) : null;

  const handleQuery = useCallback(
    (query: string) => setFilters({ query }),
    [setFilters]
  );
  const handleArchived = useCallback(
    (checked: boolean) => setFilters({ includeArchived: checked }),
    [setFilters]
  );
  const handleUnknownCost = useCallback(
    () => setFilters({ unknownCost: !filters.unknownCost }),
    [filters.unknownCost, setFilters]
  );
  const handleFilter = useCallback(
    (stock: StockFilter) => setFilters({ stock }),
    [setFilters]
  );
  const handleOpen = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const { stockAction, variantId } = event.currentTarget.dataset;
      if (!isStockAction(stockAction) || state.status !== "ready") {
        return;
      }
      const entry = state.entries.find((item) => item.variantId === variantId);
      if (!entry) {
        return;
      }
      setOpen({
        action: stockAction,
        target: stockTarget(entry, { costUnavailable: offline }),
      });
    },
    [offline, state]
  );
  const handleClose = useCallback(() => {
    const current = open;
    setOpen(null);
    if (current) {
      focusLater(() =>
        document
          .getElementById(triggerId(current.target.variantId, current.action))
          ?.focus()
      );
    }
  }, [open]);
  const handleReload = useCallback(() => reload(), [reload]);

  return (
    <div className="grid gap-4 font-sans text-foreground text-sm antialiased">
      <header className="grid gap-1">
        <h1 className="text-title">Estoque</h1>
        <p className="text-muted-foreground text-support">
          Receba, conte ou baixe. Venda e devolução movem o saldo sozinhas.
        </p>
      </header>

      {offline ? <OfflineStockNotice /> : null}

      <search aria-label="Filtrar estoque" className="grid gap-3">
        <SearchField
          className="md:max-w-md"
          label="Buscar no estoque"
          onValueChange={handleQuery}
          placeholder="Produto, variante ou SKU"
          value={filters.query}
        />
        <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
          <StatusNav
            label="Filtrar por saldo"
            onSelect={handleFilter}
            options={STOCK_FILTERS}
            value={filters.stock}
          />
          <Button
            aria-pressed={filters.unknownCost}
            className="aria-pressed:border-foreground/70 aria-pressed:bg-secondary aria-pressed:font-semibold"
            onClick={handleUnknownCost}
            type="button"
            variant="outline"
          >
            Sem custo
          </Button>
          <Field className="min-h-ctl-md w-auto" orientation="horizontal">
            <Checkbox
              checked={filters.includeArchived}
              id="stock-archived"
              onCheckedChange={handleArchived}
            />
            <FieldLabel htmlFor="stock-archived">
              Incluir produtos arquivados
            </FieldLabel>
          </Field>
          <Button onClick={handleReload} type="button" variant="ghost">
            <RefreshCwIcon aria-hidden="true" data-icon="inline-start" />
            Atualizar
          </Button>
        </div>
      </search>

      <p
        aria-live="polite"
        className="min-h-5 text-muted-foreground text-support"
        role="status"
      >
        {countText ?? " "}
      </p>

      {view.kind === "ready" ? (
        // always there, so the list does not drop a line when a panel opens
        <p
          className="min-h-5 text-muted-foreground text-support"
          id={PANEL_OPEN_REASON_ID}
        >
          {open === null ? null : PANEL_OPEN_REASON}
        </p>
      ) : null}

      {view.kind === "loading" ? <LoadingCard message={view.message} /> : null}
      {view.kind === "error" ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {view.message}
            <Button
              onClick={handleReload}
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
        <StateCard>
          {view.message}
          {view.showCatalogLink ? (
            <>
              {" "}
              <a className={STANDALONE_LINK} href="/products">
                Ir para Produtos
              </a>
            </>
          ) : null}
        </StateCard>
      ) : null}
      {view.kind === "ready" ? (
        <Card className="gap-0 py-0">
          <ul
            aria-label="Saldos por variante"
            className="divide-y divide-border"
          >
            {view.rows.map((row) => (
              <StockItem
                key={row.id}
                onOpen={handleOpen}
                otherPanelOpen={
                  open !== null && open.target.variantId !== row.id
                }
                panelOpen={open?.target.variantId === row.id}
                row={row}
              >
                {open?.target.variantId === row.id ? (
                  <StockCommandPanel
                    action={open.action}
                    key={`${open.target.variantId}-${open.action}`}
                    local={offlineWorkspace ?? undefined}
                    onBalance={applyBalance}
                    onClose={handleClose}
                    onReloadList={reload}
                    organizationId={organizationId}
                    target={open.target}
                    today={today}
                  />
                ) : null}
              </StockItem>
            ))}
          </ul>
        </Card>
      ) : null}

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
