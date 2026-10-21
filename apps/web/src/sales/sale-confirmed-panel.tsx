import CheckIcon from "lucide-react/dist/esm/icons/check";
import { type RefObject, useCallback, useState } from "react";
import { Button } from "@/ui/button";
import { Card, CardContent, CardHeader } from "@/ui/card";
import { Separator } from "@/ui/separator";
import { SaleCustomerPanel } from "./sale-customer-panel";
import type { ConfirmedSaleView } from "./sale-form-model";
import { saleDetailHref } from "./sale-history-model";
import { FeeValue, LeaderRow, Perforation } from "./sale-summary-panel";

function Details({ details }: { details: ConfirmedSaleView["saleDetails"] }) {
  return (
    <dl className="grid gap-2 text-support sm:grid-cols-2">
      {details.map((detail) => (
        <div className="grid gap-0.5" key={detail.label}>
          <dt className="text-muted-foreground">{detail.label}</dt>
          <dd className="[overflow-wrap:anywhere]">
            {detail.tone === "plain" ? (
              detail.value
            ) : (
              <FeeValue line={{ text: detail.value, tone: detail.tone }} />
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The confirmed sale exactly as stored: items, totals, payment and fees (the detail page keeps SaleSnapshot). */
function ConfirmedReceipt({ sale }: { sale: ConfirmedSaleView }) {
  return (
    <>
      <CardContent className="grid gap-4">
        <Details details={sale.saleDetails} />
        <section aria-labelledby="sale-confirmed-items" className="grid gap-2">
          <h3 className="font-medium" id="sale-confirmed-items">
            Itens
          </h3>
          <ul className="grid gap-2">
            {sale.items.map((item) => (
              <li className="grid gap-0.5" key={item.key}>
                <span className="font-medium [overflow-wrap:anywhere]">
                  {item.label}
                </span>
                <span className="tabular-nums">{item.detail}</span>
                <span className="text-muted-foreground text-support">
                  {item.costText}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </CardContent>
      <Perforation />
      <CardContent>
        <dl className="grid gap-2">
          {sale.totals.map((row) =>
            row.tone === "total" ? (
              <div
                className="flex items-baseline justify-between gap-3 border-border border-t pt-2 font-semibold text-value-md"
                key={row.key}
              >
                <dt>{row.label}</dt>
                <dd className="tabular-nums">{row.value}</dd>
              </div>
            ) : (
              <LeaderRow
                key={row.key}
                label={row.label}
                tone={row.tone}
                value={row.value}
              />
            )
          )}
        </dl>
      </CardContent>
      <CardContent className="grid gap-2">
        <h3 className="font-medium">Pagamento</h3>
        <Details details={sale.paymentDetails} />
        <p className="text-muted-foreground text-support">{sale.note}</p>
      </CardContent>
    </>
  );
}

interface CustomerDisclosureProps {
  organizationId: string;
  saleId: string;
}

/**
 * Optional, collapsed entry point shown after a sale is confirmed. The panel inside still has the look of the
 * "Cliente da venda" screen (sale-customer-panel.css), which migrates in its own pull request.
 */
function CustomerDisclosure({
  organizationId,
  saleId,
}: CustomerDisclosureProps) {
  const [open, setOpen] = useState(false);
  const handleToggle = useCallback(() => setOpen((value) => !value), []);
  return (
    <div className="grid justify-items-start gap-2">
      <Button
        aria-controls="sale-customer-region"
        aria-expanded={open}
        className="h-auto min-h-ctl-md max-w-full whitespace-normal py-1.5 text-left"
        onClick={handleToggle}
        type="button"
        variant="outline"
      >
        {open
          ? "Ocultar cliente da venda"
          : "Associar cliente a esta venda (opcional)"}
      </Button>
      <div className="w-full" hidden={!open} id="sale-customer-region">
        {open ? (
          <SaleCustomerPanel
            headingLevel={3}
            key={saleId}
            organizationId={organizationId}
            saleId={saleId}
          />
        ) : null}
      </div>
    </div>
  );
}

interface ConfirmedPanelProps {
  organizationId: string;
  panelRef: RefObject<HTMLElement | null>;
  sale: ConfirmedSaleView;
}

export function ConfirmedSalePanel({
  organizationId,
  panelRef,
  sale,
}: ConfirmedPanelProps) {
  return (
    <section
      aria-labelledby="sale-confirmed-title"
      className="focus-ring rounded-xl"
      ref={panelRef}
      tabIndex={-1}
    >
      <Card>
        <CardHeader>
          <div role="status">
            <h2
              className="flex items-center gap-2 text-section"
              id="sale-confirmed-title"
            >
              <CheckIcon aria-hidden="true" className="size-4 shrink-0" />
              {sale.headline}
            </h2>
          </div>
        </CardHeader>
        <ConfirmedReceipt sale={sale} />
        <Separator />
        <CardContent className="grid justify-items-start gap-3">
          <a
            className="focus-ring rounded-sm underline decoration-input underline-offset-4 hover:decoration-foreground"
            href={saleDetailHref(sale.saleId)}
          >
            Ver detalhes e histórico da venda
          </a>
          <p className="text-muted-foreground text-support">
            O formulário abaixo foi reiniciado para uma nova venda.
          </p>
          <CustomerDisclosure
            key={sale.saleId}
            organizationId={organizationId}
            saleId={sale.saleId}
          />
        </CardContent>
      </Card>
    </section>
  );
}
