/* Polaris adaptation of the Bklit UI sparkline (the blocks are in src/ui/bklit/, unchanged but for BKLIT-UI.md), MIT */
import { useReducedMotion } from "motion/react";
import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { AreaSparkline } from "../bklit/charts/sparkline";
import type { ChartColor } from "./chart-data";

export interface SparklineProps {
  className?: string;
  /** The color of the series: a token of the chart palette. The ink (`--chart-line-primary`) when absent. */
  color?: ChartColor;
  /** The height of the drawing in pixels. */
  height?: number;
  /** The values in order, one per day. Nothing is drawn without any. */
  values: readonly number[];
  /** A fixed width in pixels, for a test or a static page; measured from the box when absent. */
  width?: number;
}

/**
 * The miniature of a series inside a card with a number: Bklit UI's `AreaSparkline` (its entrance, a fill that fades to
 * nothing, a dot on the last value), with no axis, no grid, no focus and no pointer reading. It is `aria-hidden`: the
 * number beside it is the information, and a screen reader hears that, not a drawing it cannot read.
 * `prefers-reduced-motion: reduce` turns the entrance and the morph off.
 */
export function Sparkline({
  className,
  color,
  height = 32,
  values,
  width,
}: SparklineProps) {
  const reduced = useReducedMotion() === true;
  const data = useMemo(() => values.map((value) => ({ value })), [values]);
  if (values.length === 0) {
    return null;
  }
  return (
    <span
      aria-hidden="true"
      className={cn("block w-full", className)}
      style={{ height }}
    >
      <AreaSparkline
        animate={!reduced}
        {...(reduced ? { dataTransitionDuration: 0 } : {})}
        {...(color ? { color } : {})}
        data={data}
        dataKey="value"
        endDot
        height={height}
        interactive={false}
        width={width}
      />
    </span>
  );
}
