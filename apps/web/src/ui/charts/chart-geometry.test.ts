import { describe, expect, it } from "vitest";
import {
  bestIndex,
  type ChartDatum,
  chartLayout,
  chartScale,
  estimateLabelWidth,
  labelIndexes,
  nearestIndex,
  niceStep,
  wantedLabels,
} from "./chart-geometry";

const MARGIN = { bottom: 24, left: 40, right: 8, top: 8 };
const BOX = { height: 180, maxLines: 4, margin: MARGIN, width: 328 };

const days = (values: number[]): ChartDatum[] =>
  values.map((value, index) => ({
    label: `${String(index + 1).padStart(2, "0")}/10`,
    value,
  }));

const FLOOR = BOX.height - MARGIN.bottom;
const MOVE_TO = /M/g;
const NOT_A_NUMBER = /NaN/;
const PATH_START = /^M/;

describe("niceStep", () => {
  it.each([
    [1840, 1000],
    [1500, 500],
    [1501, 1000],
    [300, 100],
    [301, 200],
    [740, 250],
    [7.2, 2.5],
    [0.9, 0.5],
    [30, 10],
    [31, 20],
  ])("makes 3 lines reach %d with a step of %d", (max, step) => {
    expect(niceStep(max, 3)).toBeCloseTo(step, 9);
  });

  it("is 0 when there is nothing above the floor to reach", () => {
    expect(niceStep(0, 3)).toBe(0);
    expect(niceStep(-5, 3)).toBe(0);
    expect(niceStep(Number.NaN, 3)).toBe(0);
    expect(niceStep(100, 0)).toBe(0);
  });

  it("always reaches the maximum with the lines it makes", () => {
    for (let max = 0.1; max < 1_000_000; max *= 1.37) {
      expect(niceStep(max, 3) * 3).toBeGreaterThanOrEqual(max - 1e-9);
    }
  });
});

describe("chartScale", () => {
  it.each([
    // max, lines, step, top
    [1841, 2, 1000, 2000],
    [999, 2, 500, 1000],
    [1000, 2, 500, 1000],
    [10_500, 3, 5000, 15_000],
    [740, 3, 250, 750],
    [500, 2, 250, 500],
    [2_500_000, 3, 1_000_000, 3_000_000],
  ])(
    "a maximum of %d has %d lines of %d and a top of %d",
    (max, lines, step, top) => {
      const scale = chartScale(max, 4);
      expect(scale.lines).toBe(lines);
      expect(scale.step).toBeCloseTo(step, 6);
      expect(scale.top).toBeCloseTo(top, 6);
    }
  );

  it("is no lines and a top of 1 for a series of zeros, and the maximum at the top without grid", () => {
    expect(chartScale(0, 4)).toEqual({ lines: 0, step: 0, top: 1 });
    expect(chartScale(Number.NaN, 4)).toEqual({ lines: 0, step: 0, top: 1 });
    expect(chartScale(40, 0)).toEqual({ lines: 0, step: 0, top: 40 });
    expect(chartScale(0, 0)).toEqual({ lines: 0, step: 0, top: 1 });
  });

  it("a constant series (all 500) has its line at the top of two lines, not in a third that is empty", () => {
    expect(chartScale(500, 4)).toMatchObject({ lines: 2, top: 500 });
  });

  it("draws two to four lines, reaches the maximum and fills at least two thirds of the height", () => {
    const counts = new Set<number>();
    let below70 = 0;
    for (let max = 0.1; max < 10_000_000; max *= 1.0007) {
      const { lines, top } = chartScale(max, 4);
      counts.add(lines);
      expect(lines).toBeGreaterThanOrEqual(2);
      expect(lines).toBeLessThanOrEqual(4);
      expect(top).toBeGreaterThanOrEqual(max - 1e-9);
      expect(max / top).toBeGreaterThanOrEqual(2 / 3 - 1e-9);
      if (max / top < 0.7) {
        below70 += 1;
        // only a maximum just above 1 or 2 times a power of ten (1.00 to 1.045 and 2.00 to 2.095)
        const mantissa = max / 10 ** Math.floor(Math.log10(max));
        expect(
          (mantissa >= 1 && mantissa < 1.05) ||
            (mantissa >= 2 && mantissa < 2.1)
        ).toBe(true);
      }
    }
    expect([...counts].sort((a, b) => a - b)).toEqual([2, 3, 4]);
    // the two bands of the doc of `chartScale` exist: the nice steps cannot give 70% there
    expect(below70).toBeGreaterThan(0);
  });

  it("never draws more lines than it is given", () => {
    expect(chartScale(1841, 2).lines).toBe(2);
    expect(chartScale(740, 2)).toMatchObject({ lines: 2, top: 1000 });
  });
});

describe("labelIndexes", () => {
  it("labels every point of a short series, and a week whole on a wide chart", () => {
    expect(labelIndexes(3, 4)).toEqual([0, 1, 2]);
    expect(labelIndexes(5, 4)).toEqual([0, 1, 2, 3, 4]);
    expect(labelIndexes(7, 6)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(labelIndexes(1, 4)).toEqual([0]);
    expect(labelIndexes(0, 4)).toEqual([]);
  });

  it("keeps the first, the last and the ones between at an even step", () => {
    expect(labelIndexes(7, 4)).toEqual([0, 2, 4, 6]);
    expect(labelIndexes(30, 4)).toEqual([0, 10, 20, 29]);
    expect(labelIndexes(30, 6)).toEqual([0, 6, 12, 18, 24, 29]);
  });

  it("never glues the last label to the one before it", () => {
    // 8 points at a step of 3: 0, 3, 6 and 7 would stick, so 6 gives way
    expect(labelIndexes(8, 4)).toEqual([0, 3, 7]);
    expect(labelIndexes(14, 6)).toEqual([0, 3, 6, 9, 13]);
  });

  it("starts on the first point, ends on the last, rises and never has two labels side by side on a long series", () => {
    for (let count = 0; count < 120; count += 1) {
      for (const want of [4, 6]) {
        const indexes = labelIndexes(count, want);
        expect(indexes).toEqual([...new Set(indexes)].sort((a, b) => a - b));
        expect(indexes.length).toBeLessThanOrEqual(want + 1);
        if (count > 0) {
          expect(indexes[0]).toBe(0);
          expect(indexes.at(-1)).toBe(count - 1);
        }
        if (count > want + 1) {
          const gaps = indexes
            .slice(1)
            .map((index, at) => index - (indexes[at] as number));
          expect(Math.min(...gaps)).toBeGreaterThan(1);
        }
      }
    }
  });

  it("asks for 4 labels on a phone and 6 on a wide chart", () => {
    expect(wantedLabels(328)).toBe(4);
    expect(wantedLabels(1100)).toBe(6);
  });
});

describe("estimateLabelWidth", () => {
  it("is the width of the longest label", () => {
    expect(estimateLabelWidth(["0", "1 mil", "R$ 2 mil"], 11)).toBe(
      Math.ceil(8 * 11 * 0.58)
    );
    expect(estimateLabelWidth([], 11)).toBe(0);
  });
});

describe("chartLayout: a series of seven days", () => {
  const data = days([120, 340, 90, 1840, 760, 0, 520]);
  const layout = chartLayout(data, BOX);

  it("puts the points evenly from the left margin to the right one", () => {
    expect(layout.points).toHaveLength(7);
    expect(layout.points[0]?.x).toBe(MARGIN.left);
    expect(layout.points[6]?.x).toBe(BOX.width - MARGIN.right);
    const gaps = layout.points
      .slice(1)
      .map((point, index) => point.x - (layout.points[index]?.x ?? 0));
    for (const gap of gaps) {
      expect(gap).toBeCloseTo(gaps[0] as number, 9);
    }
  });

  it("scales to two nice lines that the series fills, and draws the zero day on the floor", () => {
    expect(layout.ticks.map((tick) => tick.value)).toEqual([1000, 2000]);
    expect(layout.top).toBe(2000);
    expect(layout.floor).toBe(FLOOR);
    expect(layout.points[5]?.y).toBe(FLOOR);
    expect(layout.ticks[1]?.y).toBe(MARGIN.top);
    const highest = layout.points[3]?.y as number;
    expect(highest).toBeLessThan(FLOOR);
    expect(highest).toBeCloseTo(
      FLOOR - (1840 / 2000) * (FLOOR - MARGIN.top),
      9
    );
  });

  it("draws a grid line for each tick and for the floor", () => {
    expect(layout.grid.match(MOVE_TO)).toHaveLength(3);
  });

  it("has the line, the area and the best day", () => {
    expect(layout.line).toMatch(PATH_START);
    expect(layout.area).toMatch(PATH_START);
    expect(layout.bestIndex).toBe(3);
    expect(layout.labelIndexes).toEqual([0, 2, 4, 6]);
  });

  it("never draws a curve outside the box (monotone: no overshoot between two days)", () => {
    const numbers = (layout.line ?? "")
      .match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g)
      ?.map(Number) as number[];
    const ys = numbers.filter((_, index) => index % 2 === 1);
    // every control point stays between the highest and the lowest measured point
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(
      Math.min(...layout.points.map((point) => point.y)) - 1e-6
    );
    expect(Math.max(...ys)).toBeLessThanOrEqual(FLOOR + 1e-6);
  });
});

describe("chartLayout: the edges", () => {
  it("an empty series draws only the floor", () => {
    const layout = chartLayout([], BOX);
    expect(layout.points).toEqual([]);
    expect(layout.line).toBeNull();
    expect(layout.area).toBeNull();
    expect(layout.ticks).toEqual([]);
    expect(layout.bestIndex).toBeNull();
    expect(layout.labelIndexes).toEqual([]);
    expect(layout.grid.match(MOVE_TO)).toHaveLength(1);
  });

  it("a single point has no line or area and sits in the middle", () => {
    const layout = chartLayout(days([500]), BOX);
    expect(layout.points).toHaveLength(1);
    expect(layout.points[0]?.x).toBe(
      MARGIN.left + (BOX.width - MARGIN.left - MARGIN.right) / 2
    );
    expect(layout.line).toBeNull();
    expect(layout.area).toBeNull();
    expect(layout.bestIndex).toBeNull();
    expect(layout.ticks.map((tick) => tick.value)).toEqual([250, 500]);
    expect(layout.labelIndexes).toEqual([0]);
  });

  it("all zero is a line on the floor, with no labeled line above it", () => {
    const layout = chartLayout(days([0, 0, 0, 0, 0, 0, 0]), BOX);
    expect(layout.ticks).toEqual([]);
    expect(layout.points.every((point) => point.y === FLOOR)).toBe(true);
    expect(layout.line).toMatch(PATH_START);
    expect(layout.bestIndex).toBeNull();
    expect(`${layout.line}${layout.area}${layout.grid}`).not.toMatch(
      NOT_A_NUMBER
    );
  });

  it("a constant series is a flat line with no best day", () => {
    const layout = chartLayout(days([500, 500, 500, 500]), BOX);
    const ys = new Set(layout.points.map((point) => point.y));
    expect(ys.size).toBe(1);
    expect((ys.values().next().value as number) < FLOOR).toBe(true);
    expect(layout.ticks.map((tick) => tick.value)).toEqual([250, 500]);
    expect(layout.top).toBe(500);
    expect(layout.bestIndex).toBeNull();
  });

  it("draws a value that is not a number, or is below zero, on the floor", () => {
    const layout = chartLayout(days([Number.NaN, -40, 100, 200]), BOX);
    expect(layout.points[0]?.y).toBe(FLOOR);
    expect(layout.points[1]?.y).toBe(FLOOR);
    expect(`${layout.line}${layout.area}`).not.toMatch(NOT_A_NUMBER);
    // the label keeps the value the caller sent: the text of an amount never comes from the drawing
    expect(layout.points[1]?.value).toBe(-40);
  });

  it("a series of thirty days labels four dates on a phone and six wide", () => {
    const data = days(Array.from({ length: 30 }, (_, index) => index * 10));
    expect(chartLayout(data, BOX).labelIndexes).toEqual([0, 10, 20, 29]);
    expect(chartLayout(data, { ...BOX, width: 1100 }).labelIndexes).toEqual([
      0, 6, 12, 18, 24, 29,
    ]);
  });

  it("without grid lines the top is the maximum (the sparkline)", () => {
    const layout = chartLayout(days([10, 40, 20]), {
      ...BOX,
      maxLines: 0,
      margin: { bottom: 4, left: 4, right: 4, top: 4 },
    });
    expect(layout.ticks).toEqual([]);
    expect(layout.top).toBe(40);
    expect(layout.points[1]?.y).toBe(4);
    expect(layout.points[0]?.y).toBeGreaterThan(4);
  });
});

describe("bestIndex", () => {
  it("is the first of the highest values", () => {
    expect(bestIndex(days([1, 9, 3, 9]))).toBe(1);
  });

  it("is none for fewer than two points, all zero or all equal", () => {
    expect(bestIndex(days([]))).toBeNull();
    expect(bestIndex(days([5]))).toBeNull();
    expect(bestIndex(days([0, 0, 0]))).toBeNull();
    expect(bestIndex(days([4, 4, 4]))).toBeNull();
    expect(bestIndex(days([0, 0, 1]))).toBe(2);
  });
});

describe("nearestIndex", () => {
  const layout = chartLayout(days([1, 2, 3, 4, 5]), BOX);
  const first = MARGIN.left;
  const last = BOX.width - MARGIN.right;
  const step = (last - first) / 4;

  it("maps a position to the nearest point and clamps outside the plot", () => {
    expect(nearestIndex(layout, first)).toBe(0);
    expect(nearestIndex(layout, first + step * 1.4)).toBe(1);
    expect(nearestIndex(layout, first + step * 1.6)).toBe(2);
    expect(nearestIndex(layout, last)).toBe(4);
    expect(nearestIndex(layout, -50)).toBe(0);
    expect(nearestIndex(layout, 5000)).toBe(4);
  });

  it("is 0 with fewer than two points", () => {
    expect(nearestIndex(chartLayout([], BOX), 100)).toBe(0);
    expect(nearestIndex(chartLayout(days([3]), BOX), 100)).toBe(0);
  });
});
