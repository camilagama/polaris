import { type ChangeEvent, useCallback } from "react";
import { useCurrentOrganization } from "../lib/current-organization";
import { useLocalWorkspace } from "../offline/runtime/use-local-workspace";
import { PendingSalesPanel } from "./offline-sale-panels";
import "./sale-legacy.css";
import "./sale-history.css";
import {
  activeFilterCount,
  HISTORY_STATUS_FILTERS,
  type HistoryFilters,
  type HistoryStatusFilter,
  historyView,
  loadMoreView,
} from "./sale-history-model";
import { useSaleHistory } from "./use-sale-history";

function isStatusFilter(value: string): value is HistoryStatusFilter {
  return HISTORY_STATUS_FILTERS.some(([status]) => status === value);
}

interface FiltersProps {
  /** Without a connection the text search over the items is not available. */
  offline: boolean;
  filters: HistoryFilters;
  onChange: (changes: Partial<HistoryFilters>) => void;
  onReset: () => void;
  period: string | null;
}

function HistoryFiltersBar({
  filters,
  offline,
  onChange,
  onReset,
  period,
}: FiltersProps) {
  const active = activeFilterCount(filters);
  const handleFrom = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      onChange({ from: event.target.value }),
    [onChange]
  );
  const handleTo = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      onChange({ to: event.target.value }),
    [onChange]
  );
  const handleStatus = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const { value } = event.target;
      onChange({ status: isStatusFilter(value) ? value : "" });
    },
    [onChange]
  );
  const handleCustomer = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      onChange({ customer: event.target.value }),
    [onChange]
  );
  const handleQuery = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      onChange({ query: event.target.value }),
    [onChange]
  );
  return (
    <search aria-label="Filtrar vendas" className="sale-filters">
      <div className="sale-field">
        <label htmlFor="history-from">De (data da venda)</label>
        <input
          aria-describedby={period ? "history-period-error" : undefined}
          aria-invalid={period ? true : undefined}
          id="history-from"
          onChange={handleFrom}
          type="date"
          value={filters.from}
        />
      </div>
      <div className="sale-field">
        <label htmlFor="history-to">Até (data da venda)</label>
        <input
          aria-describedby={period ? "history-period-error" : undefined}
          aria-invalid={period ? true : undefined}
          id="history-to"
          onChange={handleTo}
          type="date"
          value={filters.to}
        />
      </div>
      <div className="sale-field">
        <label htmlFor="history-status">Situação</label>
        <select
          id="history-status"
          onChange={handleStatus}
          value={filters.status}
        >
          {HISTORY_STATUS_FILTERS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div className="sale-field">
        <label htmlFor="history-customer">Cliente</label>
        <input
          autoComplete="off"
          id="history-customer"
          onChange={handleCustomer}
          placeholder="Nome do cliente"
          type="search"
          value={filters.customer}
        />
      </div>
      <div className="sale-field">
        <label htmlFor="history-query">Busca</label>
        <input
          autoComplete="off"
          disabled={offline}
          id="history-query"
          onChange={handleQuery}
          placeholder={offline ? "Só com conexão" : "Produto vendido"}
          type="search"
          value={filters.query}
        />
      </div>
      <div className="sale-filters-actions">
        <button
          className="quiet-button"
          disabled={active === 0}
          onClick={onReset}
          type="button"
        >
          Limpar filtros{active > 0 ? ` (${active})` : ""}
        </button>
      </div>
      {period ? (
        <p
          className="sale-error sale-filters-error"
          id="history-period-error"
          role="alert"
        >
          {period}
        </p>
      ) : null}
    </search>
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
    <div className="sale-page">
      <section className="categories-heading">
        <div>
          <p className="categories-eyebrow">Vendas</p>
          <h1>Histórico de vendas</h1>
          <p className="categories-intro-copy">
            Vendas confirmadas e canceladas, da mais recente para a mais antiga.
            Abra uma venda para ver o registro completo, devolver, cancelar ou
            ajustar o cliente.
          </p>
        </div>
      </section>
      {offline ? (
        <p className="sale-message is-warning" role="status">
          Sem conexão. Estas são as vendas mais recentes guardadas neste
          aparelho (as últimas 100 que o servidor confirmou); detalhes, busca
          por item e vendas mais antigas só com conexão.
        </p>
      ) : null}
      {workspace ? <PendingSalesPanel workspace={workspace} /> : null}
      <HistoryFiltersBar
        filters={filters}
        offline={offline}
        onChange={setFilters}
        onReset={reset}
        period={period}
      />
      {view.kind === "loading" && period === null ? (
        <p className="sale-status" role="status">
          {view.message}
        </p>
      ) : null}
      {view.kind === "error" ? (
        <p className="sale-message is-error" role="alert">
          {view.message}{" "}
          <button className="sale-link-button" onClick={reload} type="button">
            Tentar novamente
          </button>
        </p>
      ) : null}
      {view.kind === "empty" ? (
        <p className="sale-empty">
          {view.message}{" "}
          {view.href ? <a href={view.href}>Registrar uma venda</a> : null}
        </p>
      ) : null}
      {view.kind === "ready" ? (
        <ul aria-label="Vendas" className="sale-history-list">
          {view.rows.map((row) => (
            <li key={row.id}>
              <div className="sale-history-main">
                {offline ? (
                  <span>
                    {row.dateText}
                    {row.timeText ? (
                      <span className="sale-history-time">
                        {" "}
                        · {row.timeText}
                      </span>
                    ) : null}
                  </span>
                ) : (
                  <a href={row.detailHref}>
                    {row.dateText}
                    {row.timeText ? (
                      <span className="sale-history-time">
                        {" "}
                        · {row.timeText}
                      </span>
                    ) : null}
                  </a>
                )}
                <span className={`sale-badge is-${row.statusTone}`}>
                  {row.statusLabel}
                </span>
                {row.returnsBadge ? (
                  <span className="sale-badge is-returns">
                    {row.returnsBadge}
                  </span>
                ) : null}
                {row.backdated ? (
                  <span className="sale-badge is-backdated">Retroativa</span>
                ) : null}
              </div>
              <strong>{row.totalText}</strong>
              <p className="sale-history-meta">
                {row.methodText} · {row.itemCountText}
              </p>
              <p className="sale-history-meta">Cliente: {row.customerText}</p>
            </li>
          ))}
        </ul>
      ) : null}
      <div aria-live="polite" role="status">
        {more.busy ? (
          <p className="sale-status">Carregando mais vendas…</p>
        ) : null}
      </div>
      {more.error ? (
        <p className="sale-message is-error" role="alert">
          {more.error}
        </p>
      ) : null}
      {more.visible ? (
        <button
          className="quiet-button sale-history-more"
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
