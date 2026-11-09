import type { ReactNode } from "react";
import { Card, CardContent } from "@/ui/card";
import { MoneyText } from "@/ui/hidden-values";
import { Money } from "@/ui/money";
import { ConfirmedDetails, ConfirmedItems } from "./confirmed-sale-parts";
import type { ConfirmedSaleView } from "./sale-form-model";
import { LeaderRow, Perforation } from "./sale-summary-panel";

interface SaleReceiptProps {
  /** Shown under the title and above the total: the cancellation, when the sale was cancelled. */
  before?: ReactNode;
  sale: ConfirmedSaleView;
  /** The states of the sale (Confirmada, Com devoluções…), at the right of the title. */
  status: ReactNode;
}

/**
 * The confirmed sale exactly as stored, as a receipt (DESIGN.md v5.1): the total right under the title, because
 * the eye looks for it first; the perforation; then the items, the adjustments and the three dates; then the payment,
 * and the identifier at the end, in mono and without emphasis. The order is the order of the DOM, so a screen reader
 * reads what the eye sees.
 */
export function SaleReceipt({ before, sale, status }: SaleReceiptProps) {
  const rows = sale.totals.filter((row) => row.tone !== "total");
  const total = sale.totals.find((row) => row.tone === "total");
  return (
    <section aria-labelledby="sale-detail-title">
      <Card className="gap-0 py-0">
        <CardContent className="grid gap-4 py-(--card-spacing)">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <h2 className="text-section" id="sale-detail-title">
              Venda
            </h2>
            <span className="flex flex-wrap items-center gap-1.5">
              {status}
            </span>
          </div>
          {before}
          {total ? (
            <dl>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="font-medium text-muted-foreground">
                  {total.label}
                </dt>
                <dd>
                  <Money
                    className="font-semibold tracking-[-0.035em]"
                    size="lg"
                    text={total.value}
                  />
                </dd>
              </div>
            </dl>
          ) : null}
        </CardContent>
        {total ? <Perforation /> : null}
        <CardContent className="grid gap-4 py-(--card-spacing)">
          <ConfirmedItems headingId="sale-detail-items" items={sale.items} />
          <dl className="grid gap-2">
            {rows.map((row) => (
              <LeaderRow
                key={row.key}
                label={row.label}
                tone={row.tone}
                value={<MoneyText text={row.value} />}
              />
            ))}
          </dl>
          <ConfirmedDetails
            details={sale.saleDetails.filter(
              (detail) => detail.value !== sale.saleId
            )}
          />
        </CardContent>
        <CardContent className="grid gap-2 border-border border-t py-(--card-spacing)">
          <h3 className="font-medium">Pagamento</h3>
          <ConfirmedDetails details={sale.paymentDetails} />
          <p className="text-muted-foreground text-support">{sale.note}</p>
          <p className="pt-1 font-mono text-muted-foreground text-xs [overflow-wrap:anywhere]">
            <span className="sr-only">Identificador da venda: </span>
            {sale.saleId}
          </p>
        </CardContent>
      </Card>
    </section>
  );
}
