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
 * no size the amount takes the font of the line it is in (running text, a card that sets its own size). The two big
 * sizes are the display of a figure and are set in Geist Mono, whose digits all advance the same, so the figure does not
 * change width when its digits change; `sm`, `md` and the sizeless amount stay in Geist with `tabular-nums`.
 */
type MoneySize = "sm" | "md" | "lg" | "xl";

const SIZE_CLASS: Record<MoneySize, string> = {
  lg: "font-mono text-value-lg",
  md: "text-value-md",
  sm: "text-value-sm",
  xl: "font-mono text-value-xl",
};

/** What Geist Mono advances per character, in em: the same for every glyph the figure writes (measured at 1000 px: 600). */
const MONO_ADVANCE_EM = 0.6;
/** The "R$" and the cents of a split amount, in em of the figure: the two classes below say it, and `money.test.tsx` holds them together. */
const CURRENCY_EM = 0.56;
const CENTS_EM = 0.72;

/** "-R$ 1.234,56" into its sign, its whole part and its cents ("R$ 1.234,56" has the sign empty). */
const AMOUNT = /^([-+−]?)R\$\s?([\d.]+)(,\d{2})$/;

/* the "R$" is a size smaller than the number and the cents one step under it, in the color of the number */
const CURRENCY_CLASS = "font-medium text-[0.56em] tracking-normal";
const CENTS_CLASS = "text-[0.72em]";

/** What the mask takes at the size of its box, in em: the small "R$ " and the dots at the size of the figure. */
export function maskedAmountWidthEm(): number {
  return ("R$ ".length * CURRENCY_EM + MASKED_DOTS.length) * MONO_ADVANCE_EM;
}

/** "R$ 99.640,35" at the size of its box, in em: the width a split amount takes in Geist Mono, the "R$" and the cents being smaller. */
export function splitAmountWidthEm(text: string): number {
  const parts = AMOUNT.exec(text);
  if (!parts) {
    return text.length * MONO_ADVANCE_EM;
  }
  const [, sign = "", whole = "", cents = ""] = parts;
  const characters =
    sign.length +
    whole.length +
    "R$ ".length * CURRENCY_EM +
    cents.length * CENTS_EM;
  return characters * MONO_ADVANCE_EM;
}

interface MoneyProps {
  className?: string | undefined;
  size?: MoneySize | undefined;
  /** Writes the "R$" apart from the number: the default for `lg` and `xl`, where a "R$" at the size of the number is too big. */
  split?: boolean | undefined;
  /** As `formatBrlAmount` writes it ("R$ 1.234,56"); null is an amount nobody knows, "—". */
  text: string | null;
}

export function Money({
  className,
  size,
  split = size === "lg" || size === "xl",
  text,
}: MoneyProps) {
  const [hidden] = useHiddenValues();
  // the display has no tracking: negative spacing squeezes the fixed cells of a monospaced figure
  const displayed = size === "lg" || size === "xl";
  const sized = cn(
    "whitespace-nowrap",
    size && ["tabular-nums", SIZE_CLASS[size]],
    className,
    displayed && "tracking-normal"
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
  if (hidden) {
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
