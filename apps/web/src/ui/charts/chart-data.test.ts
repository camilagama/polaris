import { describe, expect, it } from "vitest";
import {
  bestIndex,
  chartPoints,
  drawn,
  seriesMax,
  yAxisMargin,
} from "./chart-data";

const days = (values: number[]) =>
  values.map((value, index) => ({ label: `d${index}`, value }));

describe("chartPoints", () => {
  it("places one point a day apart, in order, with the caller's text", () => {
    const points = chartPoints(days([1, 2, 3]), undefined);
    const gaps = points.slice(1).map((point, index) => {
      const before = points[index];
      return point.date.getTime() - (before?.date.getTime() ?? 0);
    });
    expect(gaps).toEqual([86_400_000, 86_400_000]);
    expect(points.map((point) => point.label)).toEqual(["d0", "d1", "d2"]);
  });

  it("draws values below zero and unknown ones on the floor and keeps what the caller gave", () => {
    const [negative, unknown, fine] = chartPoints(
      days([-5, Number.NaN, 7]),
      undefined
    );
    expect(negative).toMatchObject({ drawn: 0, raw: -5 });
    expect(unknown?.drawn).toBe(0);
    expect(Number.isNaN(unknown?.raw)).toBe(true);
    expect(fine).toMatchObject({ drawn: 7, raw: 7 });
  });

  it("carries the second series next to the first, point by point", () => {
    const points = chartPoints(days([1, 2]), days([10, -3]));
    expect(points.map((point) => point.drawnSecondary)).toEqual([10, 0]);
    expect(points.map((point) => point.rawSecondary)).toEqual([10, -3]);
    expect(chartPoints(days([1]), undefined)[0]).not.toHaveProperty(
      "drawnSecondary"
    );
  });
});

describe("seriesMax", () => {
  it("is the highest value drawn, zero for an empty or negative series", () => {
    expect(seriesMax(days([3, 9, 4]))).toBe(9);
    expect(seriesMax([])).toBe(0);
    expect(seriesMax(days([-4, -1]))).toBe(0);
  });
});

describe("bestIndex", () => {
  it("is the highest day, the first when two tie", () => {
    expect(bestIndex(days([3, 9, 9, 1]))).toBe(1);
  });

  it("is none for fewer than two points, all zero or all equal", () => {
    expect(bestIndex(days([5]))).toBeNull();
    expect(bestIndex(days([0, 0, 0]))).toBeNull();
    expect(bestIndex(days([4, 4, 4]))).toBeNull();
    expect(bestIndex(days([-1, -2]))).toBeNull();
  });
});

describe("yAxisMargin", () => {
  it("grows with the label so the one with the unit fits", () => {
    expect(yAxisMargin("R$ 12,5 mil")).toBeGreaterThan(yAxisMargin("500"));
    expect(yAxisMargin("")).toBe(16);
  });
});

describe("drawn", () => {
  it("is the value when it is a positive number, the floor for anything else", () => {
    expect(drawn(7.5)).toBe(7.5);
    expect(drawn(0)).toBe(0);
    expect(drawn(-3)).toBe(0);
    expect(drawn(Number.NaN)).toBe(0);
    expect(drawn(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
