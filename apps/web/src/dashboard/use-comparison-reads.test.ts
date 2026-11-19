// @vitest-environment happy-dom
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Period } from "./result-period";
import { useComparisonReads } from "./use-period-summary";

const periodSummary = vi.fn();
const dailySales = vi.fn();

vi.mock("../lib/browser-connection", () => ({
  useConnectionOnline: () => true,
}));
vi.mock("../offline/runtime/runtime-context", () => ({
  useRuntimeSnapshot: () => ({ status: "unavailable" }),
}));
vi.mock("../lib/orpc", () => ({
  orpcClient: {
    report: {
      dailySales: (input: unknown) => dailySales(input),
      periodSummary: (input: unknown) => periodSummary(input),
    },
  },
}));
vi.mock("../lib/period-summary-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/period-summary-cache")>()),
  isPeriodSummary: (value: unknown) =>
    typeof value === "object" && value !== null && "daily" in value,
}));

const BEFORE: Period = { from: "2026-09-01", to: "2026-09-03" };
const OTHER: Period = { from: "2026-08-01", to: "2026-08-03" };

const summaryDays = (period: Period) => ({
  daily: [1, 2, 3].map((day) => ({
    costs: "1.00",
    date: `${period.from.slice(0, 8)}0${day}`,
    netSales: `${day * 10}.00`,
    operatingExpenses: "0.00",
    operatingResult: "9.00",
    salesCount: day,
  })),
});

const salesSeries = (period: Period) => ({
  count: [1, 2, 3],
  from: period.from,
  net: ["10.00", "20.00", "30.00"],
});

beforeEach(() => {
  periodSummary.mockReset();
  dailySales.mockReset();
  periodSummary.mockImplementation(({ from, to }: Period) =>
    Promise.resolve(summaryDays({ from, to }))
  );
  dailySales.mockImplementation(({ from, to }: Period) =>
    Promise.resolve(salesSeries({ from, to }))
  );
});

const salesOf = (days: readonly { salesCount: number }[] | undefined) =>
  days?.map((day) => day.salesCount);

describe("useComparisonReads", () => {
  it("reads the period before once with the engine when the result chip can exist, and the sales chips use its days", async () => {
    const { result } = renderHook(() =>
      useComparisonReads("org-a", BEFORE, BEFORE)
    );
    await waitFor(() => expect(result.current.salesComparison).not.toBeNull());
    expect(periodSummary).toHaveBeenCalledTimes(1);
    expect(dailySales).not.toHaveBeenCalled();
    expect(result.current.comparison?.period).toEqual(BEFORE);
    expect(result.current.salesComparison?.period).toEqual(BEFORE);
    expect(salesOf(result.current.salesComparison?.days)).toEqual([1, 2, 3]);
    expect(
      result.current.salesComparison?.days.map((day) => day.netSales)
    ).toEqual(["10.00", "20.00", "30.00"]);
  });

  it("reads dailySales alone, and not the engine, when the result chip cannot exist", async () => {
    const { result } = renderHook(() =>
      useComparisonReads("org-a", BEFORE, null)
    );
    await waitFor(() => expect(result.current.salesComparison).not.toBeNull());
    expect(periodSummary).not.toHaveBeenCalled();
    expect(dailySales).toHaveBeenCalledTimes(1);
    expect(result.current.comparison).toBeNull();
    expect(salesOf(result.current.salesComparison?.days)).toEqual([1, 2, 3]);
  });

  it("falls back to dailySales for the sales chips when the engine's read fails, and the result chip stays out", async () => {
    periodSummary.mockRejectedValue(new Error("engine down"));
    const { result } = renderHook(() =>
      useComparisonReads("org-a", BEFORE, BEFORE)
    );
    await waitFor(() => expect(result.current.salesComparison).not.toBeNull());
    expect(periodSummary).toHaveBeenCalledTimes(1);
    expect(dailySales).toHaveBeenCalledTimes(1);
    expect(result.current.comparison).toBeNull();
  });

  it("falls back to dailySales when the engine answers with something that is not a summary", async () => {
    periodSummary.mockResolvedValue("<html>captive portal</html>");
    const { result } = renderHook(() =>
      useComparisonReads("org-a", BEFORE, BEFORE)
    );
    await waitFor(() => expect(result.current.salesComparison).not.toBeNull());
    expect(dailySales).toHaveBeenCalledTimes(1);
    expect(result.current.comparison).toBeNull();
  });

  it("keeps the sales chips out when both reads fail", async () => {
    periodSummary.mockRejectedValue(new Error("engine down"));
    dailySales.mockRejectedValue(new Error("down"));
    const { result } = renderHook(() =>
      useComparisonReads("org-a", BEFORE, BEFORE)
    );
    await waitFor(() => expect(dailySales).toHaveBeenCalledTimes(1));
    expect(result.current.comparison).toBeNull();
    expect(result.current.salesComparison).toBeNull();
  });

  it("does not carry the failure of one period to another: the next period asks the engine again", async () => {
    periodSummary.mockImplementation(({ from, to }: Period) =>
      from === BEFORE.from
        ? Promise.reject(new Error("engine down"))
        : Promise.resolve(summaryDays({ from, to }))
    );
    const { rerender, result } = renderHook(
      ({ period }: { period: Period }) =>
        useComparisonReads("org-a", period, period),
      { initialProps: { period: BEFORE } }
    );
    await waitFor(() => expect(dailySales).toHaveBeenCalledTimes(1));
    rerender({ period: OTHER });
    await waitFor(() =>
      expect(result.current.comparison?.period).toEqual(OTHER)
    );
    expect(dailySales).toHaveBeenCalledTimes(1);
    expect(result.current.salesComparison?.period).toEqual(OTHER);
  });

  it("does not read dailySales again at the first render of a period that failed before", async () => {
    dailySales.mockRejectedValueOnce(new Error("down"));
    periodSummary.mockImplementation(({ from, to }: Period) =>
      from === BEFORE.from
        ? Promise.reject(new Error("engine down"))
        : Promise.resolve(summaryDays({ from, to }))
    );
    const { rerender, result } = renderHook(
      ({ period }: { period: Period }) =>
        useComparisonReads("org-a", period, period),
      { initialProps: { period: BEFORE } }
    );
    await waitFor(() => expect(dailySales).toHaveBeenCalledTimes(1));
    rerender({ period: OTHER });
    await waitFor(() =>
      expect(result.current.comparison?.period).toEqual(OTHER)
    );
    periodSummary.mockImplementation(({ from, to }: Period) =>
      Promise.resolve(summaryDays({ from, to }))
    );
    rerender({ period: BEFORE });
    await waitFor(() =>
      expect(result.current.comparison?.period).toEqual(BEFORE)
    );
    expect(dailySales).toHaveBeenCalledTimes(1);
  });

  it("reads nothing before the screen's own read answered", () => {
    renderHook(() => useComparisonReads("org-a", null, null));
    expect(periodSummary).not.toHaveBeenCalled();
    expect(dailySales).not.toHaveBeenCalled();
  });
});
