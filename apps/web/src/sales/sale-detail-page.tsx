import type { SaleDetailReadModel } from "@polaris/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { orpcClient } from "../lib/orpc";
import "../catalog/categories-page.css";
import "./sale-history.css";
import { SaleCancelPanel } from "./sale-cancel-panel";
import type { SaleNotice } from "./sale-cancellation-model";
import {
  nextRequestToken,
  isLatestRequest,
  type RequestSequence,
} from "./sale-customer-link-model";
import { SaleCustomerPanel } from "./sale-customer-panel";
import type { Loadable } from "./sale-form-model";
import { detailLoadErrorMessage, saleDetailView } from "./sale-history-model";
import { SaleIdForm } from "./sale-id-form";
import { SaleSnapshot } from "./sale-snapshot";
import { readOrganizationId, SalesTopbar } from "./sales-shell";
import { useSaleIdParam } from "./use-sale-id-param";

interface DetailContentProps {
  organizationId: string;
  saleId: string;
}

function SaleDetailContent({ organizationId, saleId }: DetailContentProps) {
  const [load, setLoad] = useState<Loadable<SaleDetailReadModel>>({
    status: "loading",
  });
  const [notice, setNotice] = useState<SaleNotice | null>(null);
  const sequence = useRef<RequestSequence>({ current: 0 });

  const loadDetail = useCallback(async () => {
    const token = nextRequestToken(sequence.current);
    setLoad((current) =>
      current.status === "ready" ? current : { status: "loading" }
    );
    try {
      const value = await orpcClient.sale.get({ organizationId, saleId });
      if (isLatestRequest(sequence.current, token)) {
        setLoad({ status: "ready", value });
      }
    } catch (error) {
      if (isLatestRequest(sequence.current, token)) {
        setLoad({ message: detailLoadErrorMessage(error), status: "error" });
      }
    }
  }, [organizationId, saleId]);

  useEffect(() => {
    loadDetail().catch(() => undefined);
  }, [loadDetail]);

  const handleRetry = useCallback(() => {
    loadDetail().catch(() => undefined);
  }, [loadDetail]);
  const handleSaleChanged = useCallback(
    (next: SaleNotice) => {
      setNotice(next);
      loadDetail().catch(() => undefined);
    },
    [loadDetail]
  );

  return (
    <>
      <div aria-live="polite" role="status">
        {notice ? (
          <p
            className={
              notice.ok ? "sale-message is-success" : "sale-message is-warning"
            }
          >
            {notice.message}
          </p>
        ) : null}
      </div>
      {load.status === "loading" ? (
        <p className="sale-status" role="status">
          Carregando venda…
        </p>
      ) : null}
      {load.status === "error" ? (
        <p className="sale-message is-error" role="alert">
          {load.message}{" "}
          <button
            className="sale-link-button"
            onClick={handleRetry}
            type="button"
          >
            Tentar novamente
          </button>
        </p>
      ) : null}
      {load.status === "ready" ? (
        <ReadyDetail
          detail={load.value}
          onSaleChanged={handleSaleChanged}
          organizationId={organizationId}
          saleId={saleId}
        />
      ) : null}
    </>
  );
}

interface ReadyDetailProps {
  detail: SaleDetailReadModel;
  onSaleChanged: (notice: SaleNotice) => void;
  organizationId: string;
  saleId: string;
}

function ReadyDetail({
  detail,
  onSaleChanged,
  organizationId,
  saleId,
}: ReadyDetailProps) {
  const view = saleDetailView(detail);
  return (
    <>
      <section aria-labelledby="sale-detail-title" className="sale-detail">
        <div className="sale-detail-heading">
          <h2 id="sale-detail-title">Venda</h2>
          <span className={`sale-badge is-${view.statusTone}`}>
            {view.statusLabel}
          </span>
        </div>
        {view.cancellation ? (
          <div className="sale-cancellation" role="note">
            <h3>Venda cancelada</h3>
            <p className="sale-hint">
              O registro original abaixo foi preservado, sem edição. O
              cancelamento não pode ser desfeito.
            </p>
            <dl className="sale-details">
              {view.cancellation.rows.map((row) => (
                <div key={row.label}>
                  <dt>{row.label}</dt>
                  <dd>{row.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        ) : null}
        <SaleSnapshot sale={view.sale} />
      </section>
      {view.canCancel ? (
        <SaleCancelPanel
          key={saleId}
          onSaleChanged={onSaleChanged}
          organizationId={organizationId}
          saleId={saleId}
        />
      ) : null}
      <SaleCustomerPanel
        headingLevel={2}
        key={saleId}
        organizationId={organizationId}
        saleId={saleId}
      />
    </>
  );
}

/** One sale in full: its snapshot, cancellation, and customer attribution. */
export function SaleDetailPage() {
  const [organizationId] = useState(readOrganizationId);
  const { clear, initialError, open, saleId } = useSaleIdParam();
  return (
    <div className="categories-page sale-page">
      <SalesTopbar current="history" />
      <main className="categories-content">
        <section className="categories-heading">
          <div>
            <p className="categories-eyebrow">Vendas</p>
            <h1>Detalhe da venda</h1>
            <p className="categories-intro-copy">
              A venda confirmada é um registro que não muda. Cancelamento e
              cliente são registros à parte.
            </p>
          </div>
        </section>
        <p className="sale-hint">
          <a href="/sales/history">Voltar ao histórico</a>
          {saleId === null ? null : (
            <>
              {" "}
              ·{" "}
              <button
                className="sale-link-button"
                onClick={clear}
                type="button"
              >
                Abrir outra venda
              </button>
            </>
          )}
        </p>
        {organizationId ? null : (
          <section className="sale-empty-page">
            <p>Abra ou crie uma organização para ver vendas.</p>
            <a className="primary-button sale-link" href="/">
              Ir para a página inicial
            </a>
          </section>
        )}
        {organizationId && saleId === null ? (
          <SaleIdForm initialError={initialError} onOpen={open} />
        ) : null}
        {organizationId && saleId !== null ? (
          <SaleDetailContent
            key={saleId}
            organizationId={organizationId}
            saleId={saleId}
          />
        ) : null}
      </main>
    </div>
  );
}
