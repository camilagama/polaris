import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STORE_TODAY_TICK_MS, useStoreToday } from "./use-store-today";

const ticks: number[] = [];

vi.mock("../lib/use-now", () => ({
  useNow: (intervalMs: number) => {
    ticks.push(intervalMs);
    return new Date();
  },
}));

function todayAt(instant: string, timezone: string | null): string {
  vi.useRealTimers();
  vi.useFakeTimers({ now: new Date(instant), toFake: ["Date"] });
  function Probe() {
    return <>{useStoreToday(timezone)}</>;
  }
  return renderToStaticMarkup(<Probe />);
}

afterEach(() => {
  vi.useRealTimers();
  ticks.length = 0;
});

describe("useStoreToday", () => {
  it("turns to the new month at midnight of São Paulo, not of the device (UTC is already November)", () => {
    expect(todayAt("2026-11-01T02:50:00Z", "America/Sao_Paulo")).toBe(
      "2026-10-31"
    );
    expect(todayAt("2026-11-01T03:00:00Z", "America/Sao_Paulo")).toBe(
      "2026-11-01"
    );
    expect(todayAt("2026-11-01T02:50:00Z", "UTC")).toBe("2026-11-01");
  });

  it("turns the year at midnight of the store", () => {
    expect(todayAt("2027-01-01T02:50:00Z", "America/Sao_Paulo")).toBe(
      "2026-12-31"
    );
    expect(todayAt("2027-01-01T03:00:00Z", "America/Sao_Paulo")).toBe(
      "2027-01-01"
    );
  });

  it("reads the clock again every minute through useNow, with no request", () => {
    todayAt("2026-11-01T03:30:00Z", "America/Sao_Paulo");
    expect(ticks).toEqual([STORE_TODAY_TICK_MS]);
    expect(STORE_TODAY_TICK_MS).toBe(60_000);
  });
});
