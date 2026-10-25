/* Polaris adaptation of the Bklit UI sparkline (the blocks are in src/ui/bklit/, unchanged but for BKLIT-UI.md), MIT */
import { useReducedMotion } from "motion/react";
import { useCallback, useMemo } from "react";
import { cn } from "@/lib/utils";
import { AreaSparkline } from "../bklit/charts/sparkline";
import { type ChartColor, drawn } from "./chart-data";

export interface SparklineProps {
  className?: string;
  /**
   * The vertical scale: from the lowest to the highest value (`range`, the default: a mean that moves little still has
   * a shape), or from zero (`zero`: a sum, whose drawing must not invent a fall).
   */
  domain?: "range" | "zero";
  /** The color of the series: a token of the chart palette. The ink (`--chart-line-primary`) when absent. */
  color?: ChartColor;
  /** The height of the drawing in pixels. */
  height?: number;
  /**
   * The point the pointer or the finger reads, or null: with `onRead`, the sparkline reads (crosshair and dot on the
   * point under the pointer) and the caller writes what the point says; the caller also moves it with the keyboard.
   */
  onRead?: (index: number | null) => void;
  /** The point read now (the caller's state), with `onRead`. */
  readIndex?: number | null;
  /** Drawn finished, with no entrance and with the reading jumping (a phone, v7 § 7, and reduced motion). */
  still?: boolean;
  /** The values in order, one per day. Nothing is drawn without any. */
  values: readonly number[];
  /** A fixed width in pixels, for a test or a static page; measured from the box when absent. */
  width?: number;
}

/**
 * The miniature of a series inside a card with a number: Bklit UI's `AreaSparkline` (its entrance, a fill that fades to
 * nothing, a dot on the last value), with no axis, no grid and no focus. It is `aria-hidden`: the number beside it is
 * the information, and a screen reader hears that, not a drawing it cannot read. With `onRead` the pointer and the
 * finger read a point (the recipe "KPI sparklines"): the card writes the point read; its keyboard control is the
 * card's. `prefers-reduced-motion: reduce` (and `still`) turns the entrance, the morph and the spring off.
 */
export function Sparkline({
  className,
  color,
  domain = "range",
  height = 32,
  onRead,
  readIndex,
  still = false,
  values,
  width,
}: SparklineProps) {
  const reduced = useReducedMotion() === true || still;
  // the data follow the content of the values, not the identity of the array a screen builds on each render
  const signature = values.join();
  const data = useMemo(
    () => values.map((value) => ({ value: drawn(value) })),
    [signature]
  );
  const read = useCallback((index: number | null) => onRead?.(index), [onRead]);
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
        hoverTransition={!reduced}
        interactive={onRead !== undefined}
        {...(onRead
          ? { hoverIndex: readIndex ?? null, onHoverChange: read }
          : {})}
        {...(domain === "zero" ? { yDomain: [0] as [number] } : {})}
        width={width}
      />
    </span>
  );
}
