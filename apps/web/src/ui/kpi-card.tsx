import ArrowDownIcon from "lucide-react/dist/esm/icons/arrow-down";
import ArrowUpIcon from "lucide-react/dist/esm/icons/arrow-up";
import { type ChangeEvent, type ReactNode, useCallback } from "react";
import { formatBrlAmount } from "@/lib/format";
import { MASKED_SPOKEN, maskMoney, useHiddenValues } from "@/lib/hidden-values";
import { cn } from "@/lib/utils";
import { AnimatedFigure } from "./animated-figure";
import { Card } from "./card";
import { HelpTip } from "./help-tip";
import { MoneyText } from "./hidden-values";
import { Money } from "./money";
import { Skeleton } from "./skeleton";

/**
 * The KPI cards, with our text. `KpiTile` is the one of the Início: the name with the (i),
 * the number, one line of support (the chip of the change, which says in its name what it compares against, and a count
 * or a warning) and, to the right of the number, a sparkline of 36 px that the pointer, the finger and the arrows read.
 * `KpiCard` is the one of the Resultado, with a foot and the sparkline edge to edge. Both are regions named by their
 * title; the number is text, the drawing is a reinforcement.
 */

/**
 * The grid of the tiles of the Início: one column up to 759 px (the `md` of Tailwind, where the side menu appears), two
 * from there, four from 1280 px, where each tile still has room for the number and the sparkline side by side.
 */
export const KPI_GRID =
  "grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4 xl:gap-4";

/**
 * The row of the Resultado: the cards of `KPI_GRID` up to 899 px (two columns from 760 px), and from 900 px one card
 * with four columns and a 1 px line between them (the Venda changes layout at the same line). The cells give up their
 * own ring, background and rounding (`KPI_STRIP_CELL`); the strip clips the sparklines to its corners. The two-column
 * rule of 760 px stops at 899.98 px (56.24875 rem) so the two rules never overlap, whatever order Tailwind writes them in.
 */
const STRIP_LAYOUT =
  "grid grid-cols-1 gap-3 md:max-[56.24875rem]:grid-cols-2 min-[56.25rem]:grid-cols-4 min-[56.25rem]:gap-0 min-[56.25rem]:divide-x min-[56.25rem]:divide-border min-[56.25rem]:overflow-hidden min-[56.25rem]:rounded-xl min-[56.25rem]:bg-card min-[56.25rem]:shadow-xs min-[56.25rem]:ring-1 min-[56.25rem]:ring-foreground/[0.06] min-[56.25rem]:dark:shadow-[inset_0_1px_0_var(--card-glow)]";

/**
 * The height the strip keeps from 900 px, by its own width (its container is `KPI_STRIP_ROOT`): the tallest it gets
 * in any state, measured in the browser over the longest foot of the result card ("estimativa incompleta", the days
 * with no cost and the "Não é lucro líquido nem caixa", wrapped in a column of 150 px), the titles that wrap and, in
 * the columns narrower than 14 rem (all the steps but the last), the two lines the "vs. …" keeps under the number. The
 * ranges exclude each other, so the order of the rules does not matter; with the height kept, a period, a missing
 * comparison, an incomplete cost or hidden values move nothing under the strip. Remeasure when a text of a column
 * changes (`dashboard.e2e.ts`, "a altura da faixa de KPIs não muda").
 */
const STRIP_RESERVE =
  "min-[56.25rem]:@max-[40.124rem]:min-h-[19.125rem] min-[56.25rem]:@[40.125rem]:@max-[44.624rem]:min-h-[18.125rem] min-[56.25rem]:@[44.625rem]:@max-[49.499rem]:min-h-[17.5rem] min-[56.25rem]:@[49.5rem]:@max-[64.249rem]:min-h-[15.375rem] min-[56.25rem]:@[64.25rem]:min-h-[11.875rem]";

export const KPI_STRIP = `${STRIP_LAYOUT} ${STRIP_RESERVE}`;

/** The box that holds the strip and whose width the reserve reads. */
export const KPI_STRIP_ROOT = "@container grid gap-3";

const KPI_STRIP_CELL =
  "min-[56.25rem]:rounded-none min-[56.25rem]:bg-transparent min-[56.25rem]:shadow-none! min-[56.25rem]:ring-0";

/**
 * A column of the strip lines value and change up on one baseline once its content box is 14 rem wide (the value, 6 px
 * and the chip "vs. …" of 12/500); the line never wraps, so the height does not depend on the length of the amount or of
 * the chip. Narrower, the change keeps the line of its own it has in the cards and the chip comes apart (`DeltaChip`
 * with `strip`): only the arrow and the number are in the pill, and the "vs. …" is under it, in as many lines as it needs.
 */
const STRIP_HEADLINE =
  "min-[56.25rem]:@[14rem]:flex-row min-[56.25rem]:@[14rem]:items-baseline min-[56.25rem]:@[14rem]:gap-x-1.5";

/**
 * Beside the number the row of the change keeps no height of its own: empty, it would move the baseline of the line.
 * In a column narrower than that the row keeps the two lines a change may take under the number (the chip of 20 px, 2 px
 * and the "vs. …" in up to two lines of 16 px), empty without a comparison, so the "vs. …" is never cut and a
 * comparison that comes or goes moves nothing under it.
 */
const STRIP_CHIP_ROW =
  "min-[56.25rem]:@[14rem]:min-h-0 min-[56.25rem]:@max-[13.999rem]:min-h-[3.375rem] min-[56.25rem]:@max-[13.999rem]:items-start";

/**
 * The figure of a column of the strip: 24 px in all four, whatever size the card has below 900 px. An amount of 12
 * characters or more ("R$ 12.345,67") needs more than the 120 px a column has with the side menu open at 900 px, and a
 * cut figure is read as another number: such an amount steps down to 20 px (12 and 13 characters) or 18 px (14 or more)
 * in a column narrower than it needs, measured at 24 px as 10.4 px a character. The two sizes exclude each other, so the
 * order of the rules does not matter.
 */
function stripValueSize(characters: number): string {
  if (characters >= 14) {
    return "min-[56.25rem]:@[10.5rem]:text-[1.5rem] min-[56.25rem]:@max-[10.499rem]:text-[1.125rem]";
  }
  if (characters >= 12) {
    return "min-[56.25rem]:@[9rem]:text-[1.5rem] min-[56.25rem]:@max-[8.999rem]:text-[1.25rem]";
  }
  return "min-[56.25rem]:text-[1.5rem]";
}

/**
 * The group of the cards of one period: a line that says the period once ("Outubro · 1 a 23/10"), which is also the name
 * of the group, so the cards do not repeat it. The cards stay items of the grid of the row (`contents`): the line
 * takes the place `className` gives it.
 */
export function KpiGroup({
  children,
  className,
  period,
  title,
}: {
  children: ReactNode;
  className?: string;
  /** The period, "1 a 23/10". */
  period: string;
  /** The month, "Outubro", when the period is one. */
  title?: string | null;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset has a box of its own, and the cards must stay items of the grid
    <div
      aria-label={title ? `${title}, ${period}` : period}
      className="contents"
      role="group"
    >
      <p
        className={cn("text-muted-foreground text-support", className)}
        data-kpi-group=""
      >
        {title ? (
          <>
            <span className="font-medium text-foreground">{title}</span>
            {" · "}
          </>
        ) : null}
        <span className="tabular-nums">{period}</span>
      </p>
      {children}
    </div>
  );
}

/** The entity of a card: its color in the charts (theme.css, v7 § 5). */
export type KpiEntity = "result" | "sales" | "ticket";

const ENTITY_SQUARE: Record<KpiEntity, string> = {
  result: "bg-chart-result",
  sales: "bg-chart-sales",
  ticket: "bg-chart-ticket",
};

const SIGN = /^[+-]/;

/**
 * The box of the number: one line of a fixed height, so "R$ 129,90" (with the "R$" and the cents smaller), "R$ ••••"
 * (whose dots may come from another font) and "—" take the same height, and nothing under them moves when the values
 * are hidden or a day is read. Every card has the one size, `text-value-lg` (30 px line; 28 on a phone), with no card
 * above the others: the "R$" and the number are the same size, weight and line in all of them. The size is one of the
 * tokens of the scale; `leading-*` sets the line whatever the size class says, and goes after the size classes of its
 * own variant, because the merge of the classes drops a `leading-*` that comes before one.
 */
function heroBox(strip = false, stripCharacters = 0): string {
  return cn(
    "h-(--text-value-lg--line-height) whitespace-nowrap font-semibold text-value-lg tabular-nums tracking-[-0.035em]",
    strip && stripValueSize(stripCharacters),
    strip && "min-[56.25rem]:h-[1.05em] min-[56.25rem]:leading-5"
  );
}

export function HeroValue({
  amount,
  emptyText,
  strip = false,
}: {
  /** The amount as the server writes money ("1234.5"), or null when there is none. */
  amount: string | null;
  /** What a missing amount says in place of the dash, in the same one-line box ("sem custo neste dia"). */
  emptyText?: string | undefined;
  /** The value of a column of `KPI_STRIP`: 24 px from 900 px. */
  strip?: boolean;
}) {
  const [hidden] = useHiddenValues();
  const characters = amount === null ? 0 : formatBrlAmount(amount).length;
  const box = heroBox(strip, hidden ? 0 : characters);
  if (amount === null && emptyText) {
    return (
      <p className={cn(box, "text-muted-foreground")}>
        <span className="font-medium text-sm tracking-normal">{emptyText}</span>
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
    <AnimatedFigure text={written}>
      <Money split text={written} />
    </AnimatedFigure>
  );
  if (hidden) {
    return (
      <p className={box} data-kpi-value="">
        {money}
      </p>
    );
  }
  return (
    <p className={cn(box, negative && "text-destructive")} data-kpi-value="">
      {money}
    </p>
  );
}

/**
 * A percent in the box of the number (the Margem): the same size, weight and line as the amounts beside it, with the
 * "%" a step smaller, as the "R$" is. Never hidden: a percent does not tell what the store sells.
 */
export function HeroPercent({
  strip = false,
  text,
}: {
  strip?: boolean;
  /** The percent as the app writes it ("41,2%"), or null when there is none. */
  text: string | null;
}) {
  const box = heroBox(strip);
  if (text === null) {
    return (
      <p className={cn(box, "text-muted-foreground")}>
        <span aria-hidden="true">—</span>
        <span className="sr-only">sem valor</span>
      </p>
    );
  }
  return (
    <p
      className={cn(box, text.trim().startsWith("-") && "text-destructive")}
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
    <span aria-hidden="true" data-kpi-delta-text="">
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

/**
 * In a column of the strip narrower than 14 rem (from 900 px) the pill shrinks to the arrow and the number, and the
 * "vs. …" goes under it in the muted text, wrapping instead of being cut. The rules sit after the plain ones of the
 * pill, so they win; they are written whole because Tailwind reads only class names that are in the source.
 */
const STACKED_CHIP =
  "min-[56.25rem]:@max-[13.999rem]:h-auto min-[56.25rem]:@max-[13.999rem]:flex-col min-[56.25rem]:@max-[13.999rem]:items-start min-[56.25rem]:@max-[13.999rem]:gap-0.5 min-[56.25rem]:@max-[13.999rem]:bg-transparent min-[56.25rem]:@max-[13.999rem]:py-0";
const STACKED_PILL_UP =
  "min-[56.25rem]:@max-[13.999rem]:bg-[color-mix(in_oklab,var(--chart-sales)_12%,var(--card))]";
const STACKED_PILL =
  "min-[56.25rem]:@max-[13.999rem]:h-5 min-[56.25rem]:@max-[13.999rem]:rounded-full min-[56.25rem]:@max-[13.999rem]:py-0.5 min-[56.25rem]:@max-[13.999rem]:pr-1.75";
const STACKED_AGAINST =
  "min-[56.25rem]:@max-[13.999rem]:ml-0 min-[56.25rem]:@max-[13.999rem]:overflow-visible min-[56.25rem]:@max-[13.999rem]:whitespace-normal min-[56.25rem]:@max-[13.999rem]:pr-0 min-[56.25rem]:@max-[13.999rem]:text-muted-foreground min-[56.25rem]:@max-[13.999rem]:leading-4";

export function DeltaChip({
  delta,
  strip = false,
}: {
  delta: KpiDelta;
  /** The chip is in a column of `KPI_STRIP`: narrower than 14 rem, its "vs. …" goes under the pill. */
  strip?: boolean;
}) {
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
        up ? CHIP_UP : "bg-muted text-muted-foreground",
        strip && STACKED_CHIP
      )}
      data-kpi-delta={delta.trend}
    >
      <span
        className={cn(
          "inline-flex shrink-0 items-center gap-0.5 pl-1.25",
          delta.against ? "pr-0" : "pr-1.75",
          strip && STACKED_PILL,
          strip &&
            (up ? STACKED_PILL_UP : "min-[56.25rem]:@max-[13.999rem]:bg-muted")
        )}
        data-kpi-pill=""
      >
        {Icon ? <Icon aria-hidden="true" className="size-3 shrink-0" /> : null}
        {chipText(delta, name !== undefined, hidden)}
      </span>
      {delta.against ? (
        <span
          className={cn(
            "ml-1.5 min-w-0 truncate pr-1.75 font-normal",
            strip && STACKED_AGAINST
          )}
          data-kpi-delta-against=""
          title={strip ? delta.against : undefined}
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
   under it reads the pointer); the 3 px outline of the keyboard focus is drawn inside the strip, which the card clips */
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
const CHIP_ROW = "flex min-h-5 min-w-0 items-center";
/* an empty row under the chip: `STRIP_RESERVE` was measured with its 16 px, so the strip keeps it */
const NOTE_ROW = "min-h-4 text-muted-foreground text-xs leading-4";
const FOOTER_ROW = "min-h-4 text-muted-foreground text-xs leading-4";
const SPARK_SLOT = "-mx-(--card-spacing) mt-auto h-[3.25rem] md:h-16";
const CARD =
  "@container min-w-0 gap-1 overflow-hidden px-(--card-spacing) pb-0";

/** The date at the top right, over the width of the longest one the card may show (`reserve`), kept out of sight. */
function KpiDate({
  date,
  reserve,
}: {
  date?: string | undefined;
  reserve?: string | undefined;
}) {
  const shown = date ? (
    <span
      className="col-start-1 row-start-1 justify-self-end whitespace-nowrap"
      data-kpi-date=""
    >
      {date}
    </span>
  ) : null;
  if (!reserve) {
    return shown ? (
      <span className="grid shrink-0 text-xs tabular-nums">{shown}</span>
    ) : null;
  }
  return (
    <span className="grid shrink-0 text-xs tabular-nums">
      <span
        aria-hidden="true"
        className="invisible col-start-1 row-start-1 whitespace-nowrap"
      >
        {reserve}
      </span>
      {shown}
    </span>
  );
}

function CardTitle({
  entity,
  help,
  id,
  square,
  title,
}: {
  entity: KpiEntity;
  help: { about: string; text: string } | undefined;
  id: string;
  square: boolean;
  title: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1",
        !square && "touch:gap-2.5"
      )}
    >
      <h2
        className="flex min-w-0 items-center font-medium text-foreground"
        id={id}
      >
        {square ? (
          <span
            aria-hidden="true"
            className={cn(
              "mr-1.5 size-2 shrink-0 rounded-xs",
              ENTITY_SQUARE[entity]
            )}
          />
        ) : null}
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

export function KpiCard({
  chip,
  className,
  date,
  dateReserve,
  entity,
  footer,
  help,
  id,
  range,
  spark,
  strip = false,
  title,
  value,
}: {
  chip?: ReactNode;
  className?: string;
  /** The date of a card that has one of its own, at the top right; the others take it from their group. */
  date?: string;
  /**
   * The longest date the card may show (the one at rest, "outubro inteiro"): its width stays taken when the date is
   * another or none, so the title does not wrap and unwrap while a day is read.
   */
  dateReserve?: string;
  entity: KpiEntity;
  /** The line under the chip. `null` keeps its height empty, for a card whose foot comes and goes. */
  footer?: ReactNode;
  /** The (i) beside the title: what the number is and what it compares with (never a warning). */
  help?: { about: string; text: string };
  /** The id of the title, the name of the region. */
  id: string;
  range?: KpiRange;
  /** The sparkline, or nothing (then the card ends with its text). */
  spark?: ReactNode;
  /** The card is a column of `KPI_STRIP`: from 900 px it loses its own card and may put the chip beside the number. */
  strip?: boolean;
  title: ReactNode;
  value: ReactNode;
}) {
  return (
    <Card
      aria-labelledby={id}
      className={cn(
        CARD,
        !spark && "pb-(--card-spacing)",
        strip && KPI_STRIP_CELL,
        className
      )}
      data-kpi={entity}
      role="region"
    >
      <div
        className={cn(
          TOP_ROW,
          strip && "min-[56.25rem]:flex-wrap min-[56.25rem]:gap-y-0"
        )}
      >
        <CardTitle entity={entity} help={help} id={id} square title={title} />
        <KpiDate date={date} reserve={dateReserve} />
      </div>
      {/* a row that is always there, empty without a change: a chip that comes with a day read moves nothing under it */}
      <div
        className={cn("flex flex-col gap-1", strip && STRIP_HEADLINE)}
        data-kpi-headline=""
      >
        {value}
        <div
          className={cn(CHIP_ROW, strip && STRIP_CHIP_ROW)}
          data-kpi-chip-row=""
        >
          {chip}
        </div>
      </div>
      <div className={NOTE_ROW} data-kpi-note-row="" />
      {footer === undefined ? null : (
        <div className={FOOTER_ROW} data-kpi-foot="">
          {footer}
        </div>
      )}
      {spark ? (
        <SparkSlot className={SPARK_SLOT} range={range} spark={spark} />
      ) : null}
    </Card>
  );
}

/*
 * The tile of the Início: about 92 px, three lines (the name with the (i); the number with the sparkline of 36 px to its
 * right; the support line, as wide as the tile). With a day read, its date takes the place of the chip on the support line
 * (the row is always there, so nothing moves). The warning of an estimate that is not whole has its own row under it,
 * only in the tile that has one. The color of the entity is in the drawing, not in a square. With touch the title row and
 * the keyboard control of the sparkline are 44 px: the control starts under the touch area of the (i), so the two never
 * overlap (the tile grows by what it takes), and the title keeps its place.
 */
const TILE =
  "@container relative min-w-0 gap-0.5 overflow-hidden px-(--card-spacing) py-3 touch:pt-0";
/* takes what the number leaves (a long amount is never cut for it); its 36 px (44 with touch) do not add to the 30 px line of the number */
const TILE_SPARK =
  "z-10 -my-0.75 h-9 min-w-0 flex-1 self-center touch:-my-1.75 touch:h-11 touch:py-1";
const TILE_TITLE_ROW = "touch:min-h-11";
const TILE_BODY = "flex min-w-0 items-center gap-3 touch:mt-1.5";
const TILE_SUPPORT =
  "flex min-h-5 min-w-0 flex-wrap items-center gap-x-2 text-muted-foreground text-xs leading-4";

export function KpiTile({
  action,
  chip,
  className,
  date,
  entity,
  help,
  id,
  note,
  range,
  spark,
  title,
  value,
  warning,
}: {
  /** What the tile offers when it has no figure to show (a link to start): beside the support text. */
  action?: ReactNode;
  chip?: ReactNode;
  className?: string;
  /** The day read on the sparkline ("Até 17/10"), in the place of the chip; none at rest. */
  date?: string | undefined;
  entity: KpiEntity;
  help?: { about: string; text: string };
  id: string;
  /** What goes beside the chip: the count. */
  note?: ReactNode;
  range?: KpiRange;
  spark?: ReactNode;
  title: ReactNode;
  value: ReactNode;
  /** A warning that must stay in sight, on a row of its own under the support line. */
  warning?: ReactNode;
}) {
  return (
    <Card
      aria-labelledby={id}
      className={cn(TILE, className)}
      data-kpi={entity}
      role="region"
    >
      <div className={cn(TOP_ROW, TILE_TITLE_ROW)}>
        <CardTitle
          entity={entity}
          help={help}
          id={id}
          square={false}
          title={title}
        />
      </div>
      <div className={TILE_BODY} data-kpi-body="">
        <div className="shrink-0" data-kpi-headline="">
          {value}
        </div>
        {spark ? (
          <SparkSlot className={TILE_SPARK} range={range} spark={spark} />
        ) : null}
      </div>
      <div className={TILE_SUPPORT} data-kpi-note-row="">
        {date ? (
          <span
            className="whitespace-nowrap font-medium text-foreground tabular-nums"
            data-kpi-date=""
          >
            {date}
          </span>
        ) : null}
        {chip && !date ? <span data-kpi-chip-row="">{chip}</span> : null}
        {note}
        {action}
      </div>
      {warning ? (
        <div className={TILE_SUPPORT} data-kpi-warning="">
          {warning}
        </div>
      ) : null}
    </Card>
  );
}

/** A tile while its figures are read: the same rows with their heights, in `Skeleton`, so the tile that comes takes the same place (a Result tile with a cost warning adds its line). */
export function KpiTileSkeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "group/card flex flex-col overflow-hidden rounded-xl bg-card text-sm shadow-xs ring-1 ring-foreground/[0.06] [--card-spacing:--spacing(3)] dark:shadow-[inset_0_1px_0_var(--card-glow)] md:[--card-spacing:--spacing(4)]",
        TILE,
        className
      )}
      data-kpi-skeleton=""
    >
      <div className={cn(TOP_ROW, "h-5 touch:h-11")}>
        <Skeleton className="h-3 w-24" />
      </div>
      <div className={cn(heroBox(), "touch:mt-1.5 flex items-center")}>
        <Skeleton className="h-[0.8em] w-32" />
      </div>
      <div className={TILE_SUPPORT}>
        <Skeleton className="h-3 w-20" />
      </div>
    </div>
  );
}
