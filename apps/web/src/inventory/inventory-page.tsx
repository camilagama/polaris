import {
  type ChangeEvent,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useMemo,
  useState,
} from "react";
import { focusLater } from "../lib/focus";
import { calendarDayInTimezone } from "../lib/dates";
import { useCurrentOrganization } from "../lib/current-organization";
import "./inventory-page.css";
import {
  STOCK_ACTION_LABELS,
  STOCK_ACTIONS,
  type StockAction,
} from "./stock-command-model";
import { StockCommandPanel } from "./stock-command-panel";
import { useLocalWorkspace } from "../offline/runtime/use-local-workspace";
import {
  STOCK_FILTERS,
  type StockFilter,
  type StockRow,
  stockCountText,
  stockListView,
  stockMoreView,
} from "./stock-list-model";
import { type StockTarget, stockTarget } from "./stock-target";
import { useStockList } from "./use-stock-list";

interface OpenCommand {
  action: StockAction;
  /** The balance as the row showed it when the panel opened. */
  target: StockTarget;
}

const triggerId = (variantId: string, action: StockAction) =>
  `stock-trigger-${variantId}-${action}`;

function isStockFilter(value: string | undefined): value is StockFilter {
  return STOCK_FILTERS.some(([filter]) => filter === value);
}

function isStockAction(value: string | undefined): value is StockAction {
  return STOCK_ACTIONS.some((action) => action === value);
}

interface RowActionsProps {
  disabled: boolean;
  onOpen: (event: MouseEvent<HTMLButtonElement>) => void;
  row: StockRow;
}

function RowActions({ disabled, onOpen, row }: RowActionsProps) {
  return (
    <div className="stock-actions">
      {STOCK_ACTIONS.map((action) => (
        <button
          aria-label={`${STOCK_ACTION_LABELS[action].trigger} estoque de ${row.productName}, ${row.variantText}`}
          className="quiet-button"
          data-stock-action={action}
          data-variant-id={row.id}
          disabled={disabled}
          id={triggerId(row.id, action)}
          key={action}
          onClick={onOpen}
          type="button"
        >
          {STOCK_ACTION_LABELS[action].trigger}
        </button>
      ))}
    </div>
  );
}

interface StockItemProps {
  children: ReactNode;
  panelOpen: boolean;
  onOpen: (event: MouseEvent<HTMLButtonElement>) => void;
  otherPanelOpen: boolean;
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
    <li className={panelOpen ? "stock-item is-open" : "stock-item"}>
      <div className="stock-row">
        <div className="stock-name">
          <p className="stock-product">
            {row.productName}
            {row.archived ? (
              <span className="stock-badge is-archived">Arquivado</span>
            ) : null}
          </p>
          <p className="stock-variant">
            {row.variantText}
            {row.skuText ? (
              <>
                {" "}
                · <span className="stock-sku">SKU {row.skuText}</span>
              </>
            ) : null}
          </p>
        </div>
        <dl className="stock-figures">
          <div>
            <dt>Saldo</dt>
            <dd className={`stock-quantity is-${row.tone}`}>
              {row.quantityText}
              {row.tone === "empty" ? (
                <span className="stock-badge is-empty">Sem saldo</span>
              ) : null}
            </dd>
          </div>
          <div>
            <dt>Custo médio</dt>
            <dd
              className={
                row.costUnknown ? "stock-cost is-unknown" : "stock-cost"
              }
            >
              {row.costText}
            </dd>
          </div>
          <div>
            <dt>Atualizado</dt>
            <dd>{row.updatedText}</dd>
          </div>
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
  const { applyBalance, filters, loadMore, reload, setFilters, state } =
    useStockList(organizationId, offlineWorkspace);
  const [open, setOpen] = useState<OpenCommand | null>(null);
  const today = useMemo(
    () => calendarDayInTimezone(new Date(), organization.timezone),
    [organization.timezone]
  );
  const view = stockListView(state, filters, offline);
  const more = stockMoreView(state);

  const handleQuery = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      setFilters({ query: event.target.value }),
    [setFilters]
  );
  const handleArchived = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      setFilters({ includeArchived: event.target.checked }),
    [setFilters]
  );
  const handleFilter = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const { stockFilter } = event.currentTarget.dataset;
      if (isStockFilter(stockFilter)) {
        setFilters({ stock: stockFilter });
      }
    },
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
    <div className="inventory-page">
      <section className="categories-heading">
        <div>
          <p className="categories-eyebrow">Operação</p>
          <h1>Estoque</h1>
          <p className="categories-intro-copy">
            O saldo de cada variante muda só por recebimento, contagem ou baixa,
            e cada um fica no histórico. Vendas, cancelamentos e devoluções
            movem o estoque sozinhas.
          </p>
        </div>
      </section>

      {offline ? (
        <p className="categories-message is-success" role="status">
          Sem conexão. O saldo mostrado é o do aparelho, com o que está na fila.
          Receber, contar e baixar ficam guardados e são enviados quando a
          conexão voltar (acompanhe em <a href="/attention">Pendências</a>); o
          custo médio só aparece com conexão.
        </p>
      ) : null}

      <search aria-label="Filtrar estoque" className="stock-toolbar">
        <div className="stock-search">
          <label className="field-label" htmlFor="stock-query">
            Buscar
          </label>
          <input
            autoComplete="off"
            id="stock-query"
            onChange={handleQuery}
            placeholder="Produto, variante ou SKU"
            type="search"
            value={filters.query}
          />
        </div>
        <fieldset className="stock-filter">
          <legend className="field-label">Saldo</legend>
          <div className="stock-segmented">
            {STOCK_FILTERS.map(([value, label]) => (
              <button
                aria-pressed={filters.stock === value}
                className={
                  filters.stock === value
                    ? "category-tab is-selected"
                    : "category-tab"
                }
                data-stock-filter={value}
                key={value}
                onClick={handleFilter}
                type="button"
              >
                {label}
              </button>
            ))}
          </div>
        </fieldset>
        <label className="stock-archived">
          <input
            checked={filters.includeArchived}
            onChange={handleArchived}
            type="checkbox"
          />
          Incluir produtos arquivados
        </label>
        <button className="quiet-button" onClick={handleReload} type="button">
          Atualizar
        </button>
      </search>

      <p aria-live="polite" className="stock-count" role="status">
        {state.status === "ready" ? stockCountText(state) : " "}
      </p>

      {view.kind === "loading" ? (
        <p className="category-empty-state" role="status">
          {view.message}
        </p>
      ) : null}
      {view.kind === "error" ? (
        <p className="categories-message is-error" role="alert">
          {view.message}{" "}
          <button className="quiet-button" onClick={handleReload} type="button">
            Tentar novamente
          </button>
        </p>
      ) : null}
      {view.kind === "empty" ? (
        <p className="category-empty-state">
          {view.message}{" "}
          {view.showCatalogLink ? (
            <a href="/products">Ir para Produtos</a>
          ) : null}
        </p>
      ) : null}
      {view.kind === "ready" ? (
        <ul aria-label="Saldos por variante" className="stock-list">
          {view.rows.map((row) => (
            <StockItem
              key={row.id}
              onOpen={handleOpen}
              otherPanelOpen={open !== null && open.target.variantId !== row.id}
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
      ) : null}

      {more.error ? (
        <p className="categories-message is-error" role="alert">
          {more.error}
        </p>
      ) : null}
      {more.visible ? (
        <button
          className="quiet-button stock-more"
          disabled={more.busy}
          onClick={loadMore}
          type="button"
        >
          {more.label}
        </button>
      ) : null}
    </div>
  );
}
