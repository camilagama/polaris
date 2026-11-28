import CheckIcon from "lucide-react/dist/esm/icons/check";
import { type RefObject, useCallback, useState } from "react";
import { Block } from "@/ui/block";
import { Button } from "@/ui/button";
import { MoneyText } from "@/ui/hidden-values";
import { Separator } from "@/ui/separator";
import { TextLink } from "@/ui/text-link";
import {
  ConfirmedDetails,
  ConfirmedItems,
  ConfirmedPaymentParts,
} from "./confirmed-sale-parts";
import { SaleCustomerPanel } from "./sale-customer-panel";
import type { ConfirmedSaleView } from "./sale-form-model";
import { saleDetailHref } from "./sale-history-model";
import { LeaderRow, Perforation } from "./sale-summary-panel";

/** The confirmed sale exactly as stored: items, totals, payment and fees (the detail page has its own, in `Receipt`). */
function ConfirmedReceipt({ sale }: { sale: ConfirmedSaleView }) {
  return (
    <>
      <div className="grid gap-4">
        <ConfirmedDetails details={sale.saleDetails} />
        <ConfirmedItems headingId="sale-confirmed-items" items={sale.items} />
      </div>
      <div className="-mx-(--card-spacing)">
        <Perforation />
      </div>
      <dl className="grid gap-2">
        {sale.totals.map((row) =>
          row.tone === "total" ? (
            <div
              className="flex items-baseline justify-between gap-3 border-border border-t pt-2 font-semibold text-value-md"
              key={row.key}
            >
              <dt>{row.label}</dt>
              <dd className="tabular-nums">
                <MoneyText text={row.value} />
              </dd>
            </div>
          ) : (
            <LeaderRow
              key={row.key}
              label={row.label}
              tone={row.tone}
              value={<MoneyText text={row.value} />}
            />
          )
        )}
      </dl>
      <div className="grid gap-2">
        <h3 className="font-medium">Pagamento</h3>
        {sale.paymentParts ? (
          <ConfirmedPaymentParts parts={sale.paymentParts} />
        ) : (
          <ConfirmedDetails details={sale.paymentDetails} />
        )}
        <p className="text-muted-foreground text-support">{sale.note}</p>
      </div>
    </>
  );
}

interface CustomerDisclosureProps {
  organizationId: string;
  saleId: string;
}

/**
 * Optional, collapsed entry point shown after a sale is confirmed: the "Cliente da venda" panel of the detail,
 * without its own card (it is already inside the card of the confirmed sale).
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
        {open ? "Ocultar cliente da venda" : "Associar cliente a esta venda"}
      </Button>
      <div className="w-full" hidden={!open} id="sale-customer-region">
        {open ? (
          <SaleCustomerPanel
            framed={false}
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

const FIRST_SALE_LINE_ID = "sale-first-sale-line";

/** Only for the first sale of the store the server confirmed in this tab: where the day and the estimated result are. */
function FirstSaleLine() {
  return (
    <p className="text-muted-foreground text-support" id={FIRST_SALE_LINE_ID}>
      1ª venda registrada. Veja o Hoje no{" "}
      <TextLink aria-label="Ver o Início" href="/">
        Início
      </TextLink>{" "}
      e o resultado estimado em{" "}
      <TextLink aria-label="Ver o Resultado" href="/dashboard">
        Resultado
      </TextLink>
      .
    </p>
  );
}

interface ConfirmedPanelProps {
  firstSale: boolean;
  organizationId: string;
  panelRef: RefObject<HTMLElement | null>;
  sale: ConfirmedSaleView;
}

export function ConfirmedSalePanel({
  firstSale,
  organizationId,
  panelRef,
  sale,
}: ConfirmedPanelProps) {
  const focusTarget = useCallback(
    (node: HTMLDivElement | null) => {
      panelRef.current = node;
    },
    [panelRef]
  );
  return (
    <Block
      aria-describedby={firstSale ? FIRST_SALE_LINE_ID : undefined}
      className="focus-ring"
      ref={focusTarget}
      tabIndex={-1}
      title={
        <span className="flex items-center gap-2" role="status">
          <CheckIcon aria-hidden="true" className="size-4 shrink-0" />
          {sale.headline}
        </span>
      }
      variant="plain"
    >
      <ConfirmedReceipt sale={sale} />
      <div className="-mx-(--card-spacing)">
        <Separator />
      </div>
      <div className="grid justify-items-start gap-3">
        <TextLink href={saleDetailHref(sale.saleId)}>
          Ver detalhes e histórico da venda
        </TextLink>
        <p className="text-muted-foreground text-support">
          O formulário abaixo foi reiniciado para uma nova venda.
        </p>
        <CustomerDisclosure
          key={sale.saleId}
          organizationId={organizationId}
          saleId={sale.saleId}
        />
      </div>
      {firstSale ? <FirstSaleLine /> : null}
    </Block>
  );
}
