import { cn } from "@/lib/utils";
import { MoneyText } from "@/ui/hidden-values";
import type { ConfirmedSaleView } from "./sale-form-model";
import { FeeValue } from "./sale-summary-panel";

type ConfirmedDetail = ConfirmedSaleView["saleDetails"][number];

/** Amounts, as opposed to words ("não se aplica"), dates and unknowns: what the receipt sets in Geist Mono. */
function isAmount(detail: ConfirmedDetail): boolean {
  return detail.tone === "known" || detail.tone === "zero";
}

/**
 * The dates or the payment of a confirmed sale: label above, value below, in a block set back into the card (the
 * muted fill, no border: a ring inside the card's ring reads as a box in a box). Two columns from 760 px, one on touch.
 * `receipt` writes it as the lines of a receipt instead: label at the left, value at the right edge, amounts in mono.
 */
export function ConfirmedDetails({
  block,
  details,
  receipt = false,
}: {
  block?: "dates" | "payment";
  details: ConfirmedSaleView["saleDetails"];
  receipt?: boolean;
}) {
  if (details.length === 0) {
    return null;
  }
  if (receipt) {
    return (
      <dl
        className="grid gap-2 rounded-lg bg-muted p-4"
        data-receipt-block={block}
      >
        {details.map((detail) => (
          <div
            className="flex items-baseline justify-between gap-3"
            key={detail.label}
          >
            <dt className="min-w-0 text-muted-foreground text-xs [overflow-wrap:anywhere]">
              {detail.label}
            </dt>
            <dd
              className={cn(
                "flex-1 text-right text-sm [overflow-wrap:anywhere]",
                isAmount(detail) && "font-mono tabular-nums"
              )}
            >
              {detail.tone === "plain" ? (
                <MoneyText text={detail.value} />
              ) : (
                <FeeValue line={{ text: detail.value, tone: detail.tone }} />
              )}
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <dl
      className="grid gap-3 rounded-lg bg-muted p-4 md:grid-cols-2"
      data-receipt-block={block}
    >
      {details.map((detail) => (
        <div className="grid gap-0.5" key={detail.label}>
          <dt className="text-muted-foreground text-xs">{detail.label}</dt>
          <dd className="text-sm [overflow-wrap:anywhere]">
            {detail.tone === "plain" ? (
              <MoneyText text={detail.value} />
            ) : (
              <FeeValue line={{ text: detail.value, tone: detail.tone }} />
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The items of a confirmed sale as stored: product, quantities and prices, and the recorded cost. In the `receipt`
 * the line of prices is in Geist Mono and ends at the right edge; the name and the cost note stay at the left.
 */
export function ConfirmedItems({
  headingId,
  items,
  receipt = false,
}: {
  headingId: string;
  items: ConfirmedSaleView["items"];
  receipt?: boolean;
}) {
  return (
    <section aria-labelledby={headingId} className="grid gap-2">
      <h3 className="font-medium" id={headingId}>
        Itens
      </h3>
      <ul className="grid gap-2">
        {items.map((item) => (
          <li className="grid gap-0.5" key={item.key}>
            <span className="font-medium [overflow-wrap:anywhere]">
              {item.label}
            </span>
            <span
              className={cn(
                "tabular-nums",
                receipt && "text-right font-mono [overflow-wrap:anywhere]"
              )}
            >
              <MoneyText text={item.detail} />
            </span>
            <span className="text-muted-foreground text-support">
              <MoneyText text={item.costText} />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
