import { type ReactNode, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import type { AreaChartProps } from "./area-chart";
import type { SparklineProps } from "./sparkline";

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
export type { ChartDatum } from "./chart-geometry";
export type { SparklineProps } from "./sparkline";

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

type State =
  | { charts: Charts; status: "ready" }
  | { status: "failed" | "loading" };

function useCharts(): State {
  // a chunk already downloaded draws on the first render: no box in its place, no jump
  const [state, setState] = useState<State>(
    loaded ? { charts: loaded, status: "ready" } : { status: "loading" }
  );
  useEffect(() => {
    if (state.status === "ready") {
      return;
    }
    let current = true;
    loadCharts().then(
      (charts) => current && setState({ charts, status: "ready" }),
      () => current && setState({ status: "failed" })
    );
    return () => {
      current = false;
    };
  }, []);
  return state;
}

interface OnDemandProps {
  /** What stays when the chunk cannot be downloaded. Nothing when absent. */
  failed?: ReactNode;
}

/** The box that holds the place of a chart while its chunk loads. */
function Reserved({
  className,
  height,
}: {
  className?: string | undefined;
  height: number;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn("w-full", className)}
      data-chart-loading=""
      style={{ height }}
    />
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
  // the reading line above the drawing is one line of text: the box holds that line too
  return (
    <Reserved className={props.className} height={(props.height ?? 180) + 26} />
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
