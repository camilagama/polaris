import ArrowDownIcon from "lucide-react/dist/esm/icons/arrow-down";
import ArrowUpIcon from "lucide-react/dist/esm/icons/arrow-up";
import { type ChangeEvent, type ReactNode, useCallback } from "react";
import { formatBrlAmount } from "@/lib/format";
import { useHiddenValues } from "@/lib/hidden-values";
import { cn } from "@/lib/utils";
import { Card } from "./card";
import { MaskedMoney, MoneyText } from "./hidden-values";

/**
 * The KPI card of the recipe "KPI sparklines" of Bklit UI, with our text (revisão de UI v7, § 3): the name with the
 * square of its entity's color and the date at the top, the number as a display, the chip of the change with what it
 * compares against, a line of support and, at the bottom, edge to edge, the sparkline that the pointer, the finger and
 * the arrows read. The card is a region named by its title; the number is text, the drawing is a reinforcement.
 */

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
 * An amount as a display: the whole number in the color of the text, weight 650, with the "R$" at 56 % and the cents a
 * step smaller (v7 § 1); a loss in red, with its sign. Hidden, "R$ ••••" (heard "valor escondido"); none, a dash.
 */
export function HeroValue({
  amount,
  size = "lg",
}: {
  /** The amount as the server writes money ("1234.5"), or null when there is none. */
  amount: string | null;
  size?: "lg" | "md";
}) {
  const [hidden] = useHiddenValues();
  const box = cn(
    "whitespace-nowrap font-[650] tabular-nums leading-[1.05] tracking-[-0.035em]",
    size === "lg" ? "text-[1.75rem] md:text-[1.875rem]" : "text-[1.3125rem]"
  );
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
  let Icon: typeof ArrowUpIcon | null = null;
  if (delta.trend === "up") {
    Icon = ArrowUpIcon;
  } else if (delta.trend === "down") {
    Icon = ArrowDownIcon;
  }
  return (
    <span
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
  compact,
  range,
  spark,
}: {
  compact: boolean;
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
    <div
      className={cn(
        "relative -mx-(--card-spacing) mt-auto touch-pan-y",
        compact ? "h-12 md:h-16" : "h-[3.25rem] md:h-16"
      )}
      data-kpi-spark=""
    >
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

export function KpiCard({
  action,
  chip,
  className,
  compact = false,
  date,
  entity,
  footer,
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
  /** Half the width on a phone: a shorter sparkline (48 px tall; the box is the touch area of its control, with no `touch-hit`). */
  compact?: boolean;
  date: string;
  entity: KpiEntity;
  footer?: ReactNode;
  /** The id of the title, the name of the region. */
  id: string;
  /** What the chip compares against, or why there is no chip. */
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
      className={cn(
        "min-w-0 gap-1 overflow-hidden px-(--card-spacing) pb-0",
        !spark && "pb-(--card-spacing)",
        className
      )}
      data-kpi={entity}
      role="region"
    >
      {/* the date goes under the name when both do not fit (a card of half the width on a phone) */}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-[0.8125rem] text-muted-foreground leading-[1.125rem]">
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
        <span
          className="shrink-0 whitespace-nowrap text-xs tabular-nums"
          data-kpi-date=""
        >
          {date}
        </span>
      </div>
      {value}
      {chip || note ? (
        <div className="flex min-h-[1.375rem] flex-wrap items-center gap-x-2 gap-y-1">
          {chip}
          {note ? (
            <span className="text-muted-foreground text-xs leading-4">
              {note}
            </span>
          ) : null}
        </div>
      ) : null}
      {footer ? (
        <div className="text-muted-foreground text-xs leading-4">{footer}</div>
      ) : null}
      {action}
      {spark ? (
        <SparkSlot compact={compact} range={range} spark={spark} />
      ) : null}
    </Card>
  );
}
