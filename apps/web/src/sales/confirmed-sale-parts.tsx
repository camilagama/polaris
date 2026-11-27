import { cn } from "@/lib/utils";
import { MoneyText } from "@/ui/hidden-values";
import { InsetBlock } from "@/ui/inset-block";
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
 * The dates or the payment of a confirmed sale: label above, value below, in an `InsetBlock`. Two columns from 760 px, one on touch.
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
      <InsetBlock data-receipt-block={block}>
        <dl className="grid gap-2">
          <ReceiptRows details={details} />
        </dl>
      </InsetBlock>
    );
  }
  return (
    <InsetBlock data-receipt-block={block}>
      <dl className="grid gap-3 md:grid-cols-2">
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
    </InsetBlock>
  );
}

/**
 * The items of a confirmed sale as stored: product, quantities and prices, and the recorded cost. Each line has two
 * ends: the quantity and the charged price at the left (with the table price after them, only when it differs) and
 * the total of the item at the right edge, in the column of the subtotal. In the `receipt` the figures are in Geist
 * Mono; the name and the cost note stay at the left. The left part takes its narrowest width as its basis, so the
 * total stays beside the quantity while both fit and goes whole to the line below, at the right edge, when they do not;
 * the table price drops under the quantity before that happens. A screen reader hears the quantity, the charged price, the table
 * price and the total, in that order.
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
            <p
              className={cn(
                "flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 tabular-nums",
                receipt && "font-mono"
              )}
            >
              <span className="min-w-0 flex-[1_1_min-content]">
                <span className="whitespace-nowrap">
                  <MoneyText text={item.chargedText} />
                </span>
                {item.listedText ? (
                  <>
                    <span className="sr-only">,</span>{" "}
                    <span className="whitespace-nowrap text-muted-foreground">
                      <MoneyText text={item.listedText} />
                    </span>
                  </>
                ) : null}
              </span>
              <span className="ml-auto text-right">
                <span className="sr-only">Total do item: </span>
                <MoneyText text={item.totalText} />
              </span>
            </p>
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
        <li data-payment-part={index + 1} key={part.position}>
          <InsetBlock className="grid gap-2">
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
          </InsetBlock>
        </li>
      ))}
    </ol>
  );
}
