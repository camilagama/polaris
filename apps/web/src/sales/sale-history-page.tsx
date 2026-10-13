import { useCallback, useEffect, useRef, useState } from "react";
import { orpcClient } from "../lib/orpc";
import "../catalog/categories-page.css";
import "./sale-page.css";
import "./sale-history.css";
import {
  isLatestRequest,
  nextRequestToken,
  type RequestSequence,
} from "./sale-customer-link-model";
import {
  canLoadMore,
  historyCustomersFailed,
  historyCustomersLoaded,
  historyLoaded,
  historyLoadFailed,
  historyLoading,
  historyView,
  initialHistoryState,
  loadMoreStarted,
  loadMoreView,
  moreLoaded,
  moreLoadFailed,
  nextOffset,
  SALES_PAGE_SIZE,
} from "./sale-history-model";
import { readOrganizationId, SalesTopbar } from "./sales-shell";

interface HistoryContentProps {
  organizationId: string;
}

function SaleHistoryContent({ organizationId }: HistoryContentProps) {
  const [state, setState] = useState(initialHistoryState);
  const listSequence = useRef<RequestSequence>({ current: 0 });
  const customersSequence = useRef<RequestSequence>({ current: 0 });

  const loadFirstPage = useCallback(async () => {
    const token = nextRequestToken(listSequence.current);
    setState(historyLoading);
    try {
      const page = await orpcClient.sale.list({
        limit: SALES_PAGE_SIZE,
        offset: 0,
        organizationId,
      });
      if (isLatestRequest(listSequence.current, token)) {
        setState((current) => historyLoaded(current, page));
      }
    } catch (error) {
      if (isLatestRequest(listSequence.current, token)) {
        setState((current) => historyLoadFailed(current, error));
      }
    }
  }, [organizationId]);

  const loadCustomers = useCallback(async () => {
    const token = nextRequestToken(customersSequence.current);
    try {
      const result = await orpcClient.customer.list({
        organizationId,
        status: "all",
      });
      if (isLatestRequest(customersSequence.current, token)) {
        setState((current) =>
          historyCustomersLoaded(current, result.customers)
        );
      }
    } catch (error) {
      if (isLatestRequest(customersSequence.current, token)) {
        setState((current) => historyCustomersFailed(current, error));
      }
    }
  }, [organizationId]);

  useEffect(() => {
    loadFirstPage().catch(() => undefined);
    loadCustomers().catch(() => undefined);
  }, [loadCustomers, loadFirstPage]);

  const handleLoadMore = useCallback(async () => {
    if (!canLoadMore(state)) {
      return;
    }
    const token = nextRequestToken(listSequence.current);
    setState(loadMoreStarted);
    try {
      const page = await orpcClient.sale.list({
        limit: SALES_PAGE_SIZE,
        offset: nextOffset(state),
        organizationId,
      });
      if (isLatestRequest(listSequence.current, token)) {
        setState((current) => moreLoaded(current, page));
      }
    } catch (error) {
      if (isLatestRequest(listSequence.current, token)) {
        setState((current) => moreLoadFailed(current, error));
      }
    }
  }, [organizationId, state]);
  const handleLoadMoreEvent = useCallback(() => {
    handleLoadMore().catch(() => undefined);
  }, [handleLoadMore]);
  const handleRetry = useCallback(() => {
    loadFirstPage().catch(() => undefined);
    loadCustomers().catch(() => undefined);
  }, [loadCustomers, loadFirstPage]);

  const view = historyView(state);
  const more = loadMoreView(state);
  return (
    <>
      {view.kind === "loading" ? (
        <p className="sale-status" role="status">
          {view.message}
        </p>
      ) : null}
      {view.kind === "error" ? (
        <p className="sale-message is-error" role="alert">
          {view.message}{" "}
          <button
            className="sale-link-button"
            onClick={handleRetry}
            type="button"
          >
            Tentar novamente
          </button>
        </p>
      ) : null}
      {view.kind === "empty" ? (
        <p className="sale-empty">
          {view.message} <a href={view.href}>Registrar uma venda</a>
        </p>
      ) : null}
      {view.kind === "ready" ? (
        <ul aria-label="Vendas" className="sale-history-list">
          {view.rows.map((row) => (
            <li key={row.id}>
              <div className="sale-history-main">
                <a href={row.detailHref}>{row.occurredText}</a>
                <span className={`sale-badge is-${row.statusTone}`}>
                  {row.statusLabel}
                </span>
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
          className="quiet-button"
          disabled={more.busy}
          onClick={handleLoadMoreEvent}
          type="button"
        >
          {more.label}
        </button>
      ) : null}
    </>
  );
}

/** Newest-first list of confirmed and cancelled sales. */
export function SaleHistoryPage() {
  const [organizationId] = useState(readOrganizationId);
  return (
    <div className="categories-page sale-page">
      <SalesTopbar current="history" />
      <main className="categories-content">
        <section className="categories-heading">
          <div>
            <p className="categories-eyebrow">Vendas</p>
            <h1>Histórico de vendas</h1>
            <p className="categories-intro-copy">
              Vendas confirmadas e canceladas. Abra uma venda para ver o
              registro completo, cancelar ou ajustar o cliente.
            </p>
          </div>
        </section>
        {organizationId ? (
          <SaleHistoryContent organizationId={organizationId} />
        ) : (
          <section className="sale-empty-page">
            <p>Abra ou crie uma organização para ver as vendas.</p>
            <a className="primary-button sale-link" href="/">
              Ir para a página inicial
            </a>
          </section>
        )}
      </main>
    </div>
  );
}
