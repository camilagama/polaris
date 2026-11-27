import type { ReactNode } from "react";
import { formatQuantity } from "@/lib/format";
import { Block } from "@/ui/block";
import { MoneyText } from "@/ui/hidden-values";
import { Money } from "@/ui/money";
import {
  ConfirmedDetails,
  ConfirmedItems,
  ConfirmedPaymentParts,
} from "./confirmed-sale-parts";
import type { ConfirmedSaleView } from "./sale-form-model";
import { LeaderRow, Perforation } from "./sale-summary-panel";

interface SaleReceiptProps {
  /** Shown under the title and above the total: the cancellation, when the sale was cancelled. */
  before?: ReactNode;
  /** The customer of the sale, one line under the title ("Cliente: …"). */
  customer?: ReactNode;
  sale: ConfirmedSaleView;
  /** The states of the sale (Confirmada, Com devoluções…), at the right of the title. */
  status: ReactNode;
}

/**
 * The confirmed sale exactly as stored, as a receipt (DESIGN.md v5.1): right under the title, a strip of two, the
 * total (the biggest, because the eye looks for it first) and the count of items, and the total is written only
 * there; the perforation; then the items, the adjustments and the three dates; then the payment,
 * and the identifier at the end, in mono and without emphasis. The amounts of the lines are in Geist Mono and end at
 * the right edge, the names and the labels in Geist. The order is the order of the DOM, so a screen reader
 * reads what the eye sees.
 */
export function SaleReceipt({
  before,
  customer,
  sale,
  status,
}: SaleReceiptProps) {
  const rows = sale.totals.filter((row) => row.tone !== "total");
  const total = sale.totals.find((row) => row.tone === "total");
  return (
    <Block
      aside={
        <span className="flex flex-wrap items-center gap-1.5">{status}</span>
      }
      title="Venda"
      variant="plain"
    >
      {customer}
      {before}
      {total ? (
        <dl className="flex flex-wrap gap-x-6 gap-y-3" data-receipt-totals="">
          <div className="grid grow-[1.4] gap-1">
            <dt className="font-medium text-muted-foreground">{total.label}</dt>
            <dd>
              <Money className="font-semibold" size="lg" text={total.value} />
            </dd>
          </div>
          <div className="grid grow gap-1">
            <dt className="font-medium text-muted-foreground">
              {sale.summary.itemCount === 1 ? "Item" : "Itens"}
            </dt>
            <dd className="font-mono text-value-md tabular-nums">
              {formatQuantity(sale.summary.itemCount)}
            </dd>
          </div>
        </dl>
      ) : null}
      {total ? (
        <div className="-mx-(--card-spacing)">
          <Perforation />
        </div>
      ) : null}
      <ConfirmedItems
        headingId="sale-detail-items"
        items={sale.items}
        receipt
      />
      <dl className="grid gap-2">
        {rows.map((row) => (
          <LeaderRow
            key={row.key}
            label={row.label}
            mono
            tone={row.tone}
            value={<MoneyText text={row.value} />}
          />
        ))}
      </dl>
      <ConfirmedDetails
        block="dates"
        details={sale.saleDetails.filter(
          (detail) => detail.value !== sale.saleId
        )}
      />
      <div className="-mx-(--card-spacing) grid gap-2 border-border border-t px-(--card-spacing) pt-(--card-spacing)">
        <h3 className="font-medium">Pagamento</h3>
        {sale.paymentParts ? (
          <ConfirmedPaymentParts parts={sale.paymentParts} />
        ) : (
          <ConfirmedDetails
            block="payment"
            details={sale.paymentDetails}
            receipt
          />
        )}
        <p className="text-muted-foreground text-support">{sale.note}</p>
        <p className="grid gap-0.5 pt-1">
          <span className="text-muted-foreground text-support">
            Identificador da venda
          </span>
          <span className="font-mono text-muted-foreground text-xs [overflow-wrap:anywhere]">
            {sale.saleId}
          </span>
        </p>
      </div>
    </Block>
  );
}
