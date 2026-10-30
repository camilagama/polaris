import type { InventoryBalanceReadModel } from "@polaris/contracts";
import CloudOffIcon from "lucide-react/dist/esm/icons/cloud-off";
import RefreshCwIcon from "lucide-react/dist/esm/icons/refresh-cw";
import {
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
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
import { HelpTip } from "@/ui/help-tip";
import { Skeleton } from "@/ui/skeleton";
import { StatusNav } from "../catalog/screen-parts";
import { useCurrentOrganization } from "../lib/current-organization";
import { calendarDayInTimezone } from "../lib/dates";
import { focusLater } from "../lib/focus";
import { useLocalWorkspace } from "../offline/runtime/use-local-workspace";
import { isStockAction, type StockAction } from "./stock-command-model";
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
  type StockAttentionLink,
} from "./stock-list-model";
import { LINK, StockActionStrip } from "./stock-action-strip";
import { type StockTarget, stockTarget } from "./stock-target";
import { useStockAttention } from "./use-stock-attention";
import { useStockEntryLink } from "./use-stock-entry-link";
import { useStockList } from "./use-stock-list";

interface OpenCommand {
  action: StockAction;
  /** Opened by the link from the sale: it stands above the list, whether or not the list holds the variant. */
  standalone: boolean;
  /** The balance as the row showed it when the panel opened. */
  target: StockTarget;
}

/** A link on a line of its own: it gets the 44 px touch area. */
const STANDALONE_LINK = `touch-hit ${LINK}`;

function EntryNotFoundNotice({ unavailable }: { unavailable: boolean }) {
  return (
    <Alert variant="warning">
      <AlertDescription>
        {unavailable
          ? "Não conseguimos abrir essa variante agora. Procure o produto na lista e use Receber."
          : "Não achamos essa variante no estoque. Procure o produto na lista e use Receber."}
      </AlertDescription>
    </Alert>
  );
}

/** Said at the top of the screen while there is no connection. */
function OfflineStockNotice() {
  return (
    <Alert variant="warning">
      <CloudOffIcon aria-hidden="true" />
      <AlertTitle>Sem conexão.</AlertTitle>
      <AlertDescription>
        Saldo do aparelho. Receber, contar e baixar vão quando a conexão voltar
        (veja{" "}
        <a className={LINK} href="/attention">
          Pendências
        </a>
        ). Custo médio só com conexão.
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
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-support">
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
  const {
    applyBalance: applyListBalance,
    filters,
    loadMore,
    reload: reloadList,
    setFilters,
    state,
  } = useStockList(organizationId, offlineWorkspace, linkFilters);
  const [attentionVersion, setAttentionVersion] = useState(0);
  const attention = useStockAttention(
    organizationId,
    !offline,
    attentionVersion
  );
  const applyBalance = useCallback(
    (balance: InventoryBalanceReadModel, updatedAt: string | null) => {
      applyListBalance(balance, updatedAt);
      setAttentionVersion((version) => version + 1);
    },
    [applyListBalance]
  );
  const reload = useCallback(() => {
    reloadList();
    setAttentionVersion((version) => version + 1);
  }, [reloadList]);
  const [open, setOpen] = useState<OpenCommand | null>(null);
  const entryLink = useStockEntryLink(organizationId, offlineWorkspace);
  const offlineRef = useRef(offline);
  offlineRef.current = offline;
  useEffect(() => {
    if (entryLink.status === "found") {
      setOpen({
        action: "receive",
        standalone: true,
        target: stockTarget(entryLink.entry, {
          costUnavailable: offlineRef.current,
        }),
      });
    }
  }, [entryLink]);
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
        standalone: false,
        target: stockTarget(entry, { costUnavailable: offline }),
      });
    },
    [offline, state]
  );
  const handleClose = useCallback(() => {
    const current = open;
    setOpen(null);
    if (current) {
      // the variant of the link may not be in the list: the focus then goes to the content
      focusLater(() =>
        (
          document.getElementById(
            triggerId(current.target.variantId, current.action)
          ) ?? document.getElementById("conteudo")
        )?.focus()
      );
    }
  }, [open]);
  const handleInformCost = useCallback((target: StockTarget) => {
    setOpen((current) =>
      current === null ? current : { ...current, action: "cost", target }
    );
  }, []);
  const handleReload = useCallback(() => reload(), [reload]);
  const handleAttentionLink = useCallback(
    (event: MouseEvent<HTMLAnchorElement>, link: StockAttentionLink) => {
      if (
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      event.preventDefault();
      // the number counts active products with no search: the list opens on the same ground
      setFilters({
        ...readStockLinkFilters(
          new URL(link.href, window.location.origin).search
        ),
        includeArchived: false,
        query: "",
      });
    },
    [setFilters]
  );

  return (
    <div className="grid gap-4 font-sans text-foreground text-sm antialiased">
      <header className="grid gap-1">
        <div className="flex items-center gap-1">
          <h1 className="text-title">Estoque</h1>
          <HelpTip about="Estoque">
            Receber, contar e baixar mudam o saldo aqui. Venda e devolução mudam
            sozinhas.
          </HelpTip>
        </div>
      </header>

      <StockActionStrip
        links={attention.links}
        onApply={handleAttentionLink}
        unavailable={attention.unavailable}
      />

      {offline ? <OfflineStockNotice /> : null}
      {entryLink.status === "missing" || entryLink.status === "unavailable" ? (
        <EntryNotFoundNotice unavailable={entryLink.status === "unavailable"} />
      ) : null}

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
            <FieldLabel htmlFor="stock-archived">Incluir arquivados</FieldLabel>
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

      {open?.standalone ? (
        <Card className="gap-0 py-0">
          <div className="p-(--card-spacing)">
            <StockCommandPanel
              action={open.action}
              key={`${open.target.variantId}-${open.action}`}
              local={offlineWorkspace ?? undefined}
              onBalance={applyBalance}
              onClose={handleClose}
              onInformCost={handleInformCost}
              onReloadList={reload}
              organizationId={organizationId}
              target={open.target}
              today={today}
            />
          </div>
        </Card>
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
                  open !== null &&
                  (open.standalone || open.target.variantId !== row.id)
                }
                panelOpen={
                  open?.standalone === false && open.target.variantId === row.id
                }
                row={row}
              >
                {open?.standalone === false &&
                open.target.variantId === row.id ? (
                  <StockCommandPanel
                    action={open.action}
                    key={`${open.target.variantId}-${open.action}`}
                    local={offlineWorkspace ?? undefined}
                    onBalance={applyBalance}
                    onClose={handleClose}
                    onInformCost={handleInformCost}
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
