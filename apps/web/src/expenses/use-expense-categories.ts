import type { ExpenseCategoryReadModel } from "@polaris/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { orpcClient } from "../lib/orpc";
import { readWithRetry } from "../lib/read-with-retry";
import { expenseErrorMessage } from "./expense-errors";

export interface ExpenseCategoriesState {
  categories: ExpenseCategoryReadModel[];
  error: string | null;
  isLoading: boolean;
}

/**
 * Every category of the organization, archived ones included (an old expense
 * can still be in one). The server creates the default categories the first
 * time they are read.
 */
export function useExpenseCategories(organizationId: string) {
  const [state, setState] = useState<ExpenseCategoriesState>({
    categories: [],
    error: null,
    isLoading: true,
  });
  const sequence = useRef(0);

  const reload = useCallback(async () => {
    sequence.current += 1;
    const requestSequence = sequence.current;
    setState((current) => ({ ...current, error: null, isLoading: true }));
    try {
      const result = await readWithRetry(() =>
        orpcClient.expense.listCategories({ organizationId, status: "all" })
      );
      if (requestSequence === sequence.current) {
        setState({
          categories: result.categories,
          error: null,
          isLoading: false,
        });
      }
    } catch (caughtError) {
      if (requestSequence === sequence.current) {
        setState((current) => ({
          ...current,
          error: expenseErrorMessage(caughtError, "load"),
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

  /** Puts a category the server just returned into the list, replacing its older version. */
  const upsert = useCallback((category: ExpenseCategoryReadModel) => {
    setState((current) => {
      const exists = current.categories.some(({ id }) => id === category.id);
      return {
        ...current,
        categories: exists
          ? current.categories.map((item) =>
              item.id === category.id ? category : item
            )
          : [...current.categories, category],
      };
    });
  }, []);

  return { reload, state, upsert };
}
