import type { ExpenseRuleReadModel } from "@polaris/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { orpcClient } from "../lib/orpc";
import { readWithRetry } from "../lib/read-with-retry";
import { expenseErrorMessage } from "./expense-errors";

export interface ExpenseRulesState {
  error: string | null;
  isLoading: boolean;
  rules: ExpenseRuleReadModel[];
}

/**
 * Every recurring rule of the organization, paused ones included. Reading the
 * rules makes the server generate the occurrences that fell due, so the
 * "next occurrence" of each rule is always current.
 */
export function useExpenseRules(organizationId: string) {
  const [state, setState] = useState<ExpenseRulesState>({
    error: null,
    isLoading: true,
    rules: [],
  });
  const sequence = useRef(0);

  const reload = useCallback(async () => {
    sequence.current += 1;
    const requestSequence = sequence.current;
    setState((current) => ({ ...current, error: null, isLoading: true }));
    try {
      const result = await readWithRetry(
        () => orpcClient.expense.listRules({ organizationId, status: "all" }),
        { isCurrent: () => requestSequence === sequence.current }
      );
      if (requestSequence === sequence.current) {
        setState({ error: null, isLoading: false, rules: result.rules });
      }
    } catch (caughtError) {
      if (requestSequence === sequence.current) {
        setState((current) => ({
          ...current,
          error: expenseErrorMessage(caughtError, "rule-load"),
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

  /** Puts a rule the server just returned into the list, replacing its older version. */
  const upsert = useCallback((rule: ExpenseRuleReadModel) => {
    setState((current) => {
      const exists = current.rules.some(({ id }) => id === rule.id);
      return {
        ...current,
        rules: exists
          ? current.rules.map((item) => (item.id === rule.id ? rule : item))
          : [...current.rules, rule],
      };
    });
  }, []);

  return { reload, state, upsert };
}
