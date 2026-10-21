import { useCurrentOrganization } from "../lib/current-organization";
import "./sale-legacy.css";
import { SaleCustomerPanel } from "./sale-customer-panel";
import { saleDetailHref } from "./sale-history-model";
import { SaleIdForm } from "./sale-id-form";
import { useSaleIdParam } from "./use-sale-id-param";

/**
 * Reconciles the customer of an existing sale. The sale is named by
 * `?saleId=<uuid>` or by pasting its identifier.
 */
export function SaleCustomerPage() {
  const { organizationId } = useCurrentOrganization();
  const { clear, initialError, open, saleId } = useSaleIdParam();

  return (
    <div className="sale-page">
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
      {saleId === null ? (
        <SaleIdForm initialError={initialError} onOpen={open} />
      ) : null}
      {saleId === null ? null : (
        <>
          <p className="sale-hint">
            Venda <code>{saleId}</code>{" "}
            <button className="sale-link-button" onClick={clear} type="button">
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
      )}
    </div>
  );
}
