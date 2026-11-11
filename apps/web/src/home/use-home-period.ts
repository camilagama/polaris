import { useMemo } from "react";
import { comparisonPeriod, resultChipPeriod } from "../dashboard/result-kpis";
import {
  copyMonthOf,
  type Period,
  samePeriod,
} from "../dashboard/result-period";
import {
  type ComparisonDays,
  useComparisonDays,
  useComparisonSales,
  usePeriodSummary,
} from "../dashboard/use-period-summary";
import { calendarDayInTimezone } from "../lib/dates";
import type { PeriodSource } from "./home-kpi-cards";
import {
  type HomeSelection,
  isThisMonth,
  selectionPeriod,
} from "./home-period";

/** Only the comparison of the figures on screen: never the one of a period still loading. */
function onScreen<T extends ComparisonDays<unknown>>(
  comparison: T | null,
  shown: Period,
  today: string
): T | null {
  return samePeriod(comparison?.period ?? null, comparisonPeriod(shown, today))
    ? comparison
    : null;
}

/**
 * The period the person chose on the Início, when it is not "Este mês" (that one is the page's own read, kept with its
 * copy): one read of `periodSummary`, plus the periods before it that the chips compare with, asked only once that read
 * answered (the Resultado's rule). Nothing is read while the selection is "Este mês" or the person cannot read results.
 */
export function useHomePeriod({
  enabled,
  organizationId,
  selection,
  timezone,
  today,
}: {
  enabled: boolean;
  organizationId: string;
  selection: HomeSelection;
  timezone: string;
  /** The store's today: the server's once the figures answered. */
  today: string;
}) {
  const chosen = enabled && !isThisMonth(selection);
  const period = useMemo(
    () => selectionPeriod(selection, today),
    [selection, today]
  );
  const copyMonth = copyMonthOf(selection.preset, period);
  const { refresh, state } = usePeriodSummary(
    organizationId,
    period,
    copyMonth,
    true,
    chosen
  );
  const answered =
    chosen &&
    state.source === "server" &&
    state.summary !== null &&
    samePeriod(state.summary.period, period) &&
    state.summary.quality.level !== "no_data";
  const shownToday = state.summary
    ? calendarDayInTimezone(new Date(state.summary.generatedAt), timezone)
    : today;
  const answeredSummary = answered ? state.summary : null;
  const comparedResult = answeredSummary
    ? resultChipPeriod(answeredSummary, shownToday)
    : null;
  const compared = answered ? comparisonPeriod(period, shownToday) : null;
  const comparison = useComparisonDays(organizationId, comparedResult);
  const salesComparison = useComparisonSales(organizationId, compared);
  const shown = state.summary?.period ?? period;
  const onScreenComparison = onScreen(comparison, shown, shownToday);
  const onScreenSales = onScreen(salesComparison, shown, shownToday);
  // the figures of another period still on screen while this one is read are not the period asked
  const summary =
    state.summary && samePeriod(state.summary.period, period)
      ? state.summary
      : null;
  const source = useMemo<PeriodSource | null>(
    () =>
      summary
        ? {
            comparison: onScreenComparison,
            kind: "period",
            salesComparison: onScreenSales,
            summary,
            today: shownToday,
          }
        : null,
    [onScreenComparison, onScreenSales, shownToday, summary]
  );
  return { chosen, period, refresh, source, state, today: shownToday };
}
