import { useCallback, useEffect, useRef, useState } from "react";
import { browserStorage } from "../lib/current-organization-model";
import { orpcClient } from "../lib/orpc";
import { readWithRetry } from "../lib/read-with-retry";
import {
  clearPeriodSummaryCaches,
  isPeriodSummary,
  readPeriodSummaryCache,
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
import { type Period, samePeriod } from "./result-period";

export interface PeriodSummaryState {
  error: string | null;
  isLoading: boolean;
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
    return { error: null, isLoading: false, source: "cache", summary: copy };
  }
  return {
    error: periodSummaryErrorMessage(error, copyKept),
    isLoading: false,
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
 */
export function usePeriodSummary(
  organizationId: string,
  period: Period,
  copyMonth: string | null
) {
  const { from, to } = period;
  const [state, setState] = useState<PeriodSummaryState>(initialState);
  const sequence = useRef(0);
  // the copy never stands in for a server that refused the session
  const snapshot = useRuntimeSnapshot();
  const sessionRefused = useRef(false);
  sessionRefused.current = snapshot?.sessionRefused ?? false;
  const shownOrganization = useRef(organizationId);

  const load = useCallback(async () => {
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
        () =>
          orpcClient.report.periodSummary({
            from,
            organizationId,
            to,
            // the same shape the Início keeps under the same key: the last write never loses the ranking (§ 7.2)
            topProducts: 3,
          }),
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

  return { refresh: load, state };
}
