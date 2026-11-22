import ArrowDownIcon from "lucide-react/dist/esm/icons/arrow-down";
import ArrowUpIcon from "lucide-react/dist/esm/icons/arrow-up";
import {
  type ChangeEvent,
  type CSSProperties,
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { formatBrlAmount } from "@/lib/format";
import { MASKED_SPOKEN, maskMoney, useHiddenValues } from "@/lib/hidden-values";
import { cn } from "@/lib/utils";
import { AnimatedFigure } from "./animated-figure";
import { Card } from "./card";
import { HelpTip } from "./help-tip";
import { MoneyText } from "./hidden-values";
import { maskedAmountWidthEm, Money, splitAmountWidthEm } from "./money";
import { Skeleton } from "./skeleton";

/** From 1280 px the strip is one card: no gap, a 1 px line between the cells, the corners clipping the sparklines. */
const STRIP_CARD =
  "xl:gap-0 xl:divide-x xl:divide-border xl:overflow-hidden xl:rounded-xl xl:bg-card xl:shadow-xs xl:ring-1 xl:ring-foreground/[0.06] xl:dark:shadow-[inset_0_1px_0_var(--card-glow)]";

/**
 * One column up to 759 px, two columns from 760 and, from 1280 px, one card with four columns and a 1 px line between
 * them (the Início and the Resultado). The cells give up their own ring, background and rounding (`KPI_STRIP_CELL`); the strip clips the
 * sparklines to its corners.
 */
export const KPI_STRIP = `grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4 ${STRIP_CARD}`;

const KPI_STRIP_CELL =
  "xl:rounded-none xl:bg-transparent xl:shadow-none! xl:ring-0";

/** The entity of a card: its color in the charts (theme.css, v7 § 5). */
export type KpiEntity = "result" | "sales" | "ticket";

const SIGN = /^[+-]/;

/**
/**
 * The box of the number: one line of a fixed height, so "R$ 129,90" (with the "R$" and the cents smaller), "R$ ••••"
 * (whose dots may come from another font) and "—" take the same height, and nothing under them moves when the values
 * are hidden or a day is read. Every card of a grid has the one size, `text-value-lg` (30 px line; 28 on a phone), with no card
 * above the others (the large card of the gallery has `HERO_BOX_XL`): the "R$" and the number are the same size, weight and line in all of them. No tracking: negative spacing
 * squeezes the fixed cells of a monospaced figure. The size is one of the tokens of the scale; `leading-*` sets the line
 * whatever the size class says, and goes after the size classes of its own variant, because the merge of the classes
 * drops a `leading-*` that comes before one.
 */
const HERO_BOX_LG =
  "h-(--text-value-lg--line-height) whitespace-nowrap font-mono font-semibold text-value-lg tabular-nums";

const HERO_BOX_XL =
  "h-(--text-value-xl--line-height) whitespace-nowrap font-mono font-semibold text-value-xl tabular-nums";

type HeroSize = "lg" | "xl";

const HERO_BOX: Record<HeroSize, string> = { lg: HERO_BOX_LG, xl: HERO_BOX_XL };

/** A little more than the figure takes, so the fit does not rest on a fraction of a pixel (the area clips what overflows). */
const FIGURE_FIT_MARGIN = 1.04;

/** The floor of the figure of a tile: "R$ 1.234.567,89" fits the narrowest area at it; an amount longer than that is clipped by the area. */
const TILE_FIGURE_FLOOR = "0.875rem";

/**
 * Geist Mono has one advance for every glyph, so the width in em is known without measuring each amount; the em is the
 * figure's own, so the fit is the same at `lg` and at `xl`.
 */
function tileFigureSize(widthEm: number, size: HeroSize): CSSProperties {
  const fit = (100 / (widthEm * FIGURE_FIT_MARGIN)).toFixed(2);
  return {
    fontSize: `max(${TILE_FIGURE_FLOOR}, min(var(--text-value-${size}), ${fit}cqw))`,
  };
}

function writtenWidthEm(amount: string, hidden: boolean): number {
  return hidden
    ? maskedAmountWidthEm()
    : splitAmountWidthEm(formatBrlAmount(amount));
}

export function HeroValue({
  amount,
  emptyText,
  reading = false,
  size: scale = "lg",
  tile = false,
}: {
  /** The amount as the server writes money ("1234.5"), or null when there is none. */
  amount: string | null;
  /** What a missing amount says in place of the dash, in the same one-line box ("sem custo neste dia"). */
  emptyText?: string | undefined;
  /** The amount is the day read on a sparkline: it swaps with no entrance (the return to rest is handled by `AnimatedFigure`). */
  reading?: boolean;
  size?: HeroSize;
  /** The value of a `KpiTile`: its size follows the width of its own area, which a long amount does not change. */
  tile?: boolean;
}) {
  const [hidden] = useHiddenValues();
  const size =
    tile && amount !== null
      ? tileFigureSize(writtenWidthEm(amount, hidden), scale)
      : undefined;
  const box = HERO_BOX[scale];
  if (amount === null && emptyText) {
    return (
      <p className={cn(box, "text-muted-foreground")}>
        <span className="font-medium font-sans text-sm tracking-normal">
          {emptyText}
        </span>
      </p>
    );
  }
  if (amount === null) {
    return (
      <p className={cn(box, "text-muted-foreground")}>
        <Money text={null} />
      </p>
    );
  }
  const negative = amount.trim().startsWith("-");
  const written = formatBrlAmount(amount);
  const money = (
    <AnimatedFigure hidden={hidden} reading={reading} text={written}>
      <Money split text={written} />
    </AnimatedFigure>
  );
  if (hidden) {
    return (
      <p className={box} data-kpi-value="" style={size}>
        {money}
      </p>
    );
  }
  return (
    <p
      className={cn(box, negative && "text-destructive")}
      data-kpi-value=""
      style={size}
    >
      {money}
    </p>
  );
}

/**
 * A percent in the box of the number (the Margem): the same size, weight and line as the amounts beside it, with the
 * "%" a step smaller, as the "R$" is. Never hidden: a percent does not tell what the store sells.
 */
export function HeroPercent({
  text,
}: {
  /** The percent as the app writes it ("41,2%"), or null when there is none. */
  text: string | null;
}) {
  if (text === null) {
    return (
      <p className={cn(HERO_BOX_LG, "text-muted-foreground")}>
        <span aria-hidden="true">—</span>
        <span className="sr-only">sem valor</span>
      </p>
    );
  }
  return (
    <p
      className={cn(
        HERO_BOX_LG,
        text.trim().startsWith("-") && "text-destructive"
      )}
      data-kpi-value=""
    >
      {text.replace("%", "")}
      <span className="font-medium text-[0.56em] tracking-normal">%</span>
    </p>
  );
}

/** The change of a card: green when it went up, neutral when it went down or stayed (selling less is not an error). */
export interface KpiDelta {
  /** What the change is against, said short beside it: "vs. setembro". */
  against?: string;
  /** What the change is against, for the name of the chip: "em relação a 1 a 23/09". */
  basis?: string;
  money: boolean;
  /** What a screen reader says in place of `text`: the direction in words ("subiu 30,0 por cento"). */
  spoken: string;
  text: string;
  trend: "down" | "flat" | "up";
}

/** An amount of a chip: its sign stays in sight when the amount is hidden ("+R$ ••••"), so the direction is not lost. */
function MoneyChipText({ text }: { text: string }) {
  const sign = SIGN.exec(text)?.[0] ?? "";
  // one box: the gap of the chip would come between the sign and a hidden amount ("+ R$ ••••")
  return (
    <span>
      {sign}
      <MoneyText text={text.slice(sign.length)} />
    </span>
  );
}

/**
 * The chip says what moved in words: the sign and the arrow are for the eye (hidden from a screen reader), and the
 * words ("subiu 30,0 por cento") are the name of the whole chip when it has one, or a text only a screen reader gets
 * when it has none, so the same phrase is never heard twice.
 */
function chipText(delta: KpiDelta, named: boolean, hidden: boolean): ReactNode {
  const seen = (
    <span
      aria-hidden="true"
      className={delta.money ? undefined : "font-mono"}
      data-kpi-delta-text=""
    >
      {delta.money ? <MoneyChipText text={delta.text} /> : delta.text}
    </span>
  );
  if (named) {
    return seen;
  }
  const spoken =
    hidden && delta.money
      ? maskMoney(delta.spoken, MASKED_SPOKEN)
      : delta.spoken;
  return (
    <span>
      {seen}
      <span className="sr-only">{spoken}</span>
    </span>
  );
}

const CHIP_UP =
  "bg-[color-mix(in_oklab,var(--chart-sales)_12%,var(--card))] text-mark-foreground";

export function DeltaChip({ delta }: { delta: KpiDelta }) {
  const [hidden] = useHiddenValues();
  let Icon: typeof ArrowUpIcon | null = null;
  if (delta.trend === "up") {
    Icon = ArrowUpIcon;
  } else if (delta.trend === "down") {
    Icon = ArrowDownIcon;
  }
  // the name says the change and what it is against ("subiu 30,0 por cento em relação a setembro"), and hides the amount of a result
  let name: string | undefined;
  if (delta.basis) {
    name = `${delta.spoken} ${delta.basis}`;
    if (hidden && delta.money) {
      name = maskMoney(name, MASKED_SPOKEN);
    }
  }
  const named = name ? ({ "aria-label": name, role: "img" } as const) : {};
  const up = delta.trend === "up";
  return (
    <span
      {...named}
      className={cn(
        "inline-flex h-5 min-w-0 max-w-full items-center whitespace-nowrap rounded-full py-0.5 font-semibold text-xs tabular-nums leading-4",
        up ? CHIP_UP : "bg-muted text-muted-foreground"
      )}
      data-kpi-delta={delta.trend}
    >
      <span
        className={cn(
          "inline-flex shrink-0 items-center gap-0.5 pl-1.25",
          delta.against ? "pr-0" : "pr-1.75"
        )}
        data-kpi-pill=""
      >
        {Icon ? <Icon aria-hidden="true" className="size-3 shrink-0" /> : null}
        {chipText(delta, name !== undefined, hidden)}
      </span>
      {delta.against ? (
        <span
          className="ml-1.5 min-w-0 truncate pr-1.75 font-normal"
          data-kpi-delta-against=""
        >
          {delta.against}
        </span>
      ) : null}
    </span>
  );
}

/** The keyboard control of a sparkline: a native range over the drawing, transparent and deaf to the pointer. */
export interface KpiRange {
  label: string;
  max: number;
  onBlur: () => void;
  onChange: (index: number) => void;
  value: number;
  valueText: string;
}

/* transparent, with no track and no thumb (the sparkline shows the point read) and deaf to the pointer (the drawing
   under it reads the pointer); the 3 px outline of the keyboard focus is drawn inside the tile, which clips it */
const RANGE_CLASS =
  "pointer-events-none absolute inset-0 m-0 size-full appearance-none rounded-b-xl bg-transparent focus-visible:outline-3 focus-visible:outline-ring focus-visible:-outline-offset-3 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-transparent [&::-moz-range-track]:bg-transparent [&::-webkit-slider-runnable-track]:bg-transparent [&::-webkit-slider-thumb]:appearance-none";

function SparkSlot({
  className,
  range,
  spark,
}: {
  className: string;
  range: KpiRange | undefined;
  spark: ReactNode;
}) {
  const onChange = range?.onChange;
  const change = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      onChange?.(Number(event.currentTarget.value)),
    [onChange]
  );
  return (
    <div className={cn("relative touch-pan-y", className)} data-kpi-spark="">
      {spark}
      {range ? (
        <input
          aria-label={range.label}
          aria-valuetext={range.valueText}
          className={RANGE_CLASS}
          max={range.max}
          min={0}
          onBlur={range.onBlur}
          onChange={change}
          step={1}
          type="range"
          value={range.value}
        />
      ) : null}
    </div>
  );
}

const TOP_ROW =
  "flex min-h-[1.125rem] min-w-0 items-center justify-between gap-x-2 text-muted-foreground text-support";

function CardTitle({
  help,
  id,
  live,
  title,
}: {
  help: { about: string; text: string } | undefined;
  id: string;
  live: boolean;
  title: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1 touch:gap-2.5">
      <h2
        aria-live={live ? "polite" : undefined}
        className="flex min-w-0 items-center font-medium text-foreground"
        id={id}
      >
        <span className="min-w-0">{title}</span>
      </h2>
      {help ? (
        <HelpTip about={help.about} className="relative z-10 -my-0.75">
          {help.text}
        </HelpTip>
      ) : null}
    </div>
  );
}

/*
 * The tile of the Início and of the Resultado: about 92 px, three lines (the name with the (i); the number with the sparkline of 36 px to its
 * right; the support line, as wide as the tile). With a day read, its date takes the place of the chip on the support line
 * (the row is always there, so nothing moves). On the Início the warning of an estimate that is not whole is the support
 * line itself: one line, so the tile has the height of the others. On the Resultado the `notice` has a row of its own
 * under the support line, free to wrap, and the tile grows by it. The color of the entity is in the drawing, not in a square. With
 * touch the title row and the keyboard control of the sparkline are 44 px: the control starts under the touch area of
 * the (i), so the two never overlap (the tile grows by what it takes), and the title keeps its place.
 */
const TILE =
  "@container relative min-w-0 gap-0.5 overflow-hidden px-(--card-spacing) py-3 touch:pt-0";
/* two areas of a width the tile gives and no content changes: two thirds for the number, one third for the sparkline (a
   container of its own, so the number measures itself against its area), whether or not there is a sparkline; with touch
   the sparkline is 44 px less its margins, 30, and the body keeps them for the tile that has none */
const TILE_BODY =
  "grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)] items-center gap-3 touch:mt-1.5 touch:min-h-7.5";
const TILE_FIGURE = "@container min-w-0 overflow-hidden";
/* the large card is as wide as the page, so the sparkline gets two fifths of it from 760 px, not a third: the number keeps its
   three fifths, and the line of the number is the tallest thing in the body, so the box does not depend on the drawing */
const HERO_BODY =
  "grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)] items-center gap-3 touch:mt-1.5 touch:min-h-7.5 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]";
/* its 36 px (44 with touch) do not add to the 30 px line of the number */
const TILE_SPARK =
  "z-10 -my-0.75 h-9 min-w-0 self-center touch:-my-1.75 touch:h-11 touch:py-1";
const TILE_TITLE_ROW = "touch:min-h-11";
const TILE_SUPPORT =
  "flex min-h-5 min-w-0 flex-wrap items-center gap-x-2 text-muted-foreground text-xs leading-4";
/* the warning row is one line: the sign comes first and never shrinks, and the detail (the days) is the last item, which
   `WarningDetail` shows whole or not at all, never wrapped out of sight and never cut with an ellipsis */
const TILE_WARNING = "h-5 flex-nowrap overflow-hidden";

/**
 * The detail of a warning, shown only when its whole text fits in the room the row leaves after the sign. It is measured
 * on the real box (the width of the tile and the size of the letter both move it), not decided by a count of characters;
 * what does not fit stays in the layout but invisible and out of the reading, so a resize can bring it back, and the (i)
 * of the tile says it.
 */
function WarningDetail({ children }: { children: ReactNode }) {
  const box = useRef<HTMLSpanElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  const [fits, setFits] = useState(true);
  useLayoutEffect(() => {
    const outer = box.current;
    const inner = text.current;
    if (!(outer && inner)) {
      return;
    }
    const measure = () => {
      setFits(
        inner.getBoundingClientRect().width <=
          outer.getBoundingClientRect().width + 0.05
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(outer);
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);
  return (
    <span
      aria-hidden={fits ? undefined : true}
      className={cn(
        "min-w-0 flex-1 overflow-hidden whitespace-nowrap",
        !fits && "invisible"
      )}
      data-kpi-warning-detail=""
      ref={box}
    >
      <span className="inline-block" ref={text}>
        {children}
      </span>
    </span>
  );
}

export function KpiTile({
  action,
  chip,
  className,
  date,
  entity,
  help,
  hero = false,
  id,
  note,
  notice,
  range,
  spark,
  strip = false,
  title,
  titleLive = false,
  value,
  warning,
  warningDetail,
}: {
  /** What the tile offers when it has no figure to show (a link to start): beside the support text. */
  action?: ReactNode;
  chip?: ReactNode;
  className?: string;
  /** The day read on the sparkline ("Até 17/10"), in the place of the chip; none at rest. */
  date?: string | undefined;
  entity: KpiEntity;
  help?: { about: string; text: string };
  hero?: boolean;
  id: string;
  /** What goes beside the chip: the count. */
  note?: ReactNode;
  /** A warning on a row of its own under the support line, free to wrap and to make the tile taller: the Resultado's, where the badge and the days do not fit one line at 320 px. */
  notice?: ReactNode;
  range?: KpiRange;
  spark?: ReactNode;
  /** The tile is a column of `KPI_STRIP`: from 1280 px it gives up its own card. */
  strip?: boolean;
  title: ReactNode;
  titleLive?: boolean;
  value: ReactNode;
  /** The sign of a warning that must stay in sight: it opens the support line, which stays one line tall. */
  warning?: ReactNode;
  /** What the sign says more (the days with no cost): last on the line, shown whole or not at all (`WarningDetail`), never cut with an ellipsis nor wrapped out of sight. */
  warningDetail?: ReactNode;
}) {
  return (
    <Card
      aria-labelledby={id}
      className={cn(TILE, strip && KPI_STRIP_CELL, className)}
      data-kpi={entity}
      data-kpi-hero={hero ? "" : undefined}
      role="region"
    >
      <div className={cn(TOP_ROW, TILE_TITLE_ROW)}>
        <CardTitle help={help} id={id} live={titleLive} title={title} />
      </div>
      <div className={hero ? HERO_BODY : TILE_BODY} data-kpi-body="">
        <div className={TILE_FIGURE} data-kpi-headline="">
          {value}
        </div>
        {spark ? (
          <SparkSlot className={TILE_SPARK} range={range} spark={spark} />
        ) : null}
      </div>
      <div
        className={cn(TILE_SUPPORT, warning && TILE_WARNING)}
        data-kpi-note-row=""
      >
        {warning ? (
          <span className="shrink-0" data-kpi-warning="">
            {warning}
          </span>
        ) : null}
        {date ? (
          <span
            className="shrink-0 whitespace-nowrap font-medium text-foreground tabular-nums"
            data-kpi-date=""
          >
            {date}
          </span>
        ) : null}
        {chip && !date ? (
          <span className="shrink-0" data-kpi-chip-row="">
            {chip}
          </span>
        ) : null}
        {note}
        {action}
        {warningDetail ? <WarningDetail>{warningDetail}</WarningDetail> : null}
      </div>
      {notice ? (
        <div className={TILE_SUPPORT} data-kpi-notice="">
          {notice}
        </div>
      ) : null}
    </Card>
  );
}

/** A tile while its figures are read: the same rows with their heights, in `Skeleton`, so the tile that comes takes the same place (a Result tile with a cost warning adds its line). */
export function KpiTileSkeleton({
  hero = false,
  strip = false,
}: {
  /** The skeleton of the hero: the box of its number is the `xl` one. */
  hero?: boolean;
  /** The skeleton of a column of a strip: from 1280 px it gives up its own card, as the tile does. */
  strip?: boolean;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "group/card flex flex-col overflow-hidden rounded-xl bg-card text-sm shadow-xs ring-1 ring-foreground/[0.06] [--card-spacing:--spacing(3)] dark:shadow-[inset_0_1px_0_var(--card-glow)] md:[--card-spacing:--spacing(4)]",
        TILE,
        strip && KPI_STRIP_CELL
      )}
      data-kpi-skeleton=""
    >
      <div className={cn(TOP_ROW, "h-4.5 touch:h-11")}>
        <Skeleton className="h-3 w-24" />
      </div>
      <div
        className={cn(
          hero ? HERO_BOX_XL : HERO_BOX_LG,
          "touch:mt-1.5 flex min-h-7.5 items-center"
        )}
      >
        <Skeleton className="h-[0.8em] w-32" />
      </div>
      <div className={TILE_SUPPORT}>
        <Skeleton className="h-3 w-20" />
      </div>
    </div>
  );
}
