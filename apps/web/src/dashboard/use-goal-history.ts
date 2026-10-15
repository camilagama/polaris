import { useCallback, useEffect, useRef, useState } from "react";
import { orpcClient } from "../lib/orpc";
import { goalErrorMessage } from "./goal-errors";

interface GoalTargetChange {
  changedAt: string;
  newTarget: string;
  previousTarget: string;
}

export interface GoalHistoryState {
  changes: GoalTargetChange[] | null;
  error: string | null;
  isLoading: boolean;
}

/**
 * The changes of one goal's target, read when the history is opened and again
 * when the goal's version moves (a new change is on its way into the list).
 */
export function useGoalHistory(
  organizationId: string,
  goalId: string,
  version: number
) {
  const [state, setState] = useState<GoalHistoryState>({
    changes: null,
    error: null,
    isLoading: true,
  });
  const sequence = useRef(0);

  const load = useCallback(async () => {
    sequence.current += 1;
    const requestSequence = sequence.current;
    setState((current) => ({ ...current, error: null, isLoading: true }));
    try {
      const result = await orpcClient.goal.targetChanges({
        id: goalId,
        organizationId,
      });
      if (requestSequence === sequence.current) {
        setState({ changes: result.changes, error: null, isLoading: false });
      }
    } catch (caughtError) {
      if (requestSequence === sequence.current) {
        setState((current) => ({
          ...current,
          error: goalErrorMessage(caughtError, "history"),
          isLoading: false,
        }));
      }
    }
  }, [goalId, organizationId]);

  // a new version of the goal means its history may have grown
  useEffect(() => {
    load();
    return () => {
      sequence.current += 1;
    };
  }, [load, version]);

  return { load, state };
}
