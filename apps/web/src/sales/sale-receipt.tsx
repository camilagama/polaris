import type { ReactNode } from "react";
import { Card, CardContent } from "@/ui/card";
import { ConfirmedDetails, ConfirmedItems } from "./confirmed-sale-parts";
import type { ConfirmedSaleView } from "./sale-form-model";
import { LeaderRow, Money, Perforation } from "./sale-summary-panel";

interface SaleReceiptProps {
  /** Shown above the dates: the cancellation, when the sale was cancelled. */
  before?: ReactNode;
  sale: ConfirmedSaleView;
  /** The states of the sale (Confirmada, Com devoluções…), at the right of the title. */
  status: ReactNode;
}

/**
 * The confirmed sale exactly as stored, as a receipt (DESIGN.md v5.1): dates, items and adjustments, the
 * perforation, the total; then the payment, and the identifier at the end, in mono and without emphasis.
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
          <ConfirmedDetails
            details={sale.saleDetails.filter(
              (detail) => detail.value !== sale.saleId
            )}
          />
          <ConfirmedItems headingId="sale-detail-items" items={sale.items} />
          <dl className="grid gap-2">
            {rows.map((row) => (
              <LeaderRow
                key={row.key}
                label={row.label}
                tone={row.tone}
                value={row.value}
              />
            ))}
          </dl>
        </CardContent>
        {total ? (
          <>
            <Perforation />
            <CardContent className="py-(--card-spacing)">
              <dl>
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="font-medium text-muted-foreground">
                    {total.label}
                  </dt>
                  <dd>
                    <Money
                      className="font-semibold text-value-lg tracking-[-0.035em]"
                      text={total.value}
                    />
                  </dd>
                </div>
              </dl>
            </CardContent>
          </>
        ) : null}
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
