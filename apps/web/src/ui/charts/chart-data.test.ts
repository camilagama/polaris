import { describe, expect, it } from "vitest";
import { resolveTimeSeriesYDomain } from "../bklit/charts/y-domain-utils";
import {
  bestIndex,
  chartPoints,
  drawn,
  hasUnknown,
  knownRuns,
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

describe("the scale of two series", () => {
  const domain = (sales: number[], costs: number[]) =>
    resolveTimeSeriesYDomain(
      chartPoints(days(sales), days(costs)),
      ["drawn", "drawnSecondary"],
      undefined
    );

  it("is one scale for both lines: it reaches the highest of the two, from zero", () => {
    // costs above the sales: the sales line is drawn on the scale of the costs, not on a scale of its own
    expect(domain([100, 200], [500, 1000])).toEqual([0, 1000 * 1.1]);
    expect(domain([500, 1000], [100, 200])).toEqual([0, 1000 * 1.1]);
  });

  it("draws a value below zero on the floor, so a negative cost does not pull the scale down", () => {
    expect(domain([100, 200], [-50, 0])).toEqual([0, 200 * 1.1]);
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

describe("a second series with unknown values (AC-9 of the Resultado)", () => {
  const costs = [5, null, 7, null, null, 9, 10, null].map((value, index) => ({
    label: `d${index}`,
    value,
  }));

  it("never gives the blocks a number for an unknown value: no drawn value, the raw one null", () => {
    const points = chartPoints(days([1, 1, 1, 1, 1, 1, 1, 1]), costs);
    for (const [index, point] of points.entries()) {
      if (costs[index]?.value === null) {
        expect(point).not.toHaveProperty("drawnSecondary");
        expect(point.rawSecondary).toBeNull();
      } else {
        expect(typeof point.drawnSecondary).toBe("number");
      }
    }
    // the y domain of the blocks reads only numbers: an unknown day does not pull it to zero nor stretch it
    expect(
      resolveTimeSeriesYDomain(points, ["drawnSecondary"], undefined)
    ).toEqual([0, 10 * 1.1]);
  });

  it("splits the known values into runs, a lone known day being a run of one (drawn as a point)", () => {
    expect(knownRuns(costs)).toEqual([
      { end: 0, start: 0 },
      { end: 2, start: 2 },
      { end: 6, start: 5 },
    ]);
    expect(knownRuns(days([1, 2, 3]))).toEqual([{ end: 2, start: 0 }]);
    expect(knownRuns(costs.map((cost) => ({ ...cost, value: null })))).toEqual(
      []
    );
  });

  it("says when a series has an unknown value, and the highest value skips it", () => {
    expect(hasUnknown(costs)).toBe(true);
    expect(hasUnknown(days([1, 2]))).toBe(false);
    expect(hasUnknown(undefined)).toBe(false);
    expect(seriesMax(costs)).toBe(10);
  });
});
