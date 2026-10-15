import type { PeriodSummaryReadModel } from "@polaris/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { monthBounds } from "../expenses/expense-model";
import { orpcClient } from "../lib/orpc";
import { periodSummaryErrorMessage } from "./dashboard-errors";

export interface PeriodSummaryState {
  error: string | null;
  isLoading: boolean;
  /** The client clock when the figures on screen were last read successfully. */
  loadedAt: Date | null;
  summary: PeriodSummaryReadModel | null;
}

const initialState: PeriodSummaryState = {
  error: null,
  isLoading: true,
  loadedAt: null,
  summary: null,
};

/**
 * The result of a calendar month (YYYY-MM), read from the server. Every request
 * takes a sequence number, so a late answer never replaces a newer one.
 */
export function usePeriodSummary(organizationId: string, month: string) {
  const [state, setState] = useState<PeriodSummaryState>(initialState);
  const sequence = useRef(0);

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
        if (requestSequence === sequence.current) {
          setState({
            error: null,
            isLoading: false,
            loadedAt: new Date(),
            summary,
          });
        }
      } catch (caughtError) {
        if (requestSequence === sequence.current) {
          setState((current) => ({
            ...current,
            error: periodSummaryErrorMessage(caughtError),
            isLoading: false,
          }));
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
