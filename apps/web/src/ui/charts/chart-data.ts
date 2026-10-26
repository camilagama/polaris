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

/**
 * A point of the second series, which may be unknown (`null`: the costs of a day the server could not know, AC-9 of the
 * Resultado). An unknown value is never drawn, never a zero: the day is hatched and the line breaks on it.
 */
export interface SecondaryDatum {
  label: string;
  value: number | null;
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
  /** Absent when the value of the second series is unknown: the blocks never get a number for it. */
  drawnSecondary?: number;
  label: string;
  raw: number;
  /** `null` when the value of the second series is unknown (the reading says so in words). */
  rawSecondary?: number | null;
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
  secondary: readonly SecondaryDatum[] | undefined
): ChartPoint[] {
  return data.map((datum, index) => {
    const second = secondary?.[index];
    const value = second ? second.value : undefined;
    let point: Pick<ChartPoint, "drawnSecondary" | "rawSecondary"> = {};
    if (value === null) {
      point = { rawSecondary: null };
    } else if (value !== undefined) {
      point = { drawnSecondary: drawn(value), rawSecondary: value };
    }
    return {
      date: new Date(Date.UTC(2000, 0, 1) + index * DAY),
      drawn: drawn(datum.value),
      label: datum.label,
      raw: datum.value,
      ...point,
    };
  });
}

/** The highest value a series draws (values below zero count as zero; an unknown one is skipped), 0 for an empty series. */
export function seriesMax(data: readonly { value: number | null }[]): number {
  return data.reduce(
    (max, datum) =>
      datum.value === null ? max : Math.max(max, drawn(datum.value)),
    0
  );
}

/** True when some value of the second series is unknown: the chart then draws it by runs, with the hatch. */
export function hasUnknown(
  data: readonly SecondaryDatum[] | undefined
): boolean {
  return data?.some((datum) => datum.value === null) ?? false;
}

/** A run of known values of the second series: the indexes between `start` and `end`, both in. */
export interface KnownRun {
  end: number;
  start: number;
}

/**
 * The runs of known values, in order (AC-9 of the Resultado, "uma série por trecho contínuo"): each one is drawn as a
 * line of its own, and a run of one day (a known day between two unknown ones) is drawn as a point. The unknown
 * indexes are in no run: nothing is drawn for them but the hatch.
 */
export function knownRuns(data: readonly SecondaryDatum[]): KnownRun[] {
  const runs: KnownRun[] = [];
  let start: number | null = null;
  data.forEach((datum, index) => {
    if (datum.value === null) {
      if (start !== null) {
        runs.push({ end: index - 1, start });
      }
      start = null;
    } else if (start === null) {
      start = index;
    }
  });
  if (start !== null) {
    runs.push({ end: data.length - 1, start });
  }
  return runs;
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
