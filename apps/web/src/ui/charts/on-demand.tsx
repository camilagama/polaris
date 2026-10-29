import { type ReactNode, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import type { AreaChartProps } from "./area-chart";
import type { RingChartProps } from "./ring-chart";
import type { SalesHeatmapProps } from "./sales-heatmap";
import type { SparklineProps } from "./sparkline";
import type { WeekdayBarsProps } from "./weekday-bars";

/**
 * How a screen draws a chart: the charts chunk is downloaded when the first one is asked for (`import()` of
 * `charts.ts`), never with the shell's first script. Until it arrives a box of the height the chart will have holds
 * the place, so the page does not jump; if the download fails (no connection and the chunk not cached yet) the
 * chart disappears and `failed` takes its place (nothing by default), leaving the text of the screen, which says the
 * same with words: a chart is a reinforcement and never the only source of a number.
 *
 * This is the only module of `src/ui/charts/` that the rest of the app imports, and the only one that stays
 * out of the chunk. It imports the others as types only; a guard in the budget plugin fails the build otherwise.
 */
export type { AreaChartProps } from "./area-chart";
export type { ChartDatum } from "./chart-data";
export type { RingChartProps } from "./ring-chart";
export type { HeatmapDay, SalesHeatmapProps } from "./sales-heatmap";
export type { SparklineProps } from "./sparkline";
export type { WeekdayBarsProps } from "./weekday-bars";

/** The margins of the blocks added to the plot: the same number as `EXTRA_HEIGHT` of chart-data.ts. */
const EXTRA_HEIGHT = 40;

type Charts = typeof import("./charts");

let loading: Promise<Charts> | null = null;
let loaded: Charts | null = null;

function loadCharts(): Promise<Charts> {
  if (!loading) {
    loading = import("./charts").then(
      (charts) => {
        loaded = charts;
        return charts;
      },
      (error: unknown) => {
        // a failed download is tried again by the next chart that asks, which may find the connection back
        loading = null;
        throw error;
      }
    );
  }
  return loading;
}

type Heatmap = typeof import("./heatmap");

let loadingHeatmap: Promise<Heatmap> | null = null;
let loadedHeatmap: Heatmap | null = null;

/** The map of the Início has a chunk of its own (`heatmap-*.js`), loaded the same way. */
function loadHeatmap(): Promise<Heatmap> {
  if (!loadingHeatmap) {
    loadingHeatmap = import("./heatmap").then(
      (heatmap) => {
        loadedHeatmap = heatmap;
        return heatmap;
      },
      (error: unknown) => {
        loadingHeatmap = null;
        throw error;
      }
    );
  }
  return loadingHeatmap;
}

type State<T> =
  | { charts: T; status: "ready" }
  | { status: "failed" | "loading" };

function useChunk<T>(downloaded: T | null, load: () => Promise<T>): State<T> {
  // a chunk already downloaded draws on the first render: no box in its place, no jump
  const [state, setState] = useState<State<T>>(
    downloaded ? { charts: downloaded, status: "ready" } : { status: "loading" }
  );
  useEffect(() => {
    if (state.status === "ready") {
      return;
    }
    let current = true;
    load().then(
      (charts) => current && setState({ charts, status: "ready" }),
      () => current && setState({ status: "failed" })
    );
    return () => {
      current = false;
    };
  }, []);
  return state;
}

const useCharts = () => useChunk(loaded, loadCharts);
const useHeatmapChunk = () => useChunk(loadedHeatmap, loadHeatmap);

interface OnDemandProps {
  /** What stays when the chunk cannot be downloaded. Nothing when absent. */
  failed?: ReactNode;
}

/**
 * The box that holds the place of a chart while its chunk loads. The area chart's has its floor, faint, where the
 * drawing will put it (`floor` px from the bottom): it says something comes there, without a jump and without a grey
 * skeleton in the place of the whole chart.
 */
function Reserved({
  className,
  floor,
  height,
}: {
  className?: string | undefined;
  floor?: number;
  height: number;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn("relative w-full", className)}
      data-chart-loading=""
      style={{ height }}
    >
      {floor === undefined ? null : (
        <div
          className="absolute inset-x-0 border-border border-t"
          data-chart-floor=""
          style={{ bottom: floor }}
        />
      )}
    </div>
  );
}

export function OnDemandAreaChart({
  failed,
  ...props
}: AreaChartProps & OnDemandProps) {
  const state = useCharts();
  if (state.status === "ready") {
    return <state.charts.AreaChart {...props} />;
  }
  if (state.status === "failed") {
    return failed ?? null;
  }
  // the box of the chart is its plot plus the margins of the blocks (`EXTRA_HEIGHT` of chart-data.ts, which this loader
  // may not import), and the reading line above the drawing is one line of text that the box holds too (with a second
  // series the reading takes two lines on a phone and the legend one more)
  // the floor of the drawing is 32 px above its bottom (the dates of the x axis)
  return (
    <Reserved
      className={props.className}
      floor={32}
      height={
        (props.height ?? 180) + EXTRA_HEIGHT + (props.secondary ? 26 + 44 : 26)
      }
    />
  );
}

export function OnDemandSparkline({
  failed,
  ...props
}: OnDemandProps & SparklineProps) {
  const state = useCharts();
  if (state.status === "ready") {
    return <state.charts.Sparkline {...props} />;
  }
  if (state.status === "failed") {
    return failed ?? null;
  }
  return <Reserved className={props.className} height={props.height ?? 32} />;
}

export function OnDemandRingChart({
  failed,
  ...props
}: OnDemandProps & RingChartProps) {
  const state = useCharts();
  if (state.status === "ready") {
    return <state.charts.RingChart {...props} />;
  }
  if (state.status === "failed") {
    return failed ?? null;
  }
  return (
    <span
      aria-hidden="true"
      className={cn("block", props.className)}
      data-chart-loading=""
      style={{ height: props.size, width: props.size }}
    />
  );
}

/** The map of the Início; while its chunk loads, a box of the height it will have. */
export function OnDemandHeatmap({
  failed,
  height,
  ...props
}: OnDemandProps & SalesHeatmapProps & { height: number }) {
  const state = useHeatmapChunk();
  if (state.status === "ready") {
    return <state.charts.SalesHeatmap {...props} />;
  }
  if (state.status === "failed") {
    return failed ?? null;
  }
  return <Reserved className={props.className} height={height} />;
}

/** The bars of the mean by weekday, in the same chunk as the map. */
export function OnDemandWeekdayBars({
  failed,
  ...props
}: OnDemandProps & WeekdayBarsProps) {
  const state = useHeatmapChunk();
  if (state.status === "ready") {
    return <state.charts.WeekdayBars {...props} />;
  }
  if (state.status === "failed") {
    return failed ?? null;
  }
  return <Reserved className={props.className} height={props.height ?? 64} />;
}
