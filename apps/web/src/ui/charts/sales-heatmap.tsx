/* Polaris adaptation of the Bklit UI heatmap chart (the blocks are in src/ui/bklit/, unchanged but for BKLIT-UI.md), MIT */
import { MotionConfig } from "motion/react";
import {
  type PointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import { TooltipBox } from "../bklit/charts/tooltip/tooltip-box";
import { TooltipHeader } from "../bklit/charts/tooltip/tooltip-content";
import { useDelayedTooltipData } from "../bklit/charts/tooltip/use-delayed-tooltip-data";

/** A day of the map: its level (0 to 4) and whether it is known (a day still to come is drawn as nothing). */
export interface HeatmapDay {
  date: string;
  known: boolean;
  level: 0 | 1 | 2 | 3 | 4;
}

/** What the tooltip says of the day read: its title, a label and a value per row, and a note ("melhor dia", "hoje"). */
export interface HeatmapTip {
  note: string | null;
  rows: readonly { label: string; value: string }[];
  title: string;
}

export interface SalesHeatmapProps {
  /** The index of the best day: a contour in ink. */
  best: number | null;
  /** The side of a cell and the gap between two, in pixels (12 and 3). */
  cell: number;
  className?: string;
  /** `weeks` × 7 days from a Sunday, week after week (a column per week, Sunday on top). */
  days: readonly HeatmapDay[];
  /** The day read now (the pointer, the finger or the keyboard): a contour in the color of the focus and the tooltip. */
  focus: number | null;
  gap: number;
  /**
   * The day under the pointer, or null when it leaves the map; a finger reads the day it touches (`touch` true), and
   * its leaving, which comes as soon as it lifts, is the caller's to keep or not.
   */
  onRead: (index: number | null, touch?: boolean) => void;
  /** Drawn finished, with no entrance of the cells (a phone, v7 § 7, and reduced motion). */
  still?: boolean;
  /** What the tooltip says of the `focus` day (already masked when the values are hidden), or null: no tooltip. */
  tip: HeatmapTip | null;
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
const MARGIN = { bottom: 2, left: 20, right: 2, top: 16 };

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
    <g className="fill-muted-foreground text-[0.6875rem] tabular-nums">
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

const TOOLTIP_OFFSET = 12;
/** The width `TooltipBox` assumes for a panel it has not measured yet. */
const TOOLTIP_UNMEASURED_WIDTH = 180;

/**
 * Where the panel goes in the map, from the width it was measured at: beside the cell on the side with room (what
 * `TooltipBox` does on its own), and, when neither side has room (a middle column on a phone), over the map with its
 * edges inside it, centered on the cell as far as the edges allow. `TooltipBox` only picks a side and never limits the
 * left, so this is done by the position it is given: with `flipX` out of reach the panel opens to the right of `x`. The
 * width is the panel's own (`w-max` on the content): a panel placed near the right edge would be measured shrunk to the
 * room it has there, and the next day's panel placed by that width.
 */
export function panelPlacement({
  containerWidth,
  panelWidth,
  x,
}: {
  containerWidth: number;
  panelWidth: number;
  x: number;
}): { flipX?: number; x: number } {
  const fitsRight = x + TOOLTIP_OFFSET + panelWidth <= containerWidth;
  const fitsLeft = x - TOOLTIP_OFFSET - panelWidth >= 0;
  if (fitsRight || fitsLeft) {
    return { x };
  }
  const left = Math.max(
    0,
    Math.min(x - panelWidth / 2, containerWidth - panelWidth)
  );
  return { flipX: Number.NEGATIVE_INFINITY, x: left - TOOLTIP_OFFSET };
}

/**
 * The tooltip of the day read, from the pointer, the finger or the keyboard alike: the panel of Bklit UI's `TooltipBox`
 * over the cell of `focus`, opening on the side with room. It sits inside the drawing, which is `aria-hidden`: the same
 * words are in the `aria-valuetext` of the keyboard control and in the table.
 */
function DayTooltip({
  focus,
  instant,
  tip,
}: Pick<SalesHeatmapProps, "focus" | "tip"> & { instant: boolean }) {
  const { binHeight, binWidth, containerRef, gap, height, margin, width } =
    useHeatmap();
  const box = useCellBox();
  const cell = focus === null ? null : box(focus);
  const x = cell === null ? 0 : margin.left + cell.x + (binWidth - gap) / 2;
  const y = cell === null ? 0 : margin.top + cell.y + (binHeight - gap) / 2;
  // the delayed hook compares by identity: a target rebuilt on every render would never settle
  const target = useMemo(
    () => (focus === null || tip === null ? null : { focus, tip, x, y }),
    [focus, tip, x, y]
  );
  const shown = useDelayedTooltipData(target, 0, instant ? 0 : undefined);
  const content = useRef<HTMLDivElement>(null);
  const [panelWidth, setPanelWidth] = useState(TOOLTIP_UNMEASURED_WIDTH);
  useLayoutEffect(() => {
    const panel = content.current?.closest<HTMLElement>(
      ".pointer-events-none.absolute"
    );
    const measured = panel?.offsetWidth ?? 0;
    if (measured > 0) {
      setPanelWidth(measured);
    }
  }, [shown]);
  const placement = panelPlacement({
    containerWidth: width,
    panelWidth,
    x: shown?.x ?? 0,
  });
  return (
    <TooltipBox
      animate={!instant}
      containerHeight={height}
      containerRef={containerRef}
      containerWidth={width}
      entrance={!instant}
      exit={!instant}
      flipX={placement.flipX}
      offset={TOOLTIP_OFFSET}
      visible={shown !== null}
      x={placement.x}
      y={shown?.y ?? 0}
    >
      {shown && (
        <div className="w-max" data-heatmap-tooltip="" ref={content}>
          <TooltipHeader>{shown.tip.title}</TooltipHeader>
          <div className="grid gap-1 px-3.5 py-3 text-sm">
            <dl className="grid gap-1">
              {shown.tip.rows.map((row) => (
                <div className="flex justify-between gap-6" key={row.label}>
                  <dt className="text-chart-tooltip-muted">{row.label}</dt>
                  <dd className="font-medium tabular-nums">{row.value}</dd>
                </div>
              ))}
            </dl>
            {shown.tip.note ? (
              <p className="text-chart-tooltip-muted text-xs">
                {shown.tip.note}
              </p>
            ) : null}
          </div>
        </div>
      )}
    </TooltipBox>
  );
}

/**
 * The map of the Início: Bklit UI's `HeatmapChart` with its cells (the entrance of 1 600 ms with the cells coming in a
 * wave, on the `full` level only), a cell of a fixed size, Sunday on top, the four levels of the green ramp and our
 * marks over it. The value of a day is in a tooltip over its cell (no dimming of the other cells), and a finger reads
 * the cell nearest to it and follows it as it drags. The drawing is `aria-hidden` (the block's `svg`); the summary, the
 * keyboard and the table are the screen's.
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
  tip,
  today,
}: SalesHeatmapProps) {
  const still = useMotionLevel() !== "full" || drawnFinished;
  const signature = days.map((day) => `${day.date}${day.level}`).join();
  const data = useMemo(() => columnsOf(days), [signature]);
  // a finger enters and leaves a cell in the same batch of React (continuous events): the block's hover never shows
  // it, so the touch reads on its own `pointerdown` and `pointermove`, from the grid of the drawing: the cell nearest to
  // the finger, because a cell of 12 px is smaller than a fingertip
  const touched = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const svg = event.currentTarget.querySelector("svg");
      if (event.pointerType !== "touch" || !svg) {
        return;
      }
      const box = svg.getBoundingClientRect();
      const step = cell + gap;
      const weeks = Math.floor(days.length / 7);
      const column = Math.max(
        0,
        Math.min(
          weeks - 1,
          Math.floor((event.clientX - box.left - MARGIN.left) / step)
        )
      );
      const row = Math.max(
        0,
        Math.min(
          6,
          Math.floor((event.clientY - box.top - MARGIN.top - gap) / step)
        )
      );
      const index = column * 7 + row;
      if (days[index]?.known === true) {
        onRead(index, true);
      }
    },
    [cell, days, gap, onRead]
  );
  return (
    <div
      className={cn("w-full touch-pan-y", className)}
      data-chart=""
      data-heatmap=""
      onPointerDown={touched}
      onPointerMove={touched}
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
          <DayTooltip focus={focus} instant={still} tip={tip} />
        </HeatmapChart>
      </MotionConfig>
    </div>
  );
}
