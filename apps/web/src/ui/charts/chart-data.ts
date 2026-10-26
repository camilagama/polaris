/* Polaris adaptation of the Bklit UI area chart (the blocks are in src/ui/bklit/, unchanged but for BKLIT-UI.md), MIT */

/**
 * What the chart screens hand over, and what the blocks of Bklit UI want: numbers in, points out. No React, no DOM, no
 * color. What a chart draws is display only: the exact text of an amount comes from the caller (it formats the decimal
 * the server sent), never from here (docs/business-rules/money.md).
 *
 * Values below zero are drawn on the floor and a value that is not a finite number is drawn as zero: the series of
 * the app are sums of days, never negative or unknown. The text keeps the value the caller gave.
 */

/**
 * A token of the chart palette of theme.css: the scale `--chart-1` to `--chart-5`, the color of an entity (sales,
 * result, ticket, v7), the grey of a comparison, or the red of a loss (only a negative result). The only way to color
 * a chart.
 */
export type ChartColor =
  | `var(--chart-${1 | 2 | 3 | 4 | 5})`
  | `var(--chart-${"sales" | "result" | "ticket" | "context"})`
  | "var(--destructive)";

export interface ChartDatum {
  /** The text of the point on the axis and in the reading, already formatted (e.g. "18/10"). */
  label: string;
  value: number;
}

/** The margins of the plot, in pixels: the tooltip lives in the 40 px of the top, the dates in the bottom. */
export const MARGIN = { bottom: 32, left: 44, right: 20, top: 40 };
/** What the margins add to the height of the plot, less the 32 px the chart used to keep for them. */
export const EXTRA_HEIGHT = 40;
export const LEFT_MARGIN_MIN = 44;

/** The width a label of the y axis needs (12 px text) and 16 px of air, so it fits in the left margin. */
export function yAxisMargin(text: string): number {
  return Math.ceil(text.length * 6.6) + 16;
}

const DAY = 86_400_000;

/** One point of the chart: the row the blocks of Bklit UI read (`date` for the x scale, `drawn*` for the lines). */
export interface ChartPoint extends Record<string, unknown> {
  date: Date;
  drawn: number;
  drawnSecondary?: number;
  label: string;
  raw: number;
  rawSecondary?: number;
}

export const drawn = (value: number) =>
  Number.isFinite(value) && value > 0 ? value : 0;

/**
 * The points of the series. The blocks place the points by a date; the series of the app are one point per day (or per
 * month, in a long period) at an even step, so the dates are the days after a fixed one and the text of each point is
 * the caller's `label`.
 */
export function chartPoints(
  data: readonly ChartDatum[],
  secondary: readonly ChartDatum[] | undefined
): ChartPoint[] {
  return data.map((datum, index) => {
    const second = secondary?.[index];
    return {
      date: new Date(Date.UTC(2000, 0, 1) + index * DAY),
      drawn: drawn(datum.value),
      label: datum.label,
      raw: datum.value,
      ...(second
        ? { drawnSecondary: drawn(second.value), rawSecondary: second.value }
        : {}),
    };
  });
}

/** The highest value a series draws (values below zero and unknown ones count as zero), 0 for an empty series. */
export function seriesMax(data: readonly ChartDatum[]): number {
  return data.reduce((max, datum) => Math.max(max, drawn(datum.value)), 0);
}

/**
 * The index of the day to mark as the best one: the highest value, the first when two tie. Null when there is no
 * best (fewer than two points, all zero, or all equal: marking the first of seven equal days says nothing).
 */
export function bestIndex(data: readonly ChartDatum[]): number | null {
  if (data.length < 2) {
    return null;
  }
  const values = data.map((datum) => drawn(datum.value));
  const max = Math.max(...values);
  if (max <= 0 || values.every((value) => value === max)) {
    return null;
  }
  return values.indexOf(max);
}
