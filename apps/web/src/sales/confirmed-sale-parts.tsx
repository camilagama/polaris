import { NoBreakMoney } from "@/ui/hidden-values";
import type { ConfirmedSaleView } from "./sale-form-model";
import { FeeValue } from "./sale-summary-panel";

/**
 * The dates or the payment of a confirmed sale: label above, value below, in a block set back into the card (the
 * muted fill, no border: a ring inside the card's ring reads as a box in a box). Two columns from 760 px, one on touch.
 */
export function ConfirmedDetails({
  details,
}: {
  details: ConfirmedSaleView["saleDetails"];
}) {
  if (details.length === 0) {
    return null;
  }
  return (
    <dl className="grid gap-3 rounded-lg bg-muted p-4 md:grid-cols-2">
      {details.map((detail) => (
        <div className="grid gap-0.5" key={detail.label}>
          <dt className="text-muted-foreground text-xs">{detail.label}</dt>
          <dd className="text-sm [overflow-wrap:anywhere]">
            {detail.tone === "plain" ? (
              <NoBreakMoney text={detail.value} />
            ) : (
              <FeeValue line={{ text: detail.value, tone: detail.tone }} />
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The items of a confirmed sale as stored: product, quantities and prices, and the recorded cost. */
export function ConfirmedItems({
  headingId,
  items,
}: {
  headingId: string;
  items: ConfirmedSaleView["items"];
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
            <span className="tabular-nums">
              <NoBreakMoney text={item.detail} />
            </span>
            <span className="text-muted-foreground text-support">
              <NoBreakMoney text={item.costText} />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
