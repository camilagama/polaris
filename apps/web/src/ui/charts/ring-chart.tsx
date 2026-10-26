/* Polaris adaptation of the Bklit UI ring chart (the blocks are in src/ui/bklit/, unchanged but for BKLIT-UI.md), MIT */
import { MotionConfig } from "motion/react";
import { useMemo } from "react";
import { useMotionLevel } from "@/lib/motion-level";
import { cn } from "@/lib/utils";
import { Ring } from "../bklit/charts/ring";
import { RingChart as BklitRingChart } from "../bklit/charts/ring-chart";
import type { ChartColor } from "./chart-data";

export interface RingChartProps {
  className?: string;
  /** The color of the arc: a token of the chart palette. */
  color: ChartColor;
  /** How much of the ring is done, from 0 to 1; more than 1 is a full ring. */
  progress: number;
  /** The side of the square, in pixels. */
  size: number;
  /** The width of the ring, in pixels. */
  strokeWidth: number;
  /** The color of the track under the arc, a CSS color (the border of the theme when absent). */
  track?: string;
}

/**
 * One progress ring (Bklit UI's `RingChart` with one `Ring`), with no center: the screen writes its own text in the
 * hole, so the `ChartStatFlow` of the block (and the `@number-flow/react` it brings) never enters. It is `aria-hidden`:
 * the screen says the same in words, in its own summary. No hover (the ring is controlled and never read: no glow and
 * no growing), and below the `full` level of motion (a phone, `prefers-reduced-motion`) it is drawn finished, with no
 * entrance (v7 § 7).
 */
export function RingChart({
  className,
  color,
  progress,
  size,
  strokeWidth,
  track,
}: RingChartProps) {
  const still = useMotionLevel() !== "full";
  const share = Math.min(Math.max(progress, 0), 1);
  const data = useMemo(
    () => [{ color, label: "progress", maxValue: 1, value: share }],
    [color, share]
  );
  return (
    <span
      aria-hidden="true"
      className={cn("pointer-events-none block", className)}
      data-ring-chart=""
      // the block draws the track in `--border`: here it is the color the screen asks for, only inside the ring
      style={
        {
          height: size,
          width: size,
          ...(track ? { "--border": track } : {}),
        } as React.CSSProperties
      }
    >
      <MotionConfig reducedMotion={still ? "always" : "user"}>
        <BklitRingChart
          // the padding of 8 px of the block is around the ring: the ring of `size` fills the square
          baseInnerRadius={size / 2 - 8 - strokeWidth}
          data={data}
          hoveredIndex={null}
          ringGap={0}
          size={size}
          strokeWidth={strokeWidth}
        >
          <Ring animate={!still} index={0} showGlow={false} />
        </BklitRingChart>
      </MotionConfig>
    </span>
  );
}
