import ArrowDownIcon from "lucide-react/dist/esm/icons/arrow-down";
import ArrowUpIcon from "lucide-react/dist/esm/icons/arrow-up";
import { type ChangeEvent, type ReactNode, useCallback } from "react";
import { formatBrlAmount } from "@/lib/format";
import { MASKED_SPOKEN, maskMoney, useHiddenValues } from "@/lib/hidden-values";
import { cn } from "@/lib/utils";
import { Card } from "./card";
import { HelpTip } from "./help-tip";
import { MaskedMoney, MoneyText } from "./hidden-values";
import { Skeleton } from "./skeleton";

/**
 * The KPI card of the recipe "KPI sparklines" of Bklit UI, with our text (revisão de UI v7, § 3): the name with the
 * square of its entity's color and, beside it, the (i) with the help, the date at the top right when the card has one of
 * its own, the number as a display, one line of support (the chip of the change, which says in its name what it
 * compares against, and a count or a warning) and, at the bottom, edge to edge, the sparkline that the pointer, the
 * finger and the arrows read. The card is a region named by its title; the number is text, the drawing is a
 * reinforcement.
 */

/**
 * The grid of the KPI cards: one column up to 759 px (the `md` of Tailwind, where the side menu appears), two from
 * there, four from 1024 px.
 */
export const KPI_GRID =
  "grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4 lg:gap-4";

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
        className={cn(
          "text-[0.8125rem] text-muted-foreground leading-[1.125rem]",
          className
        )}
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

const SPLIT = /^(-?)R\$\s?(.*?)(,\d{2})?$/;

/**
 * The box of the number: one line of a fixed height, so "R$ 129,90" (with the "R$" and the cents smaller, which push
 * the line down), "R$ ••••" (whose dots may come from another font) and "—" take the same height, and nothing under
 * them moves when the values are hidden or a day is read. The line height is the card's (`text-sm`, 20 px), the one
 * the number has been drawn with (a `leading` put before the size class was dropped by the merge of the classes); the
 * size class comes first so the merge keeps both.
 */
function heroBox(size: "lg" | "md"): string {
  return cn(
    "whitespace-nowrap font-[650] tabular-nums tracking-[-0.035em]",
    size === "lg" ? "text-[1.75rem] md:text-[1.875rem]" : "text-[1.3125rem]",
    "h-[1.05em] leading-5"
  );
}

export function HeroValue({
  amount,
  size = "lg",
}: {
  /** The amount as the server writes money ("1234.5"), or null when there is none. */
  amount: string | null;
  size?: "lg" | "md";
}) {
  const [hidden] = useHiddenValues();
  const box = heroBox(size);
  const currency = "font-medium text-[0.56em] tracking-normal";
  if (amount === null) {
    return (
      <p className={cn(box, "text-muted-foreground")}>
        <span aria-hidden="true">—</span>
        <span className="sr-only">sem valor</span>
      </p>
    );
  }
  const negative = amount.trim().startsWith("-");
  if (hidden) {
    return (
      <p className={box} data-kpi-value="">
        <MaskedMoney />
      </p>
    );
  }
  const match = SPLIT.exec(formatBrlAmount(amount));
  return (
    <p className={cn(box, negative && "text-destructive")} data-kpi-value="">
      {match?.[1] ?? ""}
      {/* the space is inside the small part: "R$ 90,00" is one text for a screen reader and a search */}
      <span className={currency}>R$ </span>
      {match?.[2] ?? amount}
      <span className="text-[0.72em]">{match?.[3] ?? ""}</span>
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
  /** What a screen reader says in place of `text`, when the text does not read well. */
  spoken?: string;
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

/** A text seen one way and heard another ("16,0×", heard "16,0 vezes"). */
function ChipText({ spoken, text }: { spoken: string; text: string }) {
  return (
    <span>
      <span aria-hidden="true" data-kpi-delta-text="">
        {text}
      </span>
      <span className="sr-only">{spoken}</span>
    </span>
  );
}

function chipText(delta: KpiDelta): ReactNode {
  if (delta.money) {
    return <MoneyChipText text={delta.text} />;
  }
  return delta.spoken ? (
    <ChipText spoken={delta.spoken} text={delta.text} />
  ) : (
    delta.text
  );
}

export function DeltaChip({ delta }: { delta: KpiDelta }) {
  const [hidden] = useHiddenValues();
  let Icon: typeof ArrowUpIcon | null = null;
  if (delta.trend === "up") {
    Icon = ArrowUpIcon;
  } else if (delta.trend === "down") {
    Icon = ArrowDownIcon;
  }
  // the name says the change and what it is against ("+1.465,1% em relação a 1 a 23/09"), and hides the amount of a result
  let name: string | undefined;
  if (delta.basis) {
    name = `${delta.spoken ?? delta.text} ${delta.basis}`;
    if (hidden && delta.money) {
      name = maskMoney(name, MASKED_SPOKEN);
    }
  }
  const named = name ? ({ "aria-label": name, role: "img" } as const) : {};
  return (
    <span
      {...named}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-0.5 whitespace-nowrap rounded-full py-0.5 pr-[7px] pl-[5px] font-semibold text-xs tabular-nums leading-4",
        delta.trend === "up"
          ? "bg-[color-mix(in_oklab,var(--chart-sales)_12%,var(--card))] text-mark-foreground"
          : "bg-muted text-muted-foreground"
      )}
      data-kpi-delta={delta.trend}
    >
      {Icon ? (
        <Icon aria-hidden="true" className="size-3" strokeWidth={2.5} />
      ) : null}
      {chipText(delta)}
      {delta.against ? (
        <span className="ml-1 font-normal" data-kpi-delta-against="">
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
  range,
  spark,
}: {
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
    <div className={cn("relative touch-pan-y", SPARK_SLOT)} data-kpi-spark="">
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
  "flex min-h-[1.125rem] min-w-0 items-center justify-between gap-x-2 text-[0.8125rem] text-muted-foreground leading-[1.125rem]";
const SUPPORT_ROW =
  "flex min-h-[1.375rem] flex-wrap items-center gap-x-2 gap-y-1";
const FOOTER_ROW = "min-h-4 text-muted-foreground text-xs leading-4";
const SPARK_SLOT = "-mx-(--card-spacing) mt-auto h-[3.25rem] md:h-16";
const CARD = "min-w-0 gap-1 overflow-hidden px-(--card-spacing) pb-0";

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

export function KpiCard({
  action,
  chip,
  className,
  date,
  dateReserve,
  entity,
  footer,
  help,
  id,
  note,
  range,
  spark,
  title,
  value,
}: {
  /** A link under the support line ("Ver o resultado"). */
  action?: ReactNode;
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
  /** The line under the support line. `null` keeps its height empty, for a card whose foot comes and goes. */
  footer?: ReactNode;
  /** The (i) beside the title: what the number is and what it compares with (never a warning). */
  help?: { about: string; text: string };
  /** The id of the title, the name of the region. */
  id: string;
  /** The rest of the support line, beside the chip: a count, or the warning. */
  note?: ReactNode;
  range?: KpiRange;
  /** The sparkline, or nothing (then the card ends with its text). */
  spark?: ReactNode;
  title: ReactNode;
  value: ReactNode;
}) {
  return (
    <Card
      aria-labelledby={id}
      className={cn(CARD, !spark && "pb-(--card-spacing)", className)}
      data-kpi={entity}
      role="region"
    >
      <div className={TOP_ROW}>
        <div className="flex min-w-0 items-center gap-1">
          <h2
            className="flex min-w-0 items-center font-medium text-foreground"
            id={id}
          >
            <span
              aria-hidden="true"
              className={cn(
                "mr-1.5 size-2 shrink-0 rounded-xs",
                ENTITY_SQUARE[entity]
              )}
            />
            <span className="min-w-0">{title}</span>
          </h2>
          {help ? (
            <HelpTip about={help.about} className="-my-[3px]">
              {help.text}
            </HelpTip>
          ) : null}
        </div>
        <KpiDate date={date} reserve={dateReserve} />
      </div>
      {value}
      {/* always there, empty without a change or a note: a chip that comes with a day read moves nothing */}
      <div className={SUPPORT_ROW}>
        {chip}
        {note ? (
          <span className="text-muted-foreground text-xs leading-4">
            {note}
          </span>
        ) : null}
      </div>
      {footer === undefined ? null : <div className={FOOTER_ROW}>{footer}</div>}
      {action}
      {spark ? <SparkSlot range={range} spark={spark} /> : null}
    </Card>
  );
}

/**
 * A KPI card while its figures are read: the rows of `KpiCard` with their heights (the top line, the number, the support
 * line, the foot and the action when the card has them, the sparkline), drawn in `Skeleton`, so the card that comes
 * takes the same place. Drawing only: the status is said by whom shows it.
 */
export function KpiCardSkeleton({
  action = false,
  className,
  footer = 0,
  size = "lg",
  spark = true,
}: {
  /** The card has a link under the support line ("Ver o resultado"). */
  action?: boolean;
  className?: string;
  /** Lines of the foot ("Não é lucro líquido nem caixa"); 0 for none. */
  footer?: number;
  size?: "lg" | "md";
  spark?: boolean;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "group/card flex flex-col overflow-hidden rounded-xl bg-card py-(--card-spacing) shadow-xs ring-1 ring-foreground/[0.06] [--card-spacing:--spacing(3)] dark:shadow-[inset_0_1px_0_var(--card-glow)] md:[--card-spacing:--spacing(4)]",
        CARD,
        !spark && "pb-(--card-spacing)",
        className
      )}
      data-kpi-skeleton=""
    >
      <div className={TOP_ROW}>
        <Skeleton className="h-3 w-24" />
      </div>
      <div className={cn(heroBox(size), "flex items-center")}>
        <Skeleton className="h-[0.8em] w-32" />
      </div>
      <div className={SUPPORT_ROW}>
        <Skeleton className="h-3 w-28" />
      </div>
      {Array.from({ length: footer }, (_, index) => (
        <div className={cn(FOOTER_ROW, "flex items-center")} key={index}>
          <Skeleton className="h-3 w-full" />
        </div>
      ))}
      {action ? (
        <div className="flex h-4 items-center">
          <Skeleton className="h-3 w-24" />
        </div>
      ) : null}
      {spark ? <div className={SPARK_SLOT} /> : null}
    </div>
  );
}
