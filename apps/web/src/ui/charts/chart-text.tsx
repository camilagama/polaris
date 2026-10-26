/* Polaris adaptation of the Bklit UI area chart (the blocks are in src/ui/bklit/, unchanged but for BKLIT-UI.md), MIT */
import type { ChartColor, ChartPoint } from "./chart-data";

/** A second series in the box of the chart: a dashed line with no fill, on the scale of the main one. */
interface Secondary {
  color?: ChartColor | undefined;
  legend: string;
  name: string;
  /** What an unknown value is called ("sem custo informado") and the name of the hatch in the legend. */
  unknown?: { legend: string; text: string } | undefined;
}

/**
 * The value of the second series as text: the amount, or the words of an unknown value, never "R$ 0,00" (AC-9 of the
 * Resultado). The words go after a colon ("Custos: sem custo informado"), the amount after a space ("Custos R$ 90,00").
 */
function secondaryText(
  secondary: Secondary,
  value: number | null,
  formatValue: (value: number) => string
): { separator: string; text: string; unknown: boolean } {
  return value === null
    ? {
        separator: ":",
        text: secondary.unknown?.text ?? "sem valor",
        unknown: true,
      }
    : { separator: "", text: formatValue(value), unknown: false };
}

export interface DayReading {
  formatValue: (value: number) => string;
  name: string;
  note: string | null;
  point: ChartPoint | undefined;
  secondary: Secondary | undefined;
}

/**
 * The reading of the day in focus, a line of text above the drawing. With a second series it says both, and the note
 * of the caller after them ("05/10 · Vendas R$ 320,00 · Custos R$ 2.050,00 · inclui R$ 1.800,00 de despesas").
 * No aria-live: the keyboard control speaks the same day and value (`aria-valuetext`); a live line would say it twice.
 */
export function Reading({
  formatValue,
  name,
  note,
  point,
  secondary,
}: DayReading) {
  if (!point) {
    return null;
  }
  return (
    <p
      className="flex min-h-[1.125rem] flex-wrap items-baseline gap-x-2 text-muted-foreground text-support"
      data-chart-reading=""
    >
      <span>{point.label}</span>{" "}
      {secondary && point.rawSecondary !== undefined ? (
        <>
          <span>{`· ${name}`}</span>{" "}
          <span className="font-medium text-foreground tabular-nums">
            {formatValue(point.raw)}
          </span>{" "}
          <SecondaryReading
            formatValue={formatValue}
            secondary={secondary}
            value={point.rawSecondary}
          />
          {note ? (
            <>
              {" "}
              <span>{`· ${note}`}</span>
            </>
          ) : null}
        </>
      ) : (
        <span className="font-medium text-foreground tabular-nums">
          {formatValue(point.raw)}
        </span>
      )}
    </p>
  );
}

function SecondaryReading({
  formatValue,
  secondary,
  value,
}: {
  formatValue: (value: number) => string;
  secondary: Secondary;
  value: number | null;
}) {
  const reading = secondaryText(secondary, value, formatValue);
  return (
    <>
      <span>{`· ${secondary.name}${reading.separator}`}</span>{" "}
      <span
        className={
          reading.unknown
            ? "font-medium text-warning italic"
            : "font-medium text-foreground tabular-nums"
        }
        data-chart-unknown={reading.unknown ? "" : undefined}
      >
        {reading.text}
      </span>
    </>
  );
}

/** What the keyboard control says for the day in focus: the date and the value of each line. */
export function spokenValue({
  formatValue,
  name,
  note,
  point,
  secondary,
}: DayReading): string {
  if (!point) {
    return "";
  }
  if (!secondary || point.rawSecondary === undefined) {
    return `${point.label}: ${formatValue(point.raw)}`;
  }
  const second = secondaryText(secondary, point.rawSecondary, formatValue);
  const both = `${point.label}: ${name} ${formatValue(point.raw)}, ${secondary.name}${second.separator} ${second.text}`;
  return note ? `${both}, ${note}` : both;
}

/** A sample of a line in the legend: its color and, for the second series, its dash. */
function LegendKey({
  color,
  dash,
}: {
  color: string;
  dash: string | undefined;
}) {
  return (
    <svg aria-hidden="true" height={8} width={16}>
      <line
        stroke={color}
        strokeDasharray={dash}
        strokeLinecap="round"
        strokeWidth={2}
        x1={1}
        x2={15}
        y1={4}
        y2={4}
      />
    </svg>
  );
}

/** A sample of the hatch of an unknown day: the same lines at 45° as the plot. */
function HatchKey() {
  return (
    <svg aria-hidden="true" height={10} width={10}>
      <rect
        fill="var(--chart-unknown)"
        fillOpacity={0.08}
        height={10}
        width={10}
      />
      {[2, 6, 10, 14].map((offset) => (
        <line
          key={offset}
          stroke="var(--chart-unknown)"
          strokeWidth={1.6}
          x1={offset - 10}
          x2={offset}
          y1={10}
          y2={0}
        />
      ))}
    </svg>
  );
}

/**
 * The names of the two lines, each with its own trace: color is never the only sign. With an unknown day, the hatch
 * has its own name (`hatched`); with no known value at all (`secondaryDrawn` false) the line is not named, as it is
 * not drawn.
 */
export function Legend({
  color,
  dash,
  hatched = false,
  legend,
  secondary,
  secondaryColor,
  secondaryDrawn = true,
}: {
  color: string;
  dash: string;
  hatched?: boolean;
  legend: string;
  secondary: Secondary;
  secondaryColor: string;
  secondaryDrawn?: boolean;
}) {
  return (
    <ul
      className="flex flex-wrap gap-x-4 gap-y-1 justify-self-end text-muted-foreground text-xs"
      data-chart-legend=""
    >
      <li className="flex items-center gap-1.5">
        <LegendKey color={color} dash={undefined} />
        {legend}
      </li>
      {secondaryDrawn ? (
        <li className="flex items-center gap-1.5">
          <LegendKey color={secondaryColor} dash={dash} />
          {secondary.legend}
        </li>
      ) : null}
      {hatched && secondary.unknown ? (
        <li className="flex items-center gap-1.5" data-chart-legend-unknown="">
          <HatchKey />
          {secondary.unknown.legend}
        </li>
      ) : null}
    </ul>
  );
}

function Line({
  color,
  name,
  value,
}: {
  color: string | undefined;
  name: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-1.5" data-chart-tooltip-row="">
      {color ? (
        <span
          aria-hidden="true"
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: color }}
        />
      ) : null}
      <span className="text-chart-tooltip-muted">{name}</span>
      <span className="ml-auto pl-2 font-medium text-chart-tooltip-foreground tabular-nums">
        {value}
      </span>
    </div>
  );
}

/**
 * What the floating panel of the tooltip says besides its date pill: one line for each series ("Vendas R$ 1.840,00"),
 * in 12 px and no title, so it is as narrow as a phone's chart allows (the pill carries the date).
 */
export function TooltipLines({
  color,
  formatValue,
  name,
  note,
  point,
  secondary,
  secondaryColor,
}: {
  color: string;
  formatValue: (value: number) => string;
  name: string;
  note: string | null;
  point: ChartPoint | undefined;
  secondary: Secondary | undefined;
  secondaryColor: string;
}) {
  if (!point) {
    return null;
  }
  return (
    <div className="grid gap-1 px-2.5 py-2 text-xs">
      <Line
        color={secondary ? color : undefined}
        name={name}
        value={formatValue(point.raw)}
      />
      {secondary && point.rawSecondary !== undefined ? (
        <Line
          color={secondaryColor}
          name={secondary.name}
          value={secondaryText(secondary, point.rawSecondary, formatValue).text}
        />
      ) : null}
      {note ? <p className="text-chart-tooltip-muted">{note}</p> : null}
    </div>
  );
}
