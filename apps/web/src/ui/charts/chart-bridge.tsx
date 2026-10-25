/* Polaris adaptation of the Bklit UI area chart (the blocks are in src/ui/bklit/, unchanged but for BKLIT-UI.md), MIT */
import { type MutableRefObject, useEffect } from "react";
import {
  useChart,
  useChartStable,
  useYScale,
} from "../bklit/charts/chart-context";
import { XAxis } from "../bklit/charts/x-axis";

/** The width a date of the x axis ("17/10" in 12 px) needs with air around it, in pixels. */
const DATE_SLOT = 55;

/**
 * The dates of the x axis, as many as the plot has room for: four on a phone (the first, the last and two between),
 * at most six on a wide chart, never two touching ("11/1014/10"). The block takes the count as it is told.
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

/** The ring of the best day: the emerald (`--chart-1`) is the one use of it, with the sentence under the chart. */
function BestDay({ index }: { index: number }) {
  const { data, isLoaded, xAccessor, xScale } = useChart();
  const yScale = useYScale();
  const point = data[index];
  const value = point?.drawn;
  if (!(isLoaded && point) || typeof value !== "number") {
    return null;
  }
  return (
    <circle
      className="stroke-card"
      cx={xScale(xAccessor(point)) ?? 0}
      cy={yScale(value) ?? 0}
      data-chart-best=""
      fill="var(--chart-1)"
      r={4}
      strokeWidth={2}
    />
  );
}

/**
 * The part of the chart that lives inside the blocks' context: it gives the keyboard control a handle on the tooltip
 * (the context has the scales and the setter of the point in focus, the control is outside it, a sibling of the image)
 * and draws the best day. It draws nothing else.
 */
export function ChartBridge({
  bestIndex,
  handle,
}: {
  bestIndex: number | null;
  handle: MutableRefObject<ChartHandle | null>;
}) {
  const { data, isLoaded, lines, setTooltipData, xAccessor, xScale, yScale } =
    useChart();
  useEffect(() => {
    handle.current = {
      hide: () => setTooltipData(null),
      show: (index) => {
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
      },
    };
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
  return bestIndex === null ? null : <BestDay index={bestIndex} />;
}
