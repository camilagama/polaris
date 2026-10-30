/* Polaris adaptation of the Bklit UI area chart (the blocks are in src/ui/bklit/, unchanged but for BKLIT-UI.md), MIT */
import { MotionConfig } from "motion/react";
import {
  type ChangeEvent,
  type MutableRefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useMotionLevel } from "@/lib/motion-level";
import { cn } from "@/lib/utils";
import { Area, AreaChart as BklitAreaChart } from "../bklit/charts/area-chart";
import { Grid } from "../bklit/charts/grid";
import { ChartTooltip } from "../bklit/charts/tooltip";
import { YAxis } from "../bklit/charts/y-axis";
import { GapSeries } from "./chart-gaps";
import {
  ChartBridge,
  type ChartHandle,
  DateAxis,
  type DayMarkers,
} from "./chart-bridge";
import {
  bestIndex,
  type ChartColor,
  type ChartDatum,
  type ChartPoint,
  chartPoints,
  EXTRA_HEIGHT,
  hasUnknown,
  knownRuns,
  LEFT_MARGIN_MIN,
  MARGIN,
  type SecondaryDatum,
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
/** The share of its color a `subtle` line keeps. */
const SUBTLE_PERCENT = 55;
const Y_LINES = 4;
const INK: ChartColor = "var(--chart-5)";
const GRAY: ChartColor = "var(--chart-3)";

/** A second series in the box of the chart: a dashed line with no fill, on the scale of the main one. */
interface AreaChartSecondary {
  /** The color of the line: a token of the chart palette. `--chart-3` (the mid grey) when absent. */
  color?: ChartColor;
  /**
   * One datum per datum of the main series, in the same order (the labels are the main series'). A `null` value is
   * unknown: the day is hatched, the line breaks on it, and the reading says `unknown.text` (never a zero).
   */
  data: readonly SecondaryDatum[];
  /** The name in the legend ("Custos (CMV, taxas e despesas)"). */
  legend: string;
  /** The short name in the reading of the day ("Custos"). */
  name: string;
  /**
   * A context line that does not compete with the main one: 1 px at 55 % of its color, and no legend (the help of the
   * block and the reading of a day name it).
   */
  subtle?: boolean;
  /** What an unknown value is called: in the reading and the tooltip ("sem custo informado") and in the legend of the hatch. */
  unknown?: { legend: string; text: string };
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
  /** What the keyboard control says of a value; `formatValue` when absent ("valor escondido" with the values hidden). */
  formatSpoken?: (value: number) => string;
  /** The text of a value in the reading of the day in focus, in the tooltip and in the spoken value of the keyboard control. */
  formatValue: (value: number) => string;
  /** The height of the plot in pixels: 180 for seven days, 220 for thirty or two series. The margins come on top of it. */
  height?: number;
  /** What the chart answers, with the figures that matter: it is the name of the image for a screen reader. */
  label: string;
  /** The name of the main series in the legend, with `secondary`. */
  legend?: string;
  /**
   * The rings of the days (v7 § 4): every day, a full ring on a day that sold and a hollow one on a day with none
   * (`all`, a week); only the best day and today (`key`, 30 days); only the best day (`best`, the default).
   */
  markers?: DayMarkers;
  /**
   * The value written above the rings: the best day's and today's (`true`), or only the best day's, with its date
   * (`"peak"`, "18/10 · R$ 1.840,00").
   */
  valueLabels?: boolean | "peak";
  /**
   * Whether the line that reads the day in focus shows at rest (the last day). Without it (`false`) the line shows only
   * while the keyboard control has moved the focus, and then over the corner of the drawing, out of the flow, so
   * nothing sits above the drawing for good and reading a day moves nothing. True by default.
   */
  readingAtRest?: boolean;
  /** Drawn finished, with no reveal and no tween (a phone, v7 § 7); `prefers-reduced-motion` does the same. */
  still?: boolean;
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
  /** What the keyboard control says of the note of a day; `readingNote` when absent (the amounts hidden: spoken apart). */
  spokenNote?: (index: number) => string | null;
}

/**
 * What a phone (`essential`) and `prefers-reduced-motion` (`none`) ask of the blocks (src/lib/motion-level.ts): the
 * reveal, the tween of the y domain, the morph of the path and the spring of the tooltip off (the chart appears
 * finished and the cursor jumps from point to point with the finger); at the `full` level, the blocks' own defaults.
 * The props turn off what does not read the `MotionConfig` (the clip of the reveal animates a width, which
 * `reducedMotion="always"` leaves running); the `MotionConfig` of `Plot` reaches what the blocks decide inside
 * (adaptation 9 of BKLIT-UI.md).
 */
function useMotion(still: boolean) {
  const quiet = useMotionLevel() !== "full" || still;
  return quiet
    ? ({
        animate: false,
        animationDuration: 0,
        damping: 0,
        reducedMotion: "always",
        yDomainTween: false,
      } as const)
    : ({
        animate: true,
        animationDuration: 1100,
        damping: 20,
        reducedMotion: "user",
        yDomainTween: true,
      } as const);
}

/** Whether the line that reads the day in focus is on the screen: at rest if the caller wants it, else once the keyboard moved the focus. */
function showsReading({
  atRest,
  loading,
  picked,
}: {
  atRest: boolean;
  loading: boolean;
  picked: boolean;
}): boolean {
  return !loading && (atRest || picked);
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
  markers: DayMarkers;
  still: boolean;
  valueLabels: boolean | "peak";
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
  markers,
  still,
  valueLabels,
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
  const motion = useMotion(still);
  const labels = useMemo(() => points.map((item) => item.label), [points]);
  const gaps = hasUnknown(secondary?.data);
  const runs = useMemo(
    () => (secondary && gaps ? knownRuns(secondary.data) : []),
    [gaps, secondary]
  );
  const style = useMemo(() => ({ height }), [height]);
  const secondaryColor = secondary?.color ?? GRAY;
  const subtle = secondary?.subtle === true;
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
    <MotionConfig reducedMotion={motion.reducedMotion}>
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
        {secondary && !gaps ? (
          <Area
            animate={motion.animate}
            dashArray={DASH}
            dashFromIndex={0}
            dataKey="drawnSecondary"
            fill={secondaryColor}
            fillOpacity={0}
            stroke={
              subtle
                ? `color-mix(in oklab, ${secondaryColor} ${SUBTLE_PERCENT}%, transparent)`
                : secondaryColor
            }
            {...(subtle ? { strokeWidth: 1 } : {})}
          />
        ) : null}
        {/* with an unknown day the block only lends its scale to the known values (it would draw an unknown one as a
            zero): nothing of it is painted, and the runs, the hatch and the point read are drawn by `GapSeries` */}
        {secondary && gaps ? (
          <Area
            animate={false}
            dataKey="drawnSecondary"
            fillOpacity={0}
            showHighlight={false}
            showLine={false}
          />
        ) : null}
        {secondary && gaps ? (
          <GapSeries
            color={secondaryColor}
            dash={DASH}
            mainColor={color ?? INK}
            runs={runs}
          />
        ) : null}
        <ChartTooltip
          content={content}
          damping={motion.damping}
          dateLabels={labels}
          showDots={!gaps}
        />
        <ChartBridge
          bestIndex={best}
          color={color ?? INK}
          handle={handle}
          label={valueLabels ? formatValue : null}
          markers={markers}
          peakOnly={valueLabels === "peak"}
        />
      </BklitAreaChart>
    </MotionConfig>
  );
}

/**
 * The area chart of the screens: Bklit UI's `AreaChart`, `Area`, `Grid`, `XAxis`, `YAxis` and `ChartTooltip` with
 * their own animation (reveal, y-domain tween, morph of the path when the data changes, spring of the cursor and of the
 * tooltip), and what the blocks do not bring: the colors by the tokens (`theme.css`), the dates and the money in pt-BR, a
 * name and a summary for a screen reader (`role="img"`), a native range input that walks through the points with the
 * arrows, the reading line and the levels of motion (none of it on a phone).
 *
 * The day in focus is read in a line of text (the last one, until the arrows move it): above the drawing when it is
 * there at rest, else inside the box, over the top left corner, so reading a day never moves what follows the chart.
 * The pointer and the touch read it in the tooltip of the block, which is gone when the finger lifts: the line is what stays.
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
  formatSpoken,
  formatValue,
  height = 180,
  label,
  legend,
  loading = false,
  loadingLabel,
  markers = "best",
  name = "Vendas",
  rangeLabel = "Dia",
  readingAtRest = true,
  readingNote,
  secondary,
  spokenNote,
  still = false,
  valueLabels = false,
}: AreaChartProps) {
  const handle: MutableRefObject<ChartHandle | null> = useRef(null);
  const secondaryData = secondary?.data;
  const signature = `${data.map((datum) => `${datum.label}:${datum.value}`).join()}|${(secondaryData ?? []).map((datum) => datum.value).join()}`;
  // the points follow the content of the series, not the identity of the arrays a screen builds on each render: the
  // blocks redraw (and the memoized parts below recompute) only when a label or a value changes. `data` and
  // `secondaryData` are left out of the dependencies on purpose: `signature` holds everything the points read from them
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
  const readingShown = showsReading({
    atRest: readingAtRest,
    loading,
    picked: picked?.key === signature,
  });

  return (
    <div className={cn("grid gap-2", className)} data-chart="">
      {readingShown && readingAtRest ? <Reading {...reading} /> : null}
      {loading && readingAtRest ? (
        <p aria-hidden="true" className="min-h-[1.125rem]" />
      ) : null}
      {secondary && !secondary.subtle ? (
        <Legend
          color={color ?? INK}
          dash={DASH}
          legend={legend ?? name}
          hatched={hasUnknown(secondary.data)}
          secondary={secondary}
          secondaryColor={secondary.color ?? GRAY}
          secondaryDrawn={secondary.data.some((datum) => datum.value !== null)}
        />
      ) : null}
      <div className="relative rounded-md" style={{ height: boxHeight }}>
        {readingShown && !readingAtRest ? (
          <Reading
            {...reading}
            className="pointer-events-none absolute top-1 left-1 z-[60] max-w-[calc(100%-0.5rem)] rounded-sm bg-card/90 px-1.5 py-0.5"
          />
        ) : null}
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
            markers={markers}
            still={still}
            valueLabels={valueLabels}
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
            aria-valuetext={spokenValue({
              ...reading,
              formatValue: formatSpoken ?? formatValue,
              note: spokenNote ? spokenNote(active) : reading.note,
            })}
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
