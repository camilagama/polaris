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
  /** Where a reference mark crosses the ring, from 0 to 1 of the way round (a drawing only: the screen says what it means). */
  marker?: number | undefined;
  /** How much of the ring is done, from 0 to 1; more than 1 is a full ring. */
  progress: number;
  /** The side of the square, in pixels. */
  size: number;
  /** The width of the ring, in pixels. */
  strokeWidth: number;
  /** The color of the track under the arc, a CSS color (the border of the theme when absent). */
  track?: string;
}

/** Where the arc begins, in the radians of d3's arc (0 is 12 o'clock, clockwise): the mark counts from the same point. */
const START_ANGLE = -Math.PI / 2;
/** Beyond the arc on each side, the mark runs this far (the card behind it makes the gap). */
const MARK_OVERSHOOT = 3;
const MARK_GAP = 2;
const MARK_WIDTH = 2;

/**
 * A radial 2 px mark in the text color across the arc, with 2 px of the card on each side of it so it reads on the
 * filled arc and on the track. It does not move.
 */
function RingMarker({
  marker,
  size,
  strokeWidth,
}: {
  marker: number;
  size: number;
  strokeWidth: number;
}) {
  const outer = size / 2 - 8;
  const inner = outer - strokeWidth;
  const angle = START_ANGLE + Math.min(Math.max(marker, 0), 1) * 2 * Math.PI;
  const center = size / 2;
  const point = (radius: number) =>
    `${center + radius * Math.sin(angle)},${center - radius * Math.cos(angle)}`;
  const line = `M${point(inner - MARK_OVERSHOOT)} L${point(outer + MARK_OVERSHOOT)}`;
  return (
    <svg
      aria-hidden="true"
      className="absolute inset-0 overflow-visible"
      data-ring-marker=""
      height={size}
      width={size}
    >
      <path
        d={line}
        fill="none"
        stroke="var(--card)"
        strokeWidth={MARK_WIDTH + 2 * MARK_GAP}
      />
      <path
        d={line}
        fill="none"
        stroke="var(--foreground)"
        strokeWidth={MARK_WIDTH}
      />
    </svg>
  );
}

/**
 * One progress ring (Bklit UI's `RingChart` with one `Ring`), with no center: the screen writes its own text in the
 * hole, so the `ChartStatFlow` of the block (and the `@number-flow/react` it brings) never enters the ring: the percent in the
 * hole is the screen's, plain text. It is `aria-hidden`:
 * the screen says the same in words, in its own summary. No hover (the ring is controlled and never read: no glow and
 * no growing), and below the `full` level of motion (a phone, `prefers-reduced-motion`) it is drawn finished, with no
 * entrance (v7 § 7).
 */
export function RingChart({
  className,
  color,
  marker,
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
      className={cn("pointer-events-none relative block", className)}
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
          startAngle={START_ANGLE}
          strokeWidth={strokeWidth}
        >
          <Ring animate={!still} index={0} showGlow={false} />
        </BklitRingChart>
      </MotionConfig>
      {marker === undefined ? null : (
        <RingMarker marker={marker} size={size} strokeWidth={strokeWidth} />
      )}
    </span>
  );
}
