import ArrowDownIcon from "lucide-react/dist/esm/icons/arrow-down";
import ArrowUpIcon from "lucide-react/dist/esm/icons/arrow-up";
import { type ChangeEvent, type ReactNode, useCallback } from "react";
import { formatBrlAmount } from "@/lib/format";
import { MASKED_SPOKEN, maskMoney, useHiddenValues } from "@/lib/hidden-values";
import { cn } from "@/lib/utils";
import { Card } from "./card";
import { HelpTip } from "./help-tip";
import { MaskedMoney, MoneyText } from "./hidden-values";

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
    <div
      className="relative -mx-(--card-spacing) mt-auto h-[3.25rem] touch-pan-y md:h-16"
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
  date,
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
  entity: KpiEntity;
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
      className={cn(
        "min-w-0 gap-1 overflow-hidden px-(--card-spacing) pb-0",
        !spark && "pb-(--card-spacing)",
        className
      )}
      data-kpi={entity}
      role="region"
    >
      <div className="flex min-h-[1.125rem] min-w-0 items-center justify-between gap-x-2 text-[0.8125rem] text-muted-foreground leading-[1.125rem]">
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
        {date ? (
          <span
            className="shrink-0 whitespace-nowrap text-xs tabular-nums"
            data-kpi-date=""
          >
            {date}
          </span>
        ) : null}
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
      {spark ? <SparkSlot range={range} spark={spark} /> : null}
    </Card>
  );
}
