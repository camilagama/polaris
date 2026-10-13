import { useState } from "react";
import "../catalog/categories-page.css";
import { SaleCustomerPanel } from "./sale-customer-panel";
import { saleDetailHref } from "./sale-history-model";
import { SaleIdForm } from "./sale-id-form";
import { readOrganizationId, SalesTopbar } from "./sales-shell";
import { useSaleIdParam } from "./use-sale-id-param";

/**
 * Reconciles the customer of an existing sale. The sale is named by
 * `?saleId=<uuid>` or by pasting its identifier.
 */
export function SaleCustomerPage() {
  const [organizationId] = useState(readOrganizationId);
  const { clear, initialError, open, saleId } = useSaleIdParam();

  return (
    <div className="categories-page sale-page">
      <SalesTopbar current="customer" />
      <main className="categories-content">
        <section className="categories-heading">
          <div>
            <p className="categories-eyebrow">Vendas</p>
            <h1>Cliente da venda</h1>
            <p className="categories-intro-copy">
              Associe, troque ou remova o cliente de uma venda já confirmada. A
              venda em si nunca é alterada.
            </p>
          </div>
        </section>
        {organizationId ? null : (
          <section className="sale-empty-page">
            <p>
              Abra ou crie uma organização para ajustar o cliente de vendas.
            </p>
            <a className="primary-button sale-link" href="/">
              Ir para a página inicial
            </a>
          </section>
        )}
        {organizationId && saleId === null ? (
          <SaleIdForm initialError={initialError} onOpen={open} />
        ) : null}
        {organizationId && saleId !== null ? (
          <>
            <p className="sale-hint">
              Venda <code>{saleId}</code>{" "}
              <button
                className="sale-link-button"
                onClick={clear}
                type="button"
              >
                Escolher outra venda
              </button>{" "}
              · <a href={saleDetailHref(saleId)}>Ver detalhes da venda</a>
            </p>
            <SaleCustomerPanel
              headingLevel={2}
              key={saleId}
              organizationId={organizationId}
              saleId={saleId}
            />
          </>
        ) : null}
      </main>
    </div>
  );
}
