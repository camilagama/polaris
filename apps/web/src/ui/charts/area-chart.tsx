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
  type ChartMargin,
  chartLayout,
  estimateLabelWidth,
  nearestIndex,
} from "./chart-geometry";
import { useElementWidth } from "./use-element-width";

const AXIS_FONT_SIZE = 11;
const GRID_LINES = 3;
/* The keyboard control is a native range input laid over the drawing: transparent, with no track and no thumb (the
   drawing shows the point in focus) and deaf to the pointer (the box under it moves the focus), so that its box is the
   box of the chart, which is what a touch finds, and the 3 px outline of the keyboard focus goes round the chart. */
const RANGE_CLASS =
  "focus-ring pointer-events-none absolute inset-0 m-0 size-full appearance-none rounded-md bg-transparent [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-transparent [&::-moz-range-track]:bg-transparent [&::-webkit-slider-runnable-track]:bg-transparent [&::-webkit-slider-thumb]:appearance-none";
const BASE_MARGIN: ChartMargin = { bottom: 24, left: 8, right: 8, top: 8 };

export interface AreaChartProps {
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
  /** The name of the keyboard control that walks through the points. */
  rangeLabel?: string;
  /** A fixed width in pixels, for a test or a static page; measured from the box when absent. */
  width?: number;
}

/**
 * The area chart of one series (Bklit UI adapted to the tokens of the app): a 2 px line, a fill that fades to
 * nothing, horizontal grid only, three labeled lines above the floor and the dates of the x axis. The day in focus
 * (the last one, until a touch, the mouse or the arrows move it) is read in a line of text above the drawing, never
 * in a floating box that would cover the axis at 360 px.
 *
 * The drawing is an image for a screen reader (`role="img"` with the summary in `aria-label`); the way to walk
 * through the points without a pointer is a native range input laid over the drawing, transparent, that speaks the
 * date and the value (`aria-valuetext`) and draws the 3 px focus outline around the chart. The chart is a reinforcement and never the only source of a number: the caller writes the
 * total and the best day beside it, and "Ver os números" shows the table. Movement is a fade-in of the opacity
 * only (`animate-rise`), which `prefers-reduced-motion` zeroes with the rest of the page.
 */
export function AreaChart({
  className,
  color = "var(--chart-5)",
  data,
  formatAxis,
  formatValue,
  height = 180,
  label,
  rangeLabel = "Dia",
  width: fixedWidth,
}: AreaChartProps) {
  const [measure, measuredWidth] = useElementWidth<HTMLDivElement>();
  const width = fixedWidth ?? measuredWidth;
  const gradient = `chart-fill-${useId().replaceAll(":", "")}`;
  const signature = data.map((datum) => `${datum.label}:${datum.value}`).join();
  const [picked, setPicked] = useState<{ index: number; key: string } | null>(
    null
  );

  const axisText = formatAxis ?? formatValue;
  // the labels of the y axis decide the left margin, so the layout is made twice: once for the lines, once to fit them
  const { layout, margin } = useMemo(() => {
    const options = { height, lines: GRID_LINES, width };
    const labelWidth = estimateLabelWidth(
      chartLayout(data, { ...options, margin: BASE_MARGIN }).ticks.map((tick) =>
        axisText(tick.value)
      ),
      AXIS_FONT_SIZE
    );
    const fitted = {
      ...BASE_MARGIN,
      left: labelWidth > 0 ? labelWidth + 14 : BASE_MARGIN.left,
    };
    return {
      layout: chartLayout(data, { ...options, margin: fitted }),
      margin: fitted,
    };
  }, [axisText, data, height, width]);

  const last = data.length - 1;
  const active =
    picked && picked.key === signature ? Math.min(picked.index, last) : last;
  const point = layout.points[active];
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
        <p
          aria-live="polite"
          className="flex min-h-[1.125rem] items-baseline gap-2 text-muted-foreground text-support"
        >
          <span>{point.label}</span>{" "}
          <span className="font-medium text-foreground tabular-nums">
            {formatValue(point.value)}
          </span>
        </p>
      ) : null}
      <div
        className="relative touch-pan-y rounded-md"
        onPointerDown={pick}
        onPointerMove={pick}
        ref={measure}
        style={{ height }}
      >
        {width > 0 ? (
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
            {layout.ticks.map((tick) => (
              <text
                className="fill-muted-foreground text-[11px]"
                dominantBaseline="central"
                key={tick.value}
                textAnchor="end"
                x={margin.left - 6}
                y={tick.y}
              >
                {axisText(tick.value)}
              </text>
            ))}
            {layout.labelIndexes.map((index) => {
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
            })}
            {layout.area ? (
              <path d={layout.area} fill={`url(#${gradient})`} />
            ) : null}
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
                {data.length > 1 ? (
                  <line
                    className="stroke-foreground/35"
                    strokeWidth={1}
                    x1={point.x}
                    x2={point.x}
                    y1={margin.top}
                    y2={layout.floor}
                  />
                ) : null}
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
        ) : null}
        {point ? (
          <input
            aria-label={rangeLabel}
            aria-valuetext={`${point.label}: ${formatValue(point.value)}`}
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
