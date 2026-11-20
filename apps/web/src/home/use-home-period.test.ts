// @vitest-environment happy-dom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Period } from "../dashboard/result-period";
import type { PeriodSummaryState } from "../dashboard/use-period-summary";
import type { StoredPeriodSummary } from "../lib/period-summary-cache";
import { type HomeSelection, THIS_MONTH } from "./home-period";
import { useHomePeriod } from "./use-home-period";

const ORG = "org-a";
const ZONE = "America/Sao_Paulo";
const DEVICE_TODAY = "2026-10-14";
const SERVER_NOW = "2026-10-14T15:00:00.000Z";
const SEPTEMBER: Period = { from: "2026-09-01", to: "2026-09-30" };
const AUGUST: Period = { from: "2026-08-01", to: "2026-08-31" };
const LAST_MONTH: HomeSelection = { custom: null, preset: "last-month" };

const comparisonReads = vi.fn();
let summaryState: PeriodSummaryState;

vi.mock("../dashboard/use-period-summary", () => ({
  useComparisonReads: (...args: unknown[]) => {
    comparisonReads(...args);
    return { comparison: null, salesComparison: null };
  },
  usePeriodSummary: () => ({ refresh: () => undefined, state: summaryState }),
}));

function datesOf(period: Period): string[] {
  const dates: string[] = [];
  for (
    let day = new Date(`${period.from}T00:00:00Z`);
    day <= new Date(`${period.to}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() + 1)
  ) {
    dates.push(day.toISOString().slice(0, 10));
  }
  return dates;
}

function summary(
  period: Period,
  { unknownCostLines = 0 } = {}
): StoredPeriodSummary {
  return {
    cards: {
      items: 3,
      marginPercent: "52.69",
      netSales: "130.00",
      operatingResult: "38.50",
      salesCount: 2,
      ticket: "65.00",
    },
    chain: {
      anticipationFees: "0.00",
      cogs: "60.00",
      commercialSurcharges: "5.00",
      contributionMargin: "68.50",
      discounts: "10.00",
      estimatedOperatingResult: "38.50",
      grossProfit: "70.00",
      grossSales: "150.00",
      linkedExpenses: "2.00",
      netSales: "130.00",
      operatingExpenses: "30.00",
      processingFees: "4.50",
      returns: "10.00",
    },
    daily: datesOf(period).map((date) => ({
      costs: "1.00",
      date,
      netSales: "1.00",
      operatingExpenses: "0.00",
      operatingResult: "1.00",
      salesCount: 1,
    })),
    generatedAt: SERVER_NOW,
    period,
    quality: {
      anticipationFeesUnknown: 0,
      itemLines: 2,
      itemLinesWithUnknownCost: unknownCostLines,
      level: "complete",
      linkedExpenses: 1,
      missing: [],
      operatingExpenses: 1,
      processingFeesUnknown: 0,
      salesCount: 2,
    },
  } as StoredPeriodSummary;
}

function answered(value: StoredPeriodSummary | null): PeriodSummaryState {
  return {
    error: null,
    isLoading: false,
    serverFailed: false,
    source: "server",
    summary: value,
  };
}

function run(selection: HomeSelection, today = DEVICE_TODAY) {
  renderHook(() =>
    useHomePeriod({
      enabled: true,
      organizationId: ORG,
      selection,
      timezone: ZONE,
      today,
    })
  );
  return comparisonReads.mock.lastCall;
}

describe("useHomePeriod liga os dois períodos de comparação", () => {
  beforeEach(() => {
    comparisonReads.mockClear();
    summaryState = answered(null);
  });

  it("período escolhido e respondido, com chip de resultado possível: os dois são o mês anterior ao escolhido", () => {
    summaryState = answered(summary(SEPTEMBER));

    expect(run(LAST_MONTH)).toEqual([ORG, AUGUST, AUGUST]);
  });

  it("chip de resultado impossível (todo custo desconhecido): só a leitura de reserva é pedida", () => {
    summaryState = answered(summary(SEPTEMBER, { unknownCostLines: 2 }));

    expect(run(LAST_MONTH)).toEqual([ORG, AUGUST, null]);
  });

  it("Este mês não lê nenhuma comparação", () => {
    summaryState = answered(summary({ from: "2026-10-01", to: "2026-10-14" }));

    expect(run(THIS_MONTH)).toEqual([ORG, null, null]);
  });

  it("enquanto a resposta ainda é a do período anterior à escolha, não lê nenhuma comparação", () => {
    summaryState = answered(summary({ from: "2026-10-01", to: "2026-10-14" }));

    expect(run(LAST_MONTH)).toEqual([ORG, null, null]);
  });

  it("o dia da loja que o servidor devolveu, não o do aparelho, decide a comparação", () => {
    const today = { from: "2026-10-14", to: "2026-10-14" };
    summaryState = answered(summary(today));
    const selection: HomeSelection = { custom: today, preset: "custom" };
    const yesterday = { from: "2026-10-13", to: "2026-10-13" };

    expect(run(selection, "2026-10-13")).toEqual([ORG, yesterday, yesterday]);
  });
});
