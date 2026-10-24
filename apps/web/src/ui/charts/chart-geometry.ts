/* adapted from Bklit UI (bklit/bklit-ui@3e9af3b), MIT */
import { path } from "d3-path";
import { area, curveMonotoneX, line } from "d3-shape";

/**
 * The geometry of the charts, pure: numbers in, pixels and SVG paths out. No React, no DOM, no color. What a
 * chart draws is display only: the exact text of an amount comes from the caller (it formats the decimal the
 * server sent), never from here (docs/business-rules/money.md).
 *
 * The curve is `curveMonotoneX` always: it passes only through the measured points and never invents a valley or a
 * peak between two days (a spline or Catmull-Rom does). Values below zero are drawn on the floor and a value that
 * is not a finite number is drawn as zero: the series of the app are sums of days, never negative or unknown.
 */

/** A token of the chart palette (`--chart-1` to `--chart-5` of theme.css): the only way to color a chart. */
export type ChartColor = `var(--chart-${1 | 2 | 3 | 4 | 5})`;

export interface ChartDatum {
  /** The text of the point on the axis and in the reading, already formatted (e.g. "18/10"). */
  label: string;
  value: number;
}

export interface ChartMargin {
  bottom: number;
  left: number;
  right: number;
  top: number;
}

export interface ChartPoint extends ChartDatum {
  x: number;
  y: number;
}

export interface ChartTick {
  value: number;
  y: number;
}

export interface ChartLayout {
  /** The filled shape under the line: null with fewer than two points. */
  area: string | null;
  /** The index of the highest value, null when the series has no best day (see `bestIndex`). */
  bestIndex: number | null;
  /** The y of the floor (the value 0). */
  floor: number;
  /** The horizontal grid lines of the ticks and the floor, as one path. */
  grid: string;
  /** The indexes of the points that have a label on the x axis, first and last included. */
  labelIndexes: number[];
  /** The line of the series: null with fewer than two points. */
  line: string | null;
  margin: ChartMargin;
  points: ChartPoint[];
  /** The labeled grid lines above the floor, nearest first. Empty when the series is empty or all zero. */
  ticks: ChartTick[];
  /** The value at the top of the plot. */
  top: number;
}

export interface ChartLayoutOptions {
  height: number;
  /** How many grid lines above the floor (the area chart has three); 0 draws none and the top is the maximum. */
  lines: number;
  margin: ChartMargin;
  width: number;
}

/** The steps of a "nice" scale: 1, 2, 2.5 or 5 times a power of ten. */
const NICE_STEPS = [1, 2, 2.5, 5, 10];
const EPSILON = 1e-9;

/** A value as the plot draws it: finite and not below zero. */
function plotted(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * The step between grid lines, the smallest nice one that makes `lines` of them reach `max`; 0 when there is
 * nothing above the floor to reach.
 */
export function niceStep(max: number, lines: number): number {
  if (!(max > 0 && lines > 0)) {
    return 0;
  }
  const raw = max / lines;
  const base = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / base;
  const nice = NICE_STEPS.find((step) => fraction <= step + EPSILON) ?? 10;
  return nice * base;
}

/**
 * The points that get a date on the x axis: all of them when they are about as many as fit (`want` and one more, so a
 * week fits whole on a wide chart), else every n-th from the first, with the last one always there and never glued to
 * the one before it (that one is dropped when it is closer than 60% of the step).
 */
export function labelIndexes(count: number, want: number): number[] {
  if (count <= 0) {
    return [];
  }
  if (count <= want + 1) {
    return Array.from({ length: count }, (_, index) => index);
  }
  const last = count - 1;
  const step = Math.ceil(last / (want - 1));
  const indexes: number[] = [];
  for (let index = 0; index < last; index += step) {
    indexes.push(index);
  }
  if (last - (indexes.at(-1) as number) < step * 0.6) {
    indexes.pop();
  }
  indexes.push(last);
  return indexes;
}

/** How many labels fit on the x axis: 4 on a phone, 6 on a wide chart (the labels are about 30 px wide). */
export function wantedLabels(width: number): number {
  return width < 520 ? 4 : 6;
}

/** The width of the widest label of the y axis, in pixels, at the font size of the axis (a Geist digit is 0.58 em). */
export function estimateLabelWidth(
  labels: readonly string[],
  fontSize: number
): number {
  const longest = Math.max(0, ...labels.map((text) => text.length));
  return Math.ceil(longest * fontSize * 0.58);
}

/** The index of the point nearest to a horizontal position (pixels of the chart), clamped into the series. */
export function nearestIndex(layout: ChartLayout, x: number): number {
  const { points } = layout;
  if (points.length < 2) {
    return 0;
  }
  const first = (points[0] as ChartPoint).x;
  const last = (points.at(-1) as ChartPoint).x;
  const step = (last - first) / (points.length - 1);
  if (step <= 0) {
    return 0;
  }
  return Math.min(
    points.length - 1,
    Math.max(0, Math.round((x - first) / step))
  );
}

/**
 * The index of the day to mark as the best one: the highest value, the first when two tie. Null when there is no
 * best (fewer than two points, all zero, or all equal: marking the first of seven equal days says nothing).
 */
export function bestIndex(data: readonly ChartDatum[]): number | null {
  if (data.length < 2) {
    return null;
  }
  const values = data.map((datum) => plotted(datum.value));
  const max = Math.max(...values);
  if (max <= 0 || values.every((value) => value === max)) {
    return null;
  }
  return values.indexOf(max);
}

/** The value at the top of the plot: the last grid line, or the maximum without grid; 1 when everything is zero. */
function topOf(max: number, step: number, lines: number): number {
  if (lines > 0) {
    return step > 0 ? step * lines : 1;
  }
  return max > 0 ? max : 1;
}

/** The layout of a series in a box: where each point is, the paths, the grid and the labels. */
export function chartLayout(
  data: readonly ChartDatum[],
  { height, lines, margin, width }: ChartLayoutOptions
): ChartLayout {
  const values = data.map((datum) => plotted(datum.value));
  const max = Math.max(0, ...values);
  const step = niceStep(max, lines);
  const top = topOf(max, step, lines);

  const floor = height - margin.bottom;
  const innerWidth = Math.max(0, width - margin.left - margin.right);
  const innerHeight = Math.max(0, floor - margin.top);
  const xOf = (index: number) =>
    data.length < 2
      ? margin.left + innerWidth / 2
      : margin.left + (index * innerWidth) / (data.length - 1);
  const yOf = (value: number) => floor - (value / top) * innerHeight;

  const points: ChartPoint[] = data.map((datum, index) => ({
    label: datum.label,
    value: datum.value,
    x: xOf(index),
    y: yOf(values[index] as number),
  }));

  const ticks: ChartTick[] =
    step > 0
      ? Array.from({ length: lines }, (_, index) => {
          const value = step * (index + 1);
          return { value, y: yOf(value) };
        })
      : [];

  const grid = path();
  for (const { y } of [{ y: floor }, ...ticks]) {
    grid.moveTo(margin.left, y);
    grid.lineTo(margin.left + innerWidth, y);
  }

  const curved = data.length >= 2;
  return {
    area: curved
      ? area<ChartPoint>()
          .curve(curveMonotoneX)
          .x((point) => point.x)
          .y0(floor)
          .y1((point) => point.y)(points)
      : null,
    bestIndex: bestIndex(data),
    floor,
    grid: grid.toString(),
    labelIndexes: labelIndexes(data.length, wantedLabels(width)),
    line: curved
      ? line<ChartPoint>()
          .curve(curveMonotoneX)
          .x((point) => point.x)
          .y((point) => point.y)(points)
      : null,
    margin,
    points,
    ticks,
    top,
  };
}
