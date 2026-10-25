/* adapted from Bklit UI (bklit/bklit-ui@3e9af3b), MIT */
import {
  type ChangeEvent,
  type PointerEvent,
  useCallback,
  useId,
  useMemo,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import {
  type ChartColor,
  type ChartDatum,
  type ChartLayout,
  type ChartMargin,
  chartLayout,
  estimateLabelWidth,
  nearestIndex,
  seriesMax,
} from "./chart-geometry";
import { useElementWidth } from "./use-element-width";

const AXIS_FONT_SIZE = 11;
const MAX_GRID_LINES = 4;
/* The keyboard control is a native range input laid over the drawing: transparent, with no track and no thumb (the
   drawing shows the point in focus) and deaf to the pointer (the box under it moves the focus), so that its box is the
   box of the chart, which is what a touch finds, and the 3 px outline of the keyboard focus goes round the chart. */
const RANGE_CLASS =
  "focus-ring pointer-events-none absolute inset-0 m-0 size-full appearance-none rounded-md bg-transparent [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-transparent [&::-moz-range-track]:bg-transparent [&::-webkit-slider-runnable-track]:bg-transparent [&::-webkit-slider-thumb]:appearance-none";
const BASE_MARGIN: ChartMargin = { bottom: 24, left: 8, right: 8, top: 8 };
/* the dash of the second series: the legend and the line draw the same one */
const DASH = "5 4";

/** A second series in the box of the chart: a dashed line with no fill, on the scale of the main one. */
interface AreaChartSecondary {
  /** The color of the line: a token of the chart palette. `--chart-3` (the mid grey) when absent. */
  color?: ChartColor;
  /** One datum per datum of the main series, in the same order (the labels are the main series'). */
  data: readonly ChartDatum[];
  /** The name in the legend ("Custos (CMV, taxas e despesas)"). */
  legend: string;
  /** The short name in the reading of the day ("Custos"). */
  name: string;
}

export interface AreaChartProps {
  /** The unit of the y axis ("R$"), written once, before the label of the top line ("R$ 2 mil"); none when absent. */
  axisUnit?: string;
  className?: string;
  /** The color of the series: a token of the chart palette. The ink (`--chart-5`) when absent. */
  color?: ChartColor;
  data: readonly ChartDatum[];
  /** The text of a value on the y axis ("1 mil"); `formatValue` when absent. */
  formatAxis?: (value: number) => string;
  /** The text of a value in the reading of the day in focus and in the spoken value of the keyboard control. */
  formatValue: (value: number) => string;
  /** The height of the drawing in pixels: 180 for seven days, 220 for thirty or two series. */
  height?: number;
  /** What the chart answers, with the figures that matter: it is the name of the image for a screen reader. */
  label: string;
  /** The name of the main series in the legend, with `secondary`. */
  legend?: string;
  /** The short name of the main series in the reading of the day, with `secondary` ("Vendas"). */
  name?: string;
  /** The name of the keyboard control that walks through the points. */
  rangeLabel?: string;
  /** What the reading of a day adds after its values ("inclui R$ 1.800,00 de despesas"), or null. */
  readingNote?: (index: number) => string | null;
  /** A second series, dashed, with a legend (Resultado: the costs against the sales). */
  secondary?: AreaChartSecondary;
  /** A fixed width in pixels, for a test or a static page; measured from the box when absent. */
  width?: number;
}

interface DayReading {
  formatValue: (value: number) => string;
  name: string;
  note: string | null;
  point: ChartLayout["points"][number];
  secondary: AreaChartSecondary | undefined;
  secondaryPoint: ChartLayout["points"][number] | undefined;
}

/**
 * The reading of the day in focus, a line of text above the drawing. With a second series it says both, and the note
 * of the caller after them ("05/10 · Vendas R$ 320,00 · Custos R$ 2.050,00 · inclui R$ 1.800,00 de despesas").
 * No aria-live: the keyboard control speaks the same day and value (`aria-valuetext`); a live line would say it twice.
 */
function Reading({
  formatValue,
  name,
  note,
  point,
  secondary,
  secondaryPoint,
}: DayReading) {
  return (
    <p
      className="flex min-h-[1.125rem] flex-wrap items-baseline gap-x-2 text-muted-foreground text-support"
      data-chart-reading=""
    >
      <span>{point.label}</span>{" "}
      {secondary && secondaryPoint ? (
        <>
          <span>{`· ${name}`}</span>{" "}
          <span className="font-medium text-foreground tabular-nums">
            {formatValue(point.value)}
          </span>{" "}
          <span>{`· ${secondary.name}`}</span>{" "}
          <span className="font-medium text-foreground tabular-nums">
            {formatValue(secondaryPoint.value)}
          </span>
          {note ? (
            <>
              {" "}
              <span>{`· ${note}`}</span>
            </>
          ) : null}
        </>
      ) : (
        <span className="font-medium text-foreground tabular-nums">
          {formatValue(point.value)}
        </span>
      )}
    </p>
  );
}

/** What the keyboard control says for the day in focus: the date and the value of each line. */
function spokenValue({
  formatValue,
  name,
  note,
  point,
  secondary,
  secondaryPoint,
}: DayReading): string {
  if (!(secondary && secondaryPoint)) {
    return `${point.label}: ${formatValue(point.value)}`;
  }
  const both = `${point.label}: ${name} ${formatValue(point.value)}, ${secondary.name} ${formatValue(secondaryPoint.value)}`;
  return note ? `${both}, ${note}` : both;
}

/** A sample of a line in the legend: its color and, for the second series, its dash. */
function LegendKey({ color, dashed }: { color: string; dashed?: boolean }) {
  return (
    <svg aria-hidden="true" height={8} width={16}>
      <line
        stroke={color}
        strokeDasharray={dashed ? DASH : undefined}
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

/** The names of the two lines, each with its own trace: color is never the only sign. */
function Legend({
  color,
  legend,
  secondary,
  secondaryColor,
}: {
  color: string;
  legend: string;
  secondary: AreaChartSecondary;
  secondaryColor: string;
}) {
  return (
    <ul
      className="flex flex-wrap gap-x-4 gap-y-1 justify-self-end text-muted-foreground text-xs"
      data-chart-legend=""
    >
      <li className="flex items-center gap-1.5">
        <LegendKey color={color} />
        {legend}
      </li>
      <li className="flex items-center gap-1.5">
        <LegendKey color={secondaryColor} dashed />
        {secondary.legend}
      </li>
    </ul>
  );
}

/** The dashed line of the second series; nothing with fewer than two points. */
function SecondaryLine({
  color,
  d,
}: {
  color: string;
  d: string | null | undefined;
}) {
  return d ? (
    <path
      d={d}
      fill="none"
      stroke={color}
      strokeDasharray={DASH}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
    />
  ) : null;
}

/** The ring of the second series on the day in focus. */
function SecondaryRing({
  color,
  point,
}: {
  color: string;
  point: ChartLayout["points"][number] | undefined;
}) {
  return point ? (
    <circle
      className="fill-card"
      cx={point.x}
      cy={point.y}
      r={4.5}
      stroke={color}
      strokeWidth={2}
    />
  ) : null;
}

/** The dates of the x axis: the first starts at the left edge and the last ends at the right one, the others are centered. */
function DateLabels({ layout }: { layout: ChartLayout }) {
  const last = layout.points.length - 1;
  return layout.labelIndexes.map((index) => {
    const item = layout.points[index];
    if (!item) {
      return null;
    }
    let anchor: "end" | "middle" | "start" = "middle";
    if (index === 0 && last > 0) {
      anchor = "start";
    } else if (index === last && last > 0) {
      anchor = "end";
    }
    return (
      <text
        className="fill-muted-foreground text-xs"
        key={item.label + String(index)}
        textAnchor={anchor}
        x={item.x}
        y={layout.floor + 16}
      >
        {item.label}
      </text>
    );
  });
}

interface DrawingProps {
  axisText: (value: number, isTop: boolean) => string;
  best: ChartLayout["points"][number] | undefined;
  color: string;
  count: number;
  gradient: string;
  height: number;
  label: string;
  layout: ChartLayout;
  margin: ChartMargin;
  point: ChartLayout["points"][number] | undefined;
  secondaryColor: string;
  secondaryLayout: ChartLayout | null;
  secondaryPoint: ChartLayout["points"][number] | undefined;
  width: number;
}

/** The image: the grid and its labels, the dates, the area and the line of each series, the best day and the day in focus. */
function Drawing({
  axisText,
  best,
  color,
  count,
  gradient,
  height,
  label,
  layout,
  margin,
  point,
  secondaryColor,
  secondaryLayout,
  secondaryPoint,
  width,
}: DrawingProps) {
  return (
    <svg
      aria-label={label}
      className="block animate-rise select-none"
      height={height}
      role="img"
      width={width}
    >
      <defs>
        <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity={0.28} />
          <stop offset="1" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path
        className="stroke-border"
        d={layout.grid}
        fill="none"
        strokeWidth={1}
      />
      {layout.ticks.map((tick, index) => (
        <text
          className="fill-muted-foreground text-[11px]"
          dominantBaseline="central"
          key={tick.value}
          textAnchor="end"
          x={margin.left - 6}
          y={tick.y}
        >
          {axisText(tick.value, index === layout.ticks.length - 1)}
        </text>
      ))}
      <DateLabels layout={layout} />
      {layout.area ? <path d={layout.area} fill={`url(#${gradient})`} /> : null}
      {layout.line ? (
        <path
          d={layout.line}
          fill="none"
          stroke={color}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
        />
      ) : null}
      <SecondaryLine color={secondaryColor} d={secondaryLayout?.line} />
      {best ? (
        <circle
          className="stroke-card"
          cx={best.x}
          cy={best.y}
          fill="var(--chart-1)"
          r={4}
          strokeWidth={2}
        />
      ) : null}
      {point ? (
        <>
          {count > 1 ? (
            <line
              className="stroke-foreground/35"
              strokeWidth={1}
              x1={point.x}
              x2={point.x}
              y1={margin.top}
              y2={layout.floor}
            />
          ) : null}
          <SecondaryRing color={secondaryColor} point={secondaryPoint} />
          <circle
            className="fill-card"
            cx={point.x}
            cy={point.y}
            r={4.5}
            stroke={color}
            strokeWidth={2}
          />
        </>
      ) : null}
    </svg>
  );
}

interface LayoutInput {
  axisText: (value: number, isTop: boolean) => string;
  data: readonly ChartDatum[];
  height: number;
  secondaryData: readonly ChartDatum[] | undefined;
  width: number;
}

/**
 * The layout of the series in the box. The labels of the y axis decide the left margin, so the layout is made twice:
 * once for the lines, once to fit them. With a second series each one takes the other's maximum as its ceiling, so that
 * both have the same scale.
 */
function useChartLayouts({
  axisText,
  data,
  height,
  secondaryData,
  width,
}: LayoutInput) {
  return useMemo(() => {
    const options = { height, maxLines: MAX_GRID_LINES, width };
    const ownCeiling = secondaryData ? seriesMax(secondaryData) : 0;
    const labelWidth = estimateLabelWidth(
      chartLayout(data, {
        ...options,
        ceiling: ownCeiling,
        margin: BASE_MARGIN,
      }).ticks.map((tick, index, ticks) =>
        axisText(tick.value, index === ticks.length - 1)
      ),
      AXIS_FONT_SIZE
    );
    const fitted = {
      ...BASE_MARGIN,
      left: labelWidth > 0 ? labelWidth + 14 : BASE_MARGIN.left,
    };
    return {
      layout: chartLayout(data, {
        ...options,
        ceiling: ownCeiling,
        margin: fitted,
      }),
      margin: fitted,
      secondaryLayout: secondaryData
        ? chartLayout(secondaryData, {
            ...options,
            ceiling: seriesMax(data),
            margin: fitted,
          })
        : null,
    };
  }, [axisText, data, height, secondaryData, width]);
}

/**
 * The area chart of one series (Bklit UI adapted to the tokens of the app): a 2 px line, a fill that fades to
 * nothing, horizontal grid only, two to four labeled lines above the floor (the count that fits the series best) and
 * the dates of the x axis. The day in focus
 * (the last one, until a touch, the mouse or the arrows move it) is read in a line of text above the drawing, never
 * in a floating box that would cover the axis at 360 px.
 *
 * The drawing is an image for a screen reader (`role="img"` with the summary in `aria-label`); the way to walk
 * through the points without a pointer is a native range input laid over the drawing, transparent, that speaks the
 * date and the value (`aria-valuetext`) and draws the 3 px focus outline around the chart. The chart is a reinforcement and never the only source of a number: the caller writes the
 * total and the best day beside it, and "Ver os números" shows the table. Movement is a fade-in of the opacity
 * only (`animate-rise`), which `prefers-reduced-motion` zeroes with the rest of the page.
 *
 * With `secondary` the chart draws a second, dashed line on the same scale (the costs against the sales of the
 * Resultado): the legend names both lines and the reading of the day says both values, never in a floating box.
 */
export function AreaChart({
  axisUnit,
  className,
  color = "var(--chart-5)",
  data,
  formatAxis,
  formatValue,
  height = 180,
  label,
  legend,
  name = "",
  rangeLabel = "Dia",
  readingNote,
  secondary,
  width: fixedWidth,
}: AreaChartProps) {
  const [measure, measuredWidth] = useElementWidth<HTMLDivElement>();
  const width = fixedWidth ?? measuredWidth;
  const gradient = `chart-fill-${useId().replaceAll(":", "")}`;
  const secondaryData = secondary?.data;
  const secondaryColor = secondary?.color ?? "var(--chart-3)";
  const signature = `${data.map((datum) => `${datum.label}:${datum.value}`).join()}|${(secondaryData ?? []).map((datum) => datum.value).join()}`;
  const [picked, setPicked] = useState<{ index: number; key: string } | null>(
    null
  );

  const axisValue = formatAxis ?? formatValue;
  // the unit goes once, on the highest line (the last tick): the margin is measured by the widest label, so it fits
  const axisText = useCallback(
    (value: number, isTop: boolean) =>
      axisUnit && isTop ? `${axisUnit} ${axisValue(value)}` : axisValue(value),
    [axisUnit, axisValue]
  );
  const { layout, margin, secondaryLayout } = useChartLayouts({
    axisText,
    data,
    height,
    secondaryData,
    width,
  });

  const last = data.length - 1;
  const active =
    picked && picked.key === signature ? Math.min(picked.index, last) : last;
  const point = layout.points[active];
  const secondaryPoint = secondaryLayout?.points[active];
  const note = readingNote?.(active) ?? null;
  const best =
    layout.bestIndex === null ? undefined : layout.points[layout.bestIndex];

  const pick = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const box = event.currentTarget.getBoundingClientRect();
      setPicked({
        index: nearestIndex(layout, event.clientX - box.left),
        key: signature,
      });
    },
    [layout, signature]
  );
  const walk = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      setPicked({ index: Number(event.currentTarget.value), key: signature }),
    [signature]
  );

  return (
    <div className={cn("grid gap-2", className)}>
      {point ? (
        <Reading
          formatValue={formatValue}
          name={name}
          note={note}
          point={point}
          secondary={secondary}
          secondaryPoint={secondaryPoint}
        />
      ) : null}
      {secondary ? (
        <Legend
          color={color}
          legend={legend ?? name}
          secondary={secondary}
          secondaryColor={secondaryColor}
        />
      ) : null}
      <div
        className="relative touch-pan-y rounded-md"
        onPointerDown={pick}
        onPointerMove={pick}
        ref={measure}
        style={{ height }}
      >
        {width > 0 ? (
          <Drawing
            axisText={axisText}
            best={best}
            color={color}
            count={data.length}
            gradient={gradient}
            height={height}
            label={label}
            layout={layout}
            margin={margin}
            point={point}
            secondaryColor={secondaryColor}
            secondaryLayout={secondaryLayout}
            secondaryPoint={secondaryPoint}
            width={width}
          />
        ) : null}
        {point ? (
          <input
            aria-label={rangeLabel}
            aria-valuetext={spokenValue({
              formatValue,
              name,
              note,
              point,
              secondary,
              secondaryPoint,
            })}
            className={RANGE_CLASS}
            max={last}
            min={0}
            onChange={walk}
            step={1}
            type="range"
            value={active}
          />
        ) : null}
      </div>
    </div>
  );
}
