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
 * The KPI tile, with our text, the one of the Início and of the Resultado: the name with the (i), the number, one line
 * of support (the chip of the change, which says in its name what it compares against, and a count or a warning) and, to
 * the right of the number, a sparkline of 36 px that the pointer, the finger and the arrows read. It is a region named by
 * its title; the number is text, the drawing is a reinforcement.
 */

/**
 * The grid of the tiles of the Início: one column up to 759 px (the `md` of Tailwind, where the side menu appears), two
 * from there, four from 1280 px, where each tile still has room for the number and the sparkline side by side.
 */
export const KPI_GRID =
  "grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4 xl:gap-4";

/**
 * The row of the Resultado: the tiles of `KPI_GRID` up to 1279 px (one column, two from 760 px) and, from 1280 px, one
 * card with four columns and a 1 px line between them, as wide as the row of the Início. The cells give up their own
 * ring, background and rounding (`KPI_STRIP_CELL`); the strip clips the tiles to its corners. Below 1280 px a column
 * has no room for the number and the sparkline side by side.
 */
export const KPI_STRIP =
  "grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4 xl:gap-0 xl:divide-x xl:divide-border xl:overflow-hidden xl:rounded-xl xl:bg-card xl:shadow-xs xl:ring-1 xl:ring-foreground/[0.06] xl:dark:shadow-[inset_0_1px_0_var(--card-glow)]";

const KPI_STRIP_CELL =
  "xl:rounded-none xl:bg-transparent xl:shadow-none! xl:ring-0";

/** The entity of a card: its color in the charts (theme.css, v7 § 5). */
export type KpiEntity = "result" | "sales" | "ticket";

const SIGN = /^[+-]/;

/**
 * The box of the number: one line of a fixed height, so "R$ 129,90" (with the "R$" and the cents smaller), "R$ ••••"
 * (whose dots may come from another font) and "—" take the same height, and nothing under them moves when the values
 * are hidden or a day is read. Every card has the one size, `text-value-lg` (30 px line; 28 on a phone), with no card
 * above the others: the "R$" and the number are the same size, weight and line in all of them. The size is one of the
 * tokens of the scale; `leading-*` sets the line whatever the size class says, and goes after the size classes of its
 * own variant, because the merge of the classes drops a `leading-*` that comes before one.
 */
const HERO_BOX =
  "h-(--text-value-lg--line-height) whitespace-nowrap font-semibold text-value-lg tabular-nums tracking-[-0.035em]";

export function HeroValue({
  amount,
  emptyText,
}: {
  /** The amount as the server writes money ("1234.5"), or null when there is none. */
  amount: string | null;
  /** What a missing amount says in place of the dash, in the same one-line box ("sem custo neste dia"). */
  emptyText?: string | undefined;
}) {
  const [hidden] = useHiddenValues();
  const box = HERO_BOX;
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
  text,
}: {
  /** The percent as the app writes it ("41,2%"), or null when there is none. */
  text: string | null;
}) {
  const box = HERO_BOX;
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
  title,
}: {
  help: { about: string; text: string } | undefined;
  id: string;
  title: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1 touch:gap-2.5">
      <h2
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
  strip = false,
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
  /** The tile is a column of `KPI_STRIP`: from 1280 px it gives up its own card. */
  strip?: boolean;
  title: ReactNode;
  value: ReactNode;
  /** A warning that must stay in sight, on a row of its own under the support line. */
  warning?: ReactNode;
}) {
  return (
    <Card
      aria-labelledby={id}
      className={cn(TILE, strip && KPI_STRIP_CELL, className)}
      data-kpi={entity}
      role="region"
    >
      <div className={cn(TOP_ROW, TILE_TITLE_ROW)}>
        <CardTitle help={help} id={id} title={title} />
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
      <div className={cn(HERO_BOX, "touch:mt-1.5 flex min-h-7.5 items-center")}>
        <Skeleton className="h-[0.8em] w-32" />
      </div>
      <div className={TILE_SUPPORT}>
        <Skeleton className="h-3 w-20" />
      </div>
    </div>
  );
}
