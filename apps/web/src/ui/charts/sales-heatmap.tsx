/* Polaris adaptation of the Bklit UI heatmap chart (the blocks are in src/ui/bklit/, unchanged but for BKLIT-UI.md), MIT */
import { MotionConfig } from "motion/react";
import { type PointerEvent, useCallback, useEffect, useMemo } from "react";
import { useMotionLevel } from "@/lib/motion-level";
import { cn } from "@/lib/utils";
import { HeatmapCells } from "../bklit/charts/heatmap/heatmap-cells";
import { HeatmapChart } from "../bklit/charts/heatmap/heatmap-chart";
import type { HeatmapLevelStyles } from "../bklit/charts/heatmap/heatmap-colors";
import {
  type HeatmapColumn,
  useHeatmap,
  useHeatmapInteraction,
} from "../bklit/charts/heatmap/heatmap-context";

/** A day of the map: its level (0 to 4) and whether it is known (a day still to come is drawn as nothing). */
export interface HeatmapDay {
  date: string;
  known: boolean;
  level: 0 | 1 | 2 | 3 | 4;
}

export interface SalesHeatmapProps {
  /** The index of the best day: a contour in ink. */
  best: number | null;
  /** The side of a cell and the gap between two, in pixels (16 and 3 from 760 px, 18 and 4 on a phone). */
  cell: number;
  className?: string;
  /** `weeks` × 7 days from a Sunday, week after week (a column per week, Sunday on top). */
  days: readonly HeatmapDay[];
  /** The day read now (the pointer, the finger or the keyboard): a contour in the color of the focus. */
  focus: number | null;
  gap: number;
  /**
   * The day under the pointer, or null when it leaves the map; a finger reads the day it touches (`touch` true), and
   * its leaving, which comes as soon as it lifts, is the caller's to keep or not.
   */
  onRead: (index: number | null, touch?: boolean) => void;
  /** Drawn finished, with no entrance of the cells (a phone, v7 § 7, and reduced motion). */
  still?: boolean;
  /** The index of today: a dashed contour. */
  today: number;
}

/** The levels: 0 draws no fill (the day with no sale is an outline, drawn by `Marks`), 1 to 4 the green ramp. */
const LEVELS: HeatmapLevelStyles = [
  { color: "transparent", fillMode: "solid", pattern: "none" },
  { color: "var(--chart-heat-1)", fillMode: "solid", pattern: "none" },
  { color: "var(--chart-heat-2)", fillMode: "solid", pattern: "none" },
  { color: "var(--chart-heat-3)", fillMode: "solid", pattern: "none" },
  { color: "var(--chart-heat-4)", fillMode: "solid", pattern: "none" },
];

/** Room for the months above and the initials of the weekdays on the left; 2 px around for the contours. */
const MARGIN = { bottom: 2, left: 20, right: 2, top: 18 };

const MONTHS = [
  "jan",
  "fev",
  "mar",
  "abr",
  "mai",
  "jun",
  "jul",
  "ago",
  "set",
  "out",
  "nov",
  "dez",
] as const;

/** Monday, Wednesday and Friday, as the calendar of pt-BR names them. */
const WEEKDAY_LABELS = [
  [1, "S"],
  [3, "Q"],
  [5, "S"],
] as const;

const localDate = (day: string) =>
  new Date(
    Number(day.slice(0, 4)),
    Number(day.slice(5, 7)) - 1,
    Number(day.slice(8, 10))
  );

/** The columns of the block: one per week, a bin per weekday whose count is the level. */
function columnsOf(days: readonly HeatmapDay[]): HeatmapColumn[] {
  const columns: HeatmapColumn[] = [];
  for (let start = 0; start < days.length; start += 7) {
    columns.push({
      bin: start / 7,
      bins: days.slice(start, start + 7).map((day, row) => ({
        bin: row,
        count: day.known ? day.level : 0,
        date: localDate(day.date),
      })),
    });
  }
  return columns;
}

/** Where the block draws the cell of a day (the geometry of `HeatmapRect` of visx). */
function useCellBox() {
  const { binHeight, binWidth, gap, xScale, yScale } = useHeatmap();
  return (index: number) => ({
    height: binHeight - gap,
    width: binWidth - gap,
    x: xScale(Math.floor(index / 7)),
    y: yScale(index % 7) + gap,
  });
}

/**
 * The marks that are ours, over the cells: the outline of a known day with no sale (a shape, not only a color), the
 * best day in ink, today dashed and the day read. Inside the drawing, which is `aria-hidden`: the same is in words in
 * the reading and in the table.
 */
function Marks({
  best,
  days,
  focus,
  today,
}: Pick<SalesHeatmapProps, "best" | "days" | "focus" | "today">) {
  const box = useCellBox();
  const ring = (index: number, className: string, key: string) => {
    const cell = box(index);
    return (
      <rect
        className={cn("fill-none", className)}
        height={cell.height + 4}
        key={key}
        rx={4}
        width={cell.width + 4}
        x={cell.x - 2}
        y={cell.y - 2}
      />
    );
  };
  return (
    <g data-heatmap-marks="" pointerEvents="none">
      {days.map((day, index) => {
        if (!day.known || day.level !== 0) {
          return null;
        }
        const cell = box(index);
        return (
          <rect
            className="fill-none stroke-input"
            data-heatmap-empty=""
            height={cell.height - 1}
            key={day.date}
            rx={2.5}
            strokeWidth={1}
            width={cell.width - 1}
            x={cell.x + 0.5}
            y={cell.y + 0.5}
          />
        );
      })}
      {ring(
        today,
        "stroke-foreground [stroke-dasharray:2_2] stroke-[1.5]",
        "today"
      )}
      {best === null ? null : ring(best, "stroke-foreground stroke-2", "best")}
      {focus === null || focus === best
        ? null
        : ring(focus, "stroke-ring stroke-2", "focus")}
    </g>
  );
}

/** The months above their first week and the initials of Monday, Wednesday and Friday on the left. */
function Labels({ days }: { days: readonly HeatmapDay[] }) {
  const { binHeight, gap, margin, xScale, yScale } = useHeatmap();
  const months: { label: string; x: number }[] = [];
  for (let start = 0; start < days.length; start += 7) {
    const first = days
      .slice(start, start + 7)
      .find((day) => day.date.endsWith("-01"));
    const x = xScale(start / 7);
    // a month that starts too close to the label before it (the first week) gives up its label
    if (first && x - (months.at(-1)?.x ?? Number.NEGATIVE_INFINITY) >= 24) {
      months.push({
        label: MONTHS[Number(first.date.slice(5, 7)) - 1] ?? "",
        x,
      });
    }
  }
  return (
    <g className="fill-muted-foreground text-[11px] tabular-nums">
      {months.map((month) => (
        <text key={month.x} x={month.x} y={-6}>
          {month.label}
        </text>
      ))}
      {WEEKDAY_LABELS.map(([row, label]) => (
        <text
          dominantBaseline="central"
          key={row}
          x={-margin.left}
          y={yScale(row) + gap + (binHeight - gap) / 2}
        >
          {label}
        </text>
      ))}
    </g>
  );
}

/** Tells the caller the day under the pointer or the finger (the block keeps which cell it is in). */
function ReadBridge({
  days,
  onRead,
}: Pick<SalesHeatmapProps, "days" | "onRead">) {
  const { hoveredCell } = useHeatmapInteraction();
  const index =
    hoveredCell === null ? null : hoveredCell.column * 7 + hoveredCell.row;
  const known = index !== null && days[index]?.known === true;
  useEffect(() => {
    onRead(known ? index : null);
  }, [index, known, onRead]);
  return null;
}

/**
 * The map of the Início: Bklit UI's `HeatmapChart` with its cells (the entrance of 1 600 ms with the cells coming in a
 * wave, on the `full` level only), a cell of a fixed size, Sunday on top, the four levels of the green ramp and our
 * marks over it. No tooltip and no dimming of the other cells: the reading line above the map is the panel of the day,
 * and it changes at once. The drawing is `aria-hidden` (the block's `svg`); the summary, the reading, the keyboard and
 * the table are the screen's.
 */
export function SalesHeatmap({
  best,
  cell,
  className,
  days,
  focus,
  gap,
  onRead,
  still: drawnFinished = false,
  today,
}: SalesHeatmapProps) {
  const still = useMotionLevel() !== "full" || drawnFinished;
  const signature = days.map((day) => `${day.date}${day.level}`).join();
  const data = useMemo(() => columnsOf(days), [signature]);
  // a finger enters and leaves a cell in the same batch of React (continuous events): the block's hover never shows
  // it, so the touch reads the cell under it on its own `pointerdown`, from the grid of the drawing
  const touched = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const svg = event.currentTarget.querySelector("svg");
      if (event.pointerType !== "touch" || !svg) {
        return;
      }
      const box = svg.getBoundingClientRect();
      const step = cell + gap;
      const column = Math.floor(
        (event.clientX - box.left - MARGIN.left) / step
      );
      const row = Math.floor(
        (event.clientY - box.top - MARGIN.top - gap) / step
      );
      const index = column * 7 + row;
      if (column >= 0 && row >= 0 && row < 7 && days[index]?.known === true) {
        onRead(index, true);
      }
    },
    [cell, days, gap, onRead]
  );
  return (
    <div
      className={cn("w-full", className)}
      data-chart=""
      data-heatmap=""
      onPointerDown={touched}
    >
      <MotionConfig reducedMotion={still ? "always" : "user"}>
        <HeatmapChart
          animate={!still}
          {...(still ? { animationDuration: 0 } : {})}
          binSize={cell + gap}
          data={data}
          gap={gap}
          layout="fluid"
          levelStyles={LEVELS}
          margin={MARGIN}
          weekStartDay={0}
        >
          <HeatmapCells
            cornerRadius={3}
            hideGhostCells={false}
            inactiveOpacity={1}
          />
          <Marks best={best} days={days} focus={focus} today={today} />
          <Labels days={days} />
          <ReadBridge days={days} onRead={onRead} />
        </HeatmapChart>
      </MotionConfig>
    </div>
  );
}
