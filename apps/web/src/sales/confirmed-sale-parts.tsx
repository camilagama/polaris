import { cn } from "@/lib/utils";
import { MoneyText } from "@/ui/hidden-values";
import { Money } from "@/ui/money";
import type { ConfirmedSaleView } from "./sale-form-model";
import { FeeValue } from "./sale-summary-panel";

type ConfirmedDetail = ConfirmedSaleView["saleDetails"][number];

/** Amounts, as opposed to words ("não se aplica"), dates and unknowns: what the receipt sets in Geist Mono. */
function isAmount(detail: ConfirmedDetail): boolean {
  return detail.tone === "known" || detail.tone === "zero";
}

/** The lines of a receipt: label at the left, value at the right edge, amounts in mono; shared by the block of one payment and by each part. */
function ReceiptRows({
  details,
}: {
  details: ConfirmedSaleView["saleDetails"];
}) {
  return details.map((detail) => (
    <div
      className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5"
      key={detail.label}
    >
      <dt className="min-w-0 text-muted-foreground text-xs [overflow-wrap:break-word]">
        {detail.label}
      </dt>
      <dd
        className={cn(
          "ml-auto min-w-0 text-right text-sm [overflow-wrap:break-word]",
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
  ));
}

/**
 * The dates or the payment of a confirmed sale: label above, value below, in a block set back into the card (the
 * muted fill, no border: a ring inside the card's ring reads as a box in a box). Two columns from 760 px, one on touch.
 * `receipt` writes it as the lines of a receipt instead: label at the left, value at the right edge, amounts in mono.
 * A line wraps when label and value do not fit together: the value goes whole to the line below, still at the right
 * edge, instead of being squeezed into what the label leaves and cut inside a word.
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
        <ReceiptRows details={details} />
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

/**
 * The payment of a sale paid in more than one part, in the `Pagamento` block of the receipt and of the summary after
 * the confirmation: one block per part, in the order the server sends them (by position). The method is in full, the amount of the part
 * in Geist Mono at the right edge, the installments on the line below, and under them the profile, rule, fees and
 * settlement estimate of that part. There is no line with the sum: the total is written once, at the top of the receipt.
 * The group is named "Pagamento em N partes" so a screen reader announces the block before the parts.
 */
export function ConfirmedPaymentParts({
  parts,
}: {
  parts: NonNullable<ConfirmedSaleView["paymentParts"]>;
}) {
  return (
    <ol
      aria-label={`Pagamento em ${parts.length} partes`}
      className="grid gap-3"
      data-receipt-block="payment-parts"
    >
      {parts.map((part, index) => (
        <li
          className="grid gap-2 rounded-lg bg-muted p-4"
          data-payment-part={index + 1}
          key={part.position}
        >
          <p className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <span className="min-w-0 font-medium [overflow-wrap:break-word]">
              <span className="sr-only">{`Parte ${index + 1}: `}</span>
              {part.methodText}
            </span>
            <span className="ml-auto min-w-0 text-right">
              <Money text={part.amountText} />
            </span>
          </p>
          {part.installmentText ? (
            <p className="text-muted-foreground text-xs">
              {part.installmentText}
            </p>
          ) : null}
          <dl className="grid gap-2">
            <ReceiptRows details={part.details} />
          </dl>
        </li>
      ))}
    </ol>
  );
}
