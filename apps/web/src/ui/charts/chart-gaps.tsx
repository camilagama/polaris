/* Polaris adaptation of the Bklit UI area chart (the blocks are in src/ui/bklit/, unchanged but for BKLIT-UI.md), MIT */
import { curveMonotoneX } from "@visx/curve";
import { LinePath } from "@visx/shape";
import { useCallback, useId } from "react";
import { useChart, useYScale } from "../bklit/charts/chart-context";
import type { ChartPoint, KnownRun } from "./chart-data";

/**
 * A second series with unknown values (AC-9 of the Resultado, emenda de 25/10): the `Area` of Bklit UI draws a value
 * that is not a number as a zero and has no gap, so the series is drawn here, inside the blocks' context and with
 * their scales, one dashed line per run of known values ("uma série por trecho contínuo"), in the color and the dash
 * of the series. A known day between two unknown ones is a 7 px grey point with the ring of the card; an unknown day
 * is hatched over the whole height of the plot, and nothing of the line is drawn on it. The hatch means "unknown" and
 * only that. Nothing here animates (motion is opacity only, and a phone draws the chart finished): the lines follow the
 * scales of the blocks while their domain moves.
 */

/** The side of the tile of the hatch, in pixels: one line every 6 px, at 45°. */
const HATCH = 6;
/**
 * The radius of the point of a known day alone between unknown ones: a grey disc 7 px across inside the 2 px ring of
 * the card (the stroke is centered on the edge: 3.5 px of disc plus 1 px of ring inside it, 1 px outside).
 */
const LONE_RADIUS = 4.5;

export function GapSeries({
  color,
  dash,
  mainColor,
  runs,
}: {
  color: string;
  dash: string;
  /** The color of the main series: the point read on it (the tooltip of the block draws no point in this mode). */
  mainColor: string;
  runs: readonly KnownRun[];
}) {
  const { data, innerHeight, innerWidth, isLoaded, tooltipData, xScale } =
    useChart();
  const yScale = useYScale();
  const id = useId();
  const x = useCallback(
    (point: ChartPoint) => xScale(point.date) ?? 0,
    [xScale]
  );
  // a run holds only known points: `drawnSecondary` is there for each of them
  const y = useCallback(
    (point: ChartPoint) => yScale(point.drawnSecondary ?? 0) ?? 0,
    [yScale]
  );
  if (!isLoaded) {
    return null;
  }
  const points = data as ChartPoint[];
  // the band of a day is the step between two days, centered on its date and kept inside the plot
  const step =
    points.length > 1
      ? x(points[1] as ChartPoint) - x(points[0] as ChartPoint)
      : innerWidth;
  const unknown = points.flatMap((point, index) =>
    point.rawSecondary === null ? [index] : []
  );
  const pattern = `chart-unknown-${id.replaceAll(":", "")}`;
  const read = tooltipData ? points[tooltipData.index] : undefined;
  return (
    <g data-chart-gaps="">
      <defs>
        <pattern
          height={HATCH}
          id={pattern}
          patternTransform="rotate(45)"
          patternUnits="userSpaceOnUse"
          width={HATCH}
        >
          <rect
            fill="var(--chart-unknown)"
            fillOpacity={0.08}
            height={HATCH}
            width={HATCH}
          />
          <line
            stroke="var(--chart-unknown)"
            strokeWidth={1.6}
            x1={0}
            x2={0}
            y1={0}
            y2={HATCH}
          />
        </pattern>
      </defs>
      {unknown.map((index) => {
        const center = x(points[index] as ChartPoint);
        const left = Math.max(0, center - step / 2);
        const right = Math.min(innerWidth, center + step / 2);
        return (
          <rect
            data-chart-unknown-day={index}
            fill={`url(#${pattern})`}
            height={innerHeight}
            key={index}
            width={Math.max(0, right - left)}
            x={left}
            y={0}
          />
        );
      })}
      {runs.map((run) => {
        const segment = points.slice(run.start, run.end + 1);
        if (segment.length === 1) {
          const lone = segment[0] as ChartPoint;
          return (
            <circle
              className="stroke-card"
              cx={x(lone)}
              cy={y(lone)}
              data-chart-lone-day={run.start}
              fill={color}
              key={run.start}
              r={LONE_RADIUS}
              strokeWidth={2}
            />
          );
        }
        return (
          <LinePath
            curve={curveMonotoneX}
            data={segment}
            data-chart-run={`${run.start}-${run.end}`}
            fill="none"
            key={run.start}
            stroke={color}
            strokeDasharray={dash}
            strokeLinecap="round"
            strokeWidth={2}
            x={x}
            y={y}
          />
        );
      })}
      {read ? (
        <circle
          className="stroke-card"
          cx={x(read)}
          cy={yScale(read.drawn) ?? 0}
          fill={mainColor}
          pointerEvents="none"
          r={4}
          strokeWidth={2}
        />
      ) : null}
      {read && read.drawnSecondary !== undefined ? (
        <circle
          className="stroke-card"
          cx={x(read)}
          cy={y(read)}
          fill={color}
          pointerEvents="none"
          r={4}
          strokeWidth={2}
        />
      ) : null}
    </g>
  );
}
