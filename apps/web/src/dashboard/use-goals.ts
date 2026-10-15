import type { GoalReadModel } from "@polaris/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { orpcClient } from "../lib/orpc";
import { goalErrorMessage } from "./goal-errors";

export interface GoalsState {
  error: string | null;
  goals: GoalReadModel[];
  isLoading: boolean;
}

/**
 * Every goal of the organization, read from the server. Reading also settles
 * the goals (one that reached its target becomes completed, one whose period
 * ended without it is missed), so what comes back is always current. Every
 * request takes a sequence number, so a late answer never replaces a newer one.
 */
export function useGoals(organizationId: string) {
  const [state, setState] = useState<GoalsState>({
    error: null,
    goals: [],
    isLoading: true,
  });
  const sequence = useRef(0);

  const reload = useCallback(async () => {
    sequence.current += 1;
    const requestSequence = sequence.current;
    setState((current) => ({ ...current, error: null, isLoading: true }));
    try {
      const result = await orpcClient.goal.list({
        organizationId,
        status: "all",
      });
      if (requestSequence === sequence.current) {
        setState({ error: null, goals: result.goals, isLoading: false });
      }
    } catch (caughtError) {
      if (requestSequence === sequence.current) {
        setState((current) => ({
          ...current,
          error: goalErrorMessage(caughtError, "load"),
          isLoading: false,
        }));
      }
    }
  }, [organizationId]);

  useEffect(() => {
    reload();
    return () => {
      sequence.current += 1;
    };
  }, [reload]);

  return { reload, state };
}
