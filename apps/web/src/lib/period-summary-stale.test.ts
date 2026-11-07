import { describe, expect, it, vi } from "vitest";
import {
  markPeriodSummaryStale,
  periodSummaryStaleVersion,
  subscribePeriodSummaryStale,
} from "./period-summary-stale";

describe("the writes that leave the result of a period old", () => {
  it("counts each write and tells whoever is subscribed, once per write", () => {
    const listener = vi.fn();
    const stop = subscribePeriodSummaryStale(listener);
    const before = periodSummaryStaleVersion();

    markPeriodSummaryStale();
    markPeriodSummaryStale();

    expect(periodSummaryStaleVersion()).toBe(before + 2);
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
  });

  it("does not tell whoever stopped listening, and does not move without a write", () => {
    const listener = vi.fn();
    subscribePeriodSummaryStale(listener)();
    const before = periodSummaryStaleVersion();

    markPeriodSummaryStale();

    expect(listener).not.toHaveBeenCalled();
    expect(periodSummaryStaleVersion()).toBe(before + 1);
    expect(periodSummaryStaleVersion()).toBe(before + 1);
  });
});
