/* adapted from Bklit UI (bklit/bklit-ui@3e9af3b), MIT */
import { useId } from "react";
import { cn } from "@/lib/utils";
import { type ChartColor, chartLayout } from "./chart-geometry";
import { useElementWidth } from "./use-element-width";

const MARGIN = { bottom: 4, left: 4, right: 4, top: 4 };

export interface SparklineProps {
  className?: string;
  /** The color of the series: a token of the chart palette. The ink (`--chart-5`) when absent. */
  color?: ChartColor;
  /** The height of the drawing in pixels. */
  height?: number;
  /** The values in order, one per day. Nothing is drawn without any. */
  values: readonly number[];
  /** A fixed width in pixels, for a test or a static page; measured from the box when absent. */
  width?: number;
}

/**
 * The miniature of a series inside a card with a number (Bklit UI adapted): one line, a fill that fades to
 * nothing and a dot on the last value; no axis, no grid, no focus. It is `aria-hidden`: the number beside it is the
 * information, and a screen reader hears that, not a drawing it cannot read.
 */
export function Sparkline({
  className,
  color = "var(--chart-5)",
  height = 32,
  values,
  width: fixedWidth,
}: SparklineProps) {
  const [measure, measuredWidth] = useElementWidth<HTMLSpanElement>();
  const width = fixedWidth ?? measuredWidth;
  const gradient = `spark-fill-${useId().replaceAll(":", "")}`;
  const layout = chartLayout(
    values.map((value) => ({ label: "", value })),
    { height, lines: 0, margin: MARGIN, width }
  );
  const end = layout.points.at(-1);

  return (
    <span
      aria-hidden="true"
      className={cn("block w-full", className)}
      ref={measure}
      style={{ height }}
    >
      {width > 0 && end ? (
        <svg
          className="block animate-rise"
          aria-hidden="true"
          focusable="false"
          height={height}
          width={width}
        >
          <defs>
            <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor={color} stopOpacity={0.3} />
              <stop offset="1" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
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
          <circle cx={end.x} cy={end.y} fill={color} r={3} />
        </svg>
      ) : null}
    </span>
  );
}
