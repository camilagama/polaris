/* Polaris adaptation of the Bklit UI area chart (the blocks are in src/ui/bklit/, unchanged but for BKLIT-UI.md), MIT */
import { useReducedMotion } from "motion/react";
import {
  type ChangeEvent,
  type MutableRefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import { Area, AreaChart as BklitAreaChart } from "../bklit/charts/area-chart";
import { Grid } from "../bklit/charts/grid";
import { ChartTooltip } from "../bklit/charts/tooltip";
import { YAxis } from "../bklit/charts/y-axis";
import { ChartBridge, type ChartHandle, DateAxis } from "./chart-bridge";
import {
  bestIndex,
  type ChartColor,
  type ChartDatum,
  type ChartPoint,
  chartPoints,
  EXTRA_HEIGHT,
  LEFT_MARGIN_MIN,
  MARGIN,
  seriesMax,
  yAxisMargin,
} from "./chart-data";
import { Legend, Reading, spokenValue, TooltipLines } from "./chart-text";

/* The keyboard control is a native range input laid over the drawing: transparent, with no track and no thumb (the
   drawing shows the point in focus, with the tooltip of the block) and deaf to the pointer (the box under it moves
   the focus), so that its box is the box of the chart, which is what a touch finds, and the 3 px outline of the
   keyboard focus goes round the chart. */
const RANGE_CLASS =
  "focus-ring pointer-events-none absolute inset-0 m-0 size-full appearance-none rounded-md bg-transparent [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-transparent [&::-moz-range-track]:bg-transparent [&::-webkit-slider-runnable-track]:bg-transparent [&::-webkit-slider-thumb]:appearance-none";
/* the dash of the second series: the legend and the line draw the same one */
const DASH = "5,4";
const Y_LINES = 4;
const INK: ChartColor = "var(--chart-5)";
const GRAY: ChartColor = "var(--chart-3)";

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
  /** The text of a value in the reading of the day in focus, in the tooltip and in the spoken value of the keyboard control. */
  formatValue: (value: number) => string;
  /** The height of the plot in pixels: 180 for seven days, 220 for thirty or two series. The margins come on top of it. */
  height?: number;
  /** What the chart answers, with the figures that matter: it is the name of the image for a screen reader. */
  label: string;
  /** The name of the main series in the legend, with `secondary`. */
  legend?: string;
  /** The block's own loading state (`status="loading"`): a pulsing line and a shimmering grid, then the reveal. */
  loading?: boolean;
  /** The text that shimmers in the middle of the chart while `loading` ("Carregando"). */
  loadingLabel?: string | undefined;
  /** The short name of the main series in the reading of the day and in the tooltip ("Vendas"). */
  name?: string;
  /** The name of the keyboard control that walks through the points. */
  rangeLabel?: string;
  /** What the reading of a day adds after its values ("inclui R$ 1.800,00 de despesas"), or null. */
  readingNote?: (index: number) => string | null;
  /** A second series, dashed, with a legend (Resultado: the costs against the sales). */
  secondary?: AreaChartSecondary;
}

/**
 * What `prefers-reduced-motion: reduce` asks of the blocks: the reveal, the tween of the y domain, the morph of the
 * path and the spring of the tooltip off (the chart appears finished and the cursor jumps); without it, the blocks'
 * own defaults.
 */
function useMotion() {
  const reduced = useReducedMotion() === true;
  return reduced
    ? ({
        animate: false,
        animationDuration: 0,
        damping: 0,
        yDomainTween: false,
      } as const)
    : ({
        animate: true,
        animationDuration: 1100,
        damping: 20,
        yDomainTween: true,
      } as const);
}

function EmptyChart({
  className,
  height,
  label,
}: {
  className: string | undefined;
  height: number;
  label: string;
}) {
  // the floor, faint, where the drawing would be: it says what is missing without drawing a series of zeros
  return (
    <div
      aria-label={label}
      className={cn("relative w-full", className)}
      data-chart-empty=""
      role="img"
      style={{ height: height + EXTRA_HEIGHT }}
    >
      <div
        className="absolute inset-x-0 border-border border-t"
        style={{ bottom: 32 }}
      />
    </div>
  );
}

interface PlotProps {
  axisText: (value: number, isTop: boolean) => string;
  best: number | null;
  color: ChartColor | undefined;
  formatValue: (value: number) => string;
  handle: MutableRefObject<ChartHandle | null>;
  height: number;
  loading: boolean;
  loadingLabel: string | undefined;
  margin: typeof MARGIN;
  name: string;
  points: ChartPoint[];
  readingNote: ((index: number) => string | null) | undefined;
  secondary: AreaChartSecondary | undefined;
}

/** The blocks of Bklit UI, put together: the grid, the axes, one `Area` for each series and the tooltip. */
function Plot({
  axisText,
  best,
  color,
  formatValue,
  handle,
  height,
  loading,
  loadingLabel,
  margin,
  name,
  points,
  readingNote,
  secondary,
}: PlotProps) {
  const motion = useMotion();
  const labels = useMemo(() => points.map((item) => item.label), [points]);
  const style = useMemo(() => ({ height }), [height]);
  const secondaryColor = secondary?.color ?? GRAY;
  const content = useCallback(
    ({ index }: { index: number }) => (
      <TooltipLines
        color={color ?? INK}
        formatValue={formatValue}
        name={name}
        note={readingNote?.(index) ?? null}
        point={points[index]}
        secondary={secondary}
        secondaryColor={secondaryColor}
      />
    ),
    [color, formatValue, name, points, readingNote, secondary, secondaryColor]
  );
  return (
    <BklitAreaChart
      animationDuration={motion.animationDuration}
      aspectRatio="auto"
      data={points}
      loadingLabel={loadingLabel}
      margin={margin}
      status={loading ? "loading" : "ready"}
      style={style}
      yDomainTween={motion.yDomainTween}
    >
      <Grid numTicksRows={Y_LINES} />
      <DateAxis labels={labels} />
      <YAxis formatValue={axisText} numTicks={Y_LINES} />
      <Area
        animate={motion.animate}
        dataKey="drawn"
        showMarkers={points.length === 1}
        {...(color ? { fill: color, stroke: color } : {})}
      />
      {secondary ? (
        <Area
          animate={motion.animate}
          dashArray={DASH}
          dashFromIndex={0}
          dataKey="drawnSecondary"
          fill={secondaryColor}
          fillOpacity={0}
          stroke={secondaryColor}
        />
      ) : null}
      <ChartTooltip
        content={content}
        damping={motion.damping}
        dateLabels={labels}
      />
      <ChartBridge bestIndex={best} handle={handle} />
    </BklitAreaChart>
  );
}

/**
 * The area chart of the screens: Bklit UI's `AreaChart`, `Area`, `Grid`, `XAxis`, `YAxis` and `ChartTooltip` with
 * their own animation (reveal, y-domain tween, morph of the path when the data changes, spring of the cursor and of the
 * tooltip), and what the blocks do not bring: the colors by the tokens (`theme.css`), the dates and the money in pt-BR, a
 * name and a summary for a screen reader (`role="img"`), a native range input that walks through the points with the
 * arrows, the reading line above the drawing and `prefers-reduced-motion`.
 *
 * The day in focus is read in a line of text above the drawing (the last one, until the arrows move it); the pointer
 * and the touch read it in the tooltip of the block, which is gone when the finger lifts: the line is what stays.
 * With `secondary` the chart draws a second, dashed line on the same scale (the costs against the sales of the
 * Resultado). The chart is a reinforcement and never the only source of a number: the caller writes the total and the
 * best day beside it, and "Ver os números" shows the table.
 */
export function AreaChart({
  axisUnit,
  className,
  color,
  data,
  formatAxis,
  formatValue,
  height = 180,
  label,
  legend,
  loading = false,
  loadingLabel,
  name = "Vendas",
  rangeLabel = "Dia",
  readingNote,
  secondary,
}: AreaChartProps) {
  const handle: MutableRefObject<ChartHandle | null> = useRef(null);
  const secondaryData = secondary?.data;
  const signature = `${data.map((datum) => `${datum.label}:${datum.value}`).join()}|${(secondaryData ?? []).map((datum) => datum.value).join()}`;
  // the points follow the content of the series, not the identity of the arrays a screen builds on each render: the
  // blocks redraw (and the memoized parts below recompute) only when a label or a value changes
  const points = useMemo(() => chartPoints(data, secondaryData), [signature]);
  const rangeRef = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<{ index: number; key: string } | null>(
    null
  );
  const last = data.length - 1;
  const active =
    picked && picked.key === signature ? Math.min(picked.index, last) : last;

  const axisValue = formatAxis ?? formatValue;
  // the unit goes once, on the highest line: the margin is measured by the widest label, so it fits
  const axisText = useCallback(
    (value: number, isTop: boolean) =>
      axisUnit && isTop ? `${axisUnit} ${axisValue(value)}` : axisValue(value),
    [axisUnit, axisValue]
  );
  const top = Math.max(seriesMax(data), seriesMax(secondaryData ?? []));
  const margin = useMemo(
    () => ({
      ...MARGIN,
      left: Math.max(LEFT_MARGIN_MIN, yAxisMargin(axisText(top, true))),
    }),
    [axisText, top]
  );

  const walk = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const index = Number(event.currentTarget.value);
      setPicked({ index, key: signature });
      handle.current?.show(index);
    },
    [signature]
  );
  const show = useCallback(() => handle.current?.show(active), [active]);
  const hide = useCallback(() => {
    handle.current?.hide();
    setPicked(null);
  }, []);

  // new data under the keyboard focus: the tooltip goes to the day in focus, which is the last one again; with no focus,
  // a tooltip of the old data goes away
  useEffect(() => {
    if (document.activeElement === rangeRef.current) {
      handle.current?.show(last);
    } else {
      handle.current?.hide();
    }
  }, [signature]);

  if (data.length === 0) {
    return <EmptyChart className={className} height={height} label={label} />;
  }

  const reading = {
    formatValue,
    name,
    note: readingNote?.(active) ?? null,
    point: points[active],
    secondary,
  };
  const boxHeight = height + EXTRA_HEIGHT;

  return (
    <div className={cn("grid gap-2", className)} data-chart="">
      {loading ? (
        <p aria-hidden="true" className="min-h-[1.125rem]" />
      ) : (
        <Reading {...reading} />
      )}
      {secondary ? (
        <Legend
          color={color ?? INK}
          dash={DASH}
          legend={legend ?? name}
          secondary={secondary}
          secondaryColor={secondary.color ?? GRAY}
        />
      ) : null}
      <div className="relative rounded-md" style={{ height: boxHeight }}>
        <div
          aria-label={label}
          className="size-full"
          data-chart-area=""
          role="img"
        >
          <Plot
            axisText={axisText}
            best={bestIndex(data)}
            color={color}
            formatValue={formatValue}
            handle={handle}
            height={boxHeight}
            loading={loading}
            loadingLabel={loadingLabel}
            margin={margin}
            name={name}
            points={points}
            readingNote={readingNote}
            secondary={secondary}
          />
        </div>
        {loading ? null : (
          <input
            aria-label={rangeLabel}
            aria-valuetext={spokenValue(reading)}
            className={RANGE_CLASS}
            max={last}
            min={0}
            onBlur={hide}
            onChange={walk}
            onFocus={show}
            ref={rangeRef}
            step={1}
            type="range"
            value={active}
          />
        )}
      </div>
    </div>
  );
}
