import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { isDailySeries } from "../home/home-rhythm-model";
import { useConnectionOnline } from "../lib/browser-connection";
import { isNoAnswer } from "../lib/connection";
import { browserStorage } from "../lib/current-organization-model";
import { orpcClient } from "../lib/orpc";
import { readWithRetry } from "../lib/read-with-retry";
import {
  periodSummaryStaleVersion,
  subscribePeriodSummaryStale,
} from "../lib/period-summary-stale";
import {
  clearPeriodSummaryCaches,
  isPeriodSummary,
  readPeriodSummaryCache,
  type StoredDay,
  type StoredPeriodSummary,
  writePeriodSummaryCache,
} from "../lib/period-summary-cache";
import { rpcErrorCode } from "../lib/rpc-error";
import { isSigningOut } from "../lib/sign-out";
import { OFFLINE_RUNTIME_ENABLED } from "../offline/runtime/enabled";
import { useRuntimeSnapshot } from "../offline/runtime/runtime-context";
import {
  periodSummaryErrorMessage,
  periodSummaryMayUseCopy,
} from "./dashboard-errors";
import { addDays, type Period, samePeriod } from "./result-period";

export interface PeriodSummaryState {
  error: string | null;
  isLoading: boolean;
  /**
   * The copy stands in because the server answered with a failure (a Worker killed for CPU, a 5xx), after every try:
   * "Não foi possível atualizar agora". False when no answer came at all (the network, a portal).
   */
  serverFailed: boolean;
  /**
   * `server` for figures the server just returned; `cache` for this device's
   * copy of the last confirmed result of the month, shown when the server
   * could not answer.
   */
  source: "cache" | "server";
  /**
   * What is on screen. While another period is being read it is still the one before: the screen says which period
   * it is from (`summary.period`), never the one that was asked for (AC-3).
   */
  summary: StoredPeriodSummary | null;
}

const initialState: PeriodSummaryState = {
  error: null,
  isLoading: true,
  serverFailed: false,
  source: "server",
  summary: null,
};

/** True when the copy was read by the server before the figures already on screen. */
function isOlderThan(
  copy: StoredPeriodSummary,
  shown: StoredPeriodSummary | null
): boolean {
  return (
    shown !== null &&
    Date.parse(copy.generatedAt) < Date.parse(shown.generatedAt)
  );
}

/**
 * What the screen shows when a read failed: the copy of the device when there is one that is not older than the figures
 * already on screen, else the error. The figures of another period are never kept (AC-3), and a copy that the server's
 * answer no longer backs is not kept either.
 */
function failedState(
  current: PeriodSummaryState,
  asked: Period,
  copy: StoredPeriodSummary | null,
  error: unknown,
  copyKept: boolean
): PeriodSummaryState {
  const sameOnScreen =
    current.summary !== null && samePeriod(current.summary.period, asked)
      ? current.summary
      : null;
  // the copy never replaces figures on screen that are newer than it
  if (copy && !isOlderThan(copy, sameOnScreen)) {
    return {
      error: null,
      isLoading: false,
      serverFailed: !isNoAnswer(error),
      source: "cache",
      summary: copy,
    };
  }
  return {
    error: periodSummaryErrorMessage(error, copyKept),
    isLoading: false,
    serverFailed: false,
    source: current.source,
    summary: current.source === "cache" ? null : sameOnScreen,
  };
}

/** Keeps the month the server just returned on the device, for opening without a connection (AC-16). Other periods keep nothing. */
function keepCopy(
  organizationId: string,
  copyMonth: string | null,
  summary: StoredPeriodSummary
): void {
  if (copyMonth === null) {
    return;
  }
  writePeriodSummaryCache(
    browserStorage(),
    organizationId,
    copyMonth,
    summary,
    {
      offlineRuntimeEnabled: OFFLINE_RUNTIME_ENABLED,
      signingOut: isSigningOut(),
    }
  );
}

/** The copy of the month that may stand in for a server that could not answer: none for a refusal of the server or of the session. */
function copyFor(
  organizationId: string,
  copyMonth: string | null,
  error: unknown,
  sessionRefused: boolean
): StoredPeriodSummary | null {
  if (
    copyMonth === null ||
    !OFFLINE_RUNTIME_ENABLED ||
    sessionRefused ||
    !periodSummaryMayUseCopy(error)
  ) {
    return null;
  }
  return readPeriodSummaryCache(browserStorage(), organizationId, copyMonth);
}

/**
 * The result of a period (`from` to `to`, YYYY-MM-DD), read from the server. Every request takes a sequence number,
 * so a late answer never replaces a newer one. A month the device kept (`copyMonth`, YYYY-MM: the two months the
 * screen keeps a copy of, AC-16) is shown from the copy, marked as such, when the server cannot answer; any other
 * period has no copy and says it opens only with a connection.
 *
 * Reading another period keeps the figures already on screen until the answer comes (AC-3), and a failure never leaves
 * the figures of another period in their place.
 *
 * A write that changes the figures (`markPeriodSummaryStale`) makes the read old: when `active` (the Resultado is in
 * front) and the connection is there, it is read again, once per write (a read that fails spends the mark: "Atualizar"
 * is the way to try again); with no connection or another tab in front it waits, and reads when both are met. With nothing written there is no read beyond the one of the period.
 */
export function usePeriodSummary(
  organizationId: string,
  period: Period,
  copyMonth: string | null,
  active = true
) {
  const { from, to } = period;
  const [state, setState] = useState<PeriodSummaryState>(initialState);
  const sequence = useRef(0);
  // the copy never stands in for a server that refused the session
  const snapshot = useRuntimeSnapshot();
  const sessionRefused = useRef(false);
  sessionRefused.current = snapshot?.sessionRefused ?? false;
  const shownOrganization = useRef(organizationId);
  // the writes seen when the last read started: a write after it leaves the read old
  const readVersion = useRef(periodSummaryStaleVersion());
  const staleVersion = useSyncExternalStore(
    subscribePeriodSummaryStale,
    periodSummaryStaleVersion,
    periodSummaryStaleVersion
  );
  const online = useConnectionOnline();

  const load = useCallback(async () => {
    readVersion.current = periodSummaryStaleVersion();
    sequence.current += 1;
    const requestSequence = sequence.current;
    const asked: Period = { from, to };
    const reset = shownOrganization.current !== organizationId;
    shownOrganization.current = organizationId;
    setState((current) => ({
      ...(reset ? initialState : current),
      error: null,
      isLoading: true,
    }));
    try {
      const summary = await readWithRetry(
        (signal) =>
          orpcClient.report.periodSummary(
            {
              from,
              organizationId,
              to,
              // the same shape the Início keeps under the same key: the last write never loses the ranking (§ 7.2)
              topProducts: 3,
            },
            { signal }
          ),
        { isCurrent: () => requestSequence === sequence.current }
      );
      if (!isPeriodSummary(summary)) {
        // not what the server sends (a captive portal page, a proxy): as if it had not answered
        throw new Error("period_summary_malformed");
      }
      if (requestSequence === sequence.current) {
        keepCopy(organizationId, copyMonth, summary);
        setState({
          error: null,
          isLoading: false,
          serverFailed: false,
          source: "server",
          summary,
        });
      }
    } catch (caughtError) {
      if (requestSequence === sequence.current) {
        if (rpcErrorCode(caughtError) === "UNAUTHORIZED") {
          // the session is over: no copy of this browser's results outlives it
          clearPeriodSummaryCaches(browserStorage());
        }
        const copy = copyFor(
          organizationId,
          copyMonth,
          caughtError,
          sessionRefused.current
        );
        setState((current) =>
          failedState(current, asked, copy, caughtError, copyMonth !== null)
        );
      }
    }
  }, [copyMonth, from, organizationId, to]);

  useEffect(() => {
    load();
    return () => {
      sequence.current += 1;
    };
  }, [load]);

  // a read the effect above just started has already taken the version, so it is not asked twice
  useEffect(() => {
    if (active && online && staleVersion !== readVersion.current) {
      load();
    }
  }, [active, load, online, staleVersion]);

  return { refresh: load, state };
}

/** The days of the period the chips of the cards compare with, and which period they are of. */
export interface ComparisonDays<
  Day = NonNullable<StoredPeriodSummary["daily"]>[number],
> {
  days: Day[];
  period: Period;
}

/** The days of a period as `report.dailySales` read them: sales and counts only, no cost. */
export type ComparisonSales = ComparisonDays<
  Pick<StoredDay, "date" | "netSales" | "salesCount">
>;

/** How a read of the period before is made: in one try (see `useComparisonRead`), `null` for what the server does not send. */
type ReadDays<Day> = (
  organizationId: string,
  period: Period,
  isCurrent: () => boolean
) => Promise<Day[] | null>;

/**
 * A read of the period before that the cards compare with, asked only once the screen's read of the period answered
 * (the caller passes null before, and also when the card that reads it can have no chip), in one try and with no copy on the device: when it fails, or with no connection,
 * the cards have no chip and say nothing about it. `read` gives the days of the period, or null when what came back is
 * not what the server sends. A late answer never stands for another period; the last one read is kept, so going back
 * to a period does not ask again.
 */
function useComparisonRead<Day>(
  organizationId: string,
  period: Period | null,
  read: ReadDays<Day>
): ComparisonDays<Day> | null {
  const from = period?.from ?? null;
  const to = period?.to ?? null;
  const [kept, setKept] = useState<
    (ComparisonDays<Day> & { organizationId: string }) | null
  >(null);
  const sequence = useRef(0);
  const wanted =
    kept !== null &&
    kept.organizationId === organizationId &&
    kept.period.from === from &&
    kept.period.to === to;

  useEffect(() => {
    if (from === null || to === null || wanted) {
      return;
    }
    sequence.current += 1;
    const requestSequence = sequence.current;
    const isCurrent = () => requestSequence === sequence.current;
    read(organizationId, { from, to }, isCurrent)
      .then((days) => {
        if (isCurrent() && days) {
          setKept({ days, organizationId, period: { from, to } });
        }
      })
      .catch(() => {
        // no chip: the cards say their own numbers without a comparison
      });
    return () => {
      sequence.current += 1;
    };
  }, [from, organizationId, read, to, wanted]);

  return wanted ? { days: kept.days, period: kept.period } : null;
}

// one try in each: a retry would spend the brakes of the tab that the read of the screen needs (paliativo dos 1102)
const readSummaryDays: ReadDays<ComparisonDays["days"][number]> = async (
  organizationId,
  { from, to },
  isCurrent
) => {
  const summary = await readWithRetry(
    (signal) =>
      orpcClient.report.periodSummary({ from, organizationId, to }, { signal }),
    { isCurrent, mayRetry: () => false }
  );
  return isPeriodSummary(summary) && summary.daily ? summary.daily : null;
};

const readSalesDays: ReadDays<ComparisonSales["days"][number]> = async (
  organizationId,
  period,
  isCurrent
) => {
  const series = await readWithRetry(
    (signal) =>
      orpcClient.report.dailySales({ organizationId, ...period }, { signal }),
    { isCurrent, mayRetry: () => false }
  );
  // not what the server sends (a captive portal page, a proxy): as if it had not answered
  return isDailySeries(series, period)
    ? series.net.map((netSales, index) => ({
        date: addDays(period.from, index),
        netSales,
        salesCount: series.count[index] as number,
      }))
    : null;
};

/**
 * The daily series of the period before (`result-kpis.ts`, `comparisonPeriod`) with the result of each day, read by
 * `periodSummary` (the engine): what the chip of the result compares with.
 */
export function useComparisonDays(
  organizationId: string,
  period: Period | null
): ComparisonDays | null {
  return useComparisonRead(organizationId, period, readSummaryDays);
}

/**
 * The same period's net sales and sales count of each day, read by `dailySales` (a SQL `GROUP BY`, no engine): what the
 * chips of sales and ticket compare with.
 */
export function useComparisonSales(
  organizationId: string,
  period: Period | null
): ComparisonSales | null {
  return useComparisonRead(organizationId, period, readSalesDays);
}
