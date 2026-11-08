import {
  MASKED_DOTS,
  MASKED_MONEY,
  MASKED_SPOKEN,
  useHiddenValues,
} from "@/lib/hidden-values";
import { cn } from "@/lib/utils";

/**
 * The one component that writes an amount in reais: it decides the "R$", the cents and the mask, so that hiding the
 * values changes the words and nothing about the type. The size is one of the four `text-value-*` of the scale; with
 * no size the amount takes the font of the line it is in (running text, a card that sets its own size).
 */
type MoneySize = "sm" | "md" | "lg" | "xl";

const SIZE_CLASS: Record<MoneySize, string> = {
  lg: "text-value-lg",
  md: "text-value-md",
  sm: "text-value-sm",
  xl: "text-value-xl",
};

/** "-R$ 1.234,56" into its sign, its whole part and its cents ("R$ 1.234,56" has the sign empty). */
const AMOUNT = /^([-+−]?)R\$\s?([\d.]+)(,\d{2})$/;

/* the "R$" is a size smaller than the number and the cents one step under it, in the color of the number */
const CURRENCY_CLASS = "font-medium text-[0.56em] tracking-normal";
const CENTS_CLASS = "text-[0.72em]";

interface MoneyProps {
  className?: string | undefined;
  size?: MoneySize | undefined;
  /** Writes the "R$" apart from the number: the default for `lg` and `xl`, where a "R$" at the size of the number is too big. */
  split?: boolean | undefined;
  /** As `formatBrlAmount` writes it ("R$ 1.234,56"); null is an amount nobody knows, "—". */
  text: string | null;
  /** Shows the amount while the values are hidden: for the places that mask by themselves. */
  unmasked?: boolean | undefined;
}

export function Money({
  className,
  size,
  split = size === "lg" || size === "xl",
  text,
  unmasked = false,
}: MoneyProps) {
  const [hidden] = useHiddenValues();
  const sized = cn(
    "whitespace-nowrap",
    size && ["tabular-nums", SIZE_CLASS[size]],
    className
  );
  const marker = size || split ? "" : undefined;
  if (text === null) {
    return (
      <>
        <span aria-hidden="true" className={sized} data-money={marker}>
          —
        </span>
        <span className="sr-only">sem valor</span>
      </>
    );
  }
  if (hidden && !unmasked) {
    return (
      <>
        <span
          aria-hidden="true"
          className={sized}
          data-masked-money=""
          data-money={marker}
        >
          {split ? (
            <>
              <span className={CURRENCY_CLASS} data-money-currency="">
                R${" "}
              </span>
              <span data-money-number="">{MASKED_DOTS}</span>
            </>
          ) : (
            MASKED_MONEY
          )}
        </span>
        <span className="sr-only">{MASKED_SPOKEN}</span>
      </>
    );
  }
  const parts = split ? AMOUNT.exec(text) : null;
  if (!parts) {
    return (
      <span className={sized} data-money={marker}>
        {text}
      </span>
    );
  }
  return (
    <span className={sized} data-money={marker}>
      {parts[1]}
      {/* the space is inside the small part: "R$ 90,00" is one text for a screen reader and a search */}
      <span className={CURRENCY_CLASS} data-money-currency="">
        R${" "}
      </span>
      <span data-money-number="">{parts[2]}</span>
      <span className={CENTS_CLASS} data-money-cents="">
        {parts[3]}
      </span>
    </span>
  );
}
