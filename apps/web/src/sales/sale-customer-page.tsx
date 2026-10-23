import { useState } from "react";
import { useCurrentOrganization } from "../lib/current-organization";
import { readSaleIdParam } from "./sale-customer-link-model";
import { SaleCustomerPanel } from "./sale-customer-panel";
import { saleDetailHref } from "./sale-history-model";
import { SaleIdMissing } from "./sale-id-missing";

/** A link on a line of its own: it gets the 48 px touch area. */
const LINK =
  "touch-hit focus-ring rounded-sm underline decoration-input underline-offset-4 hover:decoration-foreground";

/**
 * Reconciles the customer of an existing sale, named by `?saleId=<uuid>` (the
 * sale is chosen in the history).
 */
export function SaleCustomerPage() {
  const { organizationId } = useCurrentOrganization();
  const [param] = useState(() => readSaleIdParam(window.location.search));

  return (
    <div className="grid gap-4 font-sans text-foreground text-sm antialiased">
      <header className="grid gap-1">
        <h1 className="text-title">Cliente da venda</h1>
        <p className="text-muted-foreground text-support">
          Associe, troque ou remova o cliente de uma venda já confirmada. A
          venda em si nunca é alterada.
        </p>
      </header>
      {param.kind === "valid" ? (
        <>
          <p>
            <a className={LINK} href={saleDetailHref(param.saleId)}>
              Ver detalhes da venda
            </a>
          </p>
          <SaleCustomerPanel
            headingLevel={2}
            key={param.saleId}
            organizationId={organizationId}
            saleId={param.saleId}
          />
        </>
      ) : (
        <SaleIdMissing param={param} />
      )}
    </div>
  );
}
