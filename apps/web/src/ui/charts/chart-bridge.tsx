/* Polaris adaptation of the Bklit UI area chart (the blocks are in src/ui/bklit/, unchanged but for BKLIT-UI.md), MIT */
import { type MutableRefObject, useEffect, useRef } from "react";
import {
  useChart,
  useChartStable,
  useYScale,
} from "../bklit/charts/chart-context";
import { XAxis } from "../bklit/charts/x-axis";

/** The width a date of the x axis ("17/10" in 12 px) needs with air around it, in pixels. */
const DATE_SLOT = 55;

/**
 * The dates of the x axis, as many as the plot has room for: three or four on a phone (three in the card of the
 * Início at 360 px), at most six on a wide chart, never two touching ("11/1014/10"). The block takes the count as it
 * is told.
 */
export function DateAxis({ labels }: { labels: string[] }) {
  const { innerWidth } = useChartStable();
  const count = Math.max(3, Math.min(6, Math.floor(innerWidth / DATE_SLOT)));
  return <XAxis labels={labels} numTicks={count} />;
}

/** What the keyboard control asks of the chart: show the tooltip on a point, and take it away. */
export interface ChartHandle {
  hide: () => void;
  show: (index: number) => void;
}

/** Which days carry a ring: every day (a week, v7 § 4), only the best one and today (30 days), or only the best one. */
export type DayMarkers = "all" | "best" | "key";

/**
 * The rings of the days, in the color of the series (v7 § 4): a day that sold has a full ring and a day with no sale a
 * hollow one on the floor, so the eye reads days and not a continuous hill; the best day is a larger ring (its shape,
 * not a color, marks it, with the sentence under the chart). With `label`, the value of the best day and of today is
 * written above its ring (a touch has no hover); the drawing is inside the image, the numbers are in the text too.
 */
function DayMarks({
  best,
  color,
  label,
  markers,
}: {
  best: number | null;
  color: string;
  label: ((value: number) => string) | null;
  markers: DayMarkers;
}) {
  const { data, innerWidth, isLoaded, xAccessor, xScale } = useChart();
  const yScale = useYScale();
  if (!isLoaded) {
    return null;
  }
  const last = data.length - 1;
  const shown = data.flatMap((point, index) => {
    const value = point.drawn;
    const wanted =
      markers === "all" ||
      index === best ||
      (markers === "key" && index === last);
    return wanted && typeof value === "number"
      ? [
          {
            index,
            value,
            x: xScale(xAccessor(point)) ?? 0,
            y: yScale(value) ?? 0,
          },
        ]
      : [];
  });
  const labelled = new Set(
    label ? [best, last].filter((index) => index !== null) : []
  );
  return (
    <g aria-hidden="true" data-chart-marks="">
      {shown.map((mark) => {
        const sold = mark.value > 0;
        return (
          <circle
            className={sold ? "stroke-card" : undefined}
            cx={mark.x}
            cy={mark.y}
            data-chart-best={mark.index === best ? "" : undefined}
            data-chart-mark={sold ? "sold" : "none"}
            fill={sold ? color : "var(--card)"}
            key={mark.index}
            r={mark.index === best ? 5.5 : 3.5}
            stroke={sold ? undefined : color}
            strokeWidth={sold ? 2 : 1.5}
          />
        );
      })}
      {label
        ? shown
            .filter((mark) => labelled.has(mark.index))
            .map((mark) => {
              // the label of a ring near an edge is anchored inside the plot, so it is never cut
              let anchor: "end" | "middle" | "start" = "middle";
              if (mark.x > innerWidth - 32) {
                anchor = "end";
              } else if (mark.x < 32) {
                anchor = "start";
              }
              return (
                <text
                  className="fill-foreground font-medium text-[11px] tabular-nums"
                  data-chart-value-label=""
                  key={`label-${mark.index}`}
                  textAnchor={anchor}
                  x={mark.x}
                  y={Math.max(10, mark.y - 10)}
                >
                  {label(mark.value)}
                </text>
              );
            })
        : null}
    </g>
  );
}

/**
 * The part of the chart that lives inside the blocks' context: it gives the keyboard control a handle on the tooltip
 * (the context has the scales and the setter of the point in focus, the control is outside it, a sibling of the image)
 * and draws the rings of the days (and, when asked, the value of the best day and of today). It draws nothing else.
 */
export function ChartBridge({
  bestIndex,
  color,
  handle,
  label = null,
  markers = "best",
}: {
  bestIndex: number | null;
  /** The color of the series: the rings are drawn in it. */
  color: string;
  handle: MutableRefObject<ChartHandle | null>;
  label?: ((value: number) => string) | null;
  markers?: DayMarkers;
}) {
  const { data, isLoaded, lines, setTooltipData, xAccessor, xScale, yScale } =
    useChart();
  // The point the keyboard control asked for: it is shown as soon as the chart can show it (the block is not loaded
  // until its reveal ends) and follows the scales while they move, until the control takes it away.
  const wanted = useRef<number | null>(null);
  useEffect(() => {
    const show = (index: number) => {
      wanted.current = index;
      const point = data[index];
      if (!(isLoaded && point)) {
        return;
      }
      const yPositions: Record<string, number> = {};
      for (const line of lines) {
        const value = point[line.dataKey];
        if (typeof value === "number") {
          yPositions[line.dataKey] = yScale(value) ?? 0;
        }
      }
      setTooltipData({
        index,
        point,
        x: xScale(xAccessor(point)) ?? 0,
        yPositions,
      });
    };
    handle.current = {
      hide: () => {
        wanted.current = null;
        setTooltipData(null);
      },
      show,
    };
    if (wanted.current !== null) {
      show(wanted.current);
    }
    return () => {
      handle.current = null;
    };
  }, [
    data,
    handle,
    isLoaded,
    lines,
    setTooltipData,
    xAccessor,
    xScale,
    yScale,
  ]);
  return (
    <DayMarks
      best={bestIndex}
      color={color}
      label={label}
      markers={markers}
    />
  );
}
