import { useCallback, useEffect, useRef, useState } from "react";
import { monthBounds } from "../expenses/expense-model";
import { browserStorage } from "../lib/current-organization-model";
import { orpcClient } from "../lib/orpc";
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

export interface PeriodSummaryState {
  error: string | null;
  isLoading: boolean;
  /**
   * `server` for figures the server just returned; `cache` for this device's
   * copy of the last confirmed result of the month, shown when the server
   * could not answer.
   */
  source: "cache" | "server";
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
 * The result of a calendar month (YYYY-MM), read from the server. Every request
 * takes a sequence number, so a late answer never replaces a newer one. When
 * the server cannot answer (no network, an outage) and this device kept the
 * month's last confirmed result, that copy is shown, marked as such.
 */
export function usePeriodSummary(organizationId: string, month: string) {
  const [state, setState] = useState<PeriodSummaryState>(initialState);
  const sequence = useRef(0);
  // the copy never stands in for a server that refused the session
  const snapshot = useRuntimeSnapshot();
  const sessionRefused = useRef(false);
  sessionRefused.current = snapshot?.sessionRefused ?? false;

  /** `keepSummary` keeps what is shown while the same month is read again. */
  const load = useCallback(
    async (keepSummary: boolean) => {
      sequence.current += 1;
      const requestSequence = sequence.current;
      const bounds = monthBounds(month);
      if (bounds === null) {
        setState({
          ...initialState,
          error: "Escolha um mês válido.",
          isLoading: false,
        });
        return;
      }
      setState((current) => ({
        ...(keepSummary ? current : initialState),
        error: null,
        isLoading: true,
      }));
      try {
        const summary = await orpcClient.report.periodSummary({
          from: bounds.from,
          organizationId,
          to: bounds.to,
        });
        if (!isPeriodSummary(summary)) {
          // not what the server sends (a captive portal page, a proxy): as if it had not answered
          throw new Error("period_summary_malformed");
        }
        if (requestSequence === sequence.current) {
          writePeriodSummaryCache(
            browserStorage(),
            organizationId,
            month,
            summary,
            {
              offlineRuntimeEnabled: OFFLINE_RUNTIME_ENABLED,
              signingOut: isSigningOut(),
            }
          );
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
          const copy =
            OFFLINE_RUNTIME_ENABLED &&
            !sessionRefused.current &&
            periodSummaryMayUseCopy(caughtError)
              ? readPeriodSummaryCache(browserStorage(), organizationId, month)
              : null;
          setState((current) => {
            // the copy never replaces figures on screen that are newer than it
            if (copy && !isOlderThan(copy, current.summary)) {
              return {
                error: null,
                isLoading: false,
                source: "cache",
                summary: copy,
              };
            }
            return {
              error: periodSummaryErrorMessage(caughtError),
              isLoading: false,
              source: current.source,
              // a copy the server's answer (or a cleared copy) no longer backs is not kept
              summary: current.source === "cache" ? null : current.summary,
            };
          });
        }
      }
    },
    [month, organizationId]
  );

  useEffect(() => {
    load(false);
    return () => {
      sequence.current += 1;
    };
  }, [load]);

  const refresh = useCallback(() => load(true), [load]);

  return { refresh, state };
}
