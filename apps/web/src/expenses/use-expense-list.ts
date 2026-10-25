import type { ExpenseReadModel } from "@polaris/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { orpcClient } from "../lib/orpc";
import { readWithRetry } from "../lib/read-with-retry";
import { expenseErrorMessage } from "./expense-errors";
import { monthBounds } from "./expense-model";

export type ExpenseStatusFilter = "active" | "voided";

export interface ExpenseFilters {
  /** Empty for every category. */
  categoryId: string;
  /** YYYY-MM */
  month: string;
  status: ExpenseStatusFilter;
}

export interface ExpenseListState {
  count: number;
  error: string | null;
  expenses: ExpenseReadModel[];
  isLoading: boolean;
  isLoadingMore: boolean;
  nextCursor: string | null;
  /** Exact decimal text for the whole filter, not only the loaded page. */
  total: string;
}

const PAGE_SIZE = 50;

const initialState: ExpenseListState = {
  count: 0,
  error: null,
  expenses: [],
  isLoading: true,
  isLoadingMore: false,
  nextCursor: null,
  total: "0.00",
};

/**
 * The expenses of a month (and optionally one category and status), read from
 * the server. Every request takes a sequence number, so a late answer never
 * replaces a newer one.
 */
export function useExpenseList(
  organizationId: string,
  { categoryId, month, status }: ExpenseFilters
) {
  const [state, setState] = useState<ExpenseListState>(initialState);
  const sequence = useRef(0);

  const fetchPage = useCallback(
    (cursor: string | null) => {
      const bounds = monthBounds(month);
      return readWithRetry(() =>
        orpcClient.expense.list({
          categoryId: categoryId === "" ? null : categoryId,
          cursor,
          from: bounds?.from,
          limit: PAGE_SIZE,
          organizationId,
          status,
          to: bounds?.to,
        })
      );
    },
    [categoryId, month, organizationId, status]
  );

  /** `keepRows` keeps what is shown while the same filter is read again. */
  const load = useCallback(
    async (keepRows: boolean) => {
      sequence.current += 1;
      const requestSequence = sequence.current;
      setState((current) => ({
        ...(keepRows ? current : initialState),
        error: null,
        isLoading: true,
        isLoadingMore: false,
      }));
      try {
        const result = await fetchPage(null);
        if (requestSequence !== sequence.current) {
          return;
        }
        setState({
          count: result.count,
          error: null,
          expenses: result.expenses,
          isLoading: false,
          isLoadingMore: false,
          nextCursor: result.nextCursor,
          total: result.total,
        });
      } catch (caughtError) {
        if (requestSequence === sequence.current) {
          setState((current) => ({
            ...current,
            error: expenseErrorMessage(caughtError, "load"),
            isLoading: false,
          }));
        }
      }
    },
    [fetchPage]
  );

  useEffect(() => {
    load(false);
    return () => {
      sequence.current += 1;
    };
  }, [load]);

  const { nextCursor } = state;
  const loadMore = useCallback(async () => {
    if (nextCursor === null) {
      return;
    }
    const requestSequence = sequence.current;
    setState((current) => ({ ...current, error: null, isLoadingMore: true }));
    try {
      const result = await fetchPage(nextCursor);
      if (requestSequence !== sequence.current) {
        return;
      }
      setState((current) => ({
        ...current,
        count: result.count,
        expenses: [...current.expenses, ...result.expenses],
        isLoadingMore: false,
        nextCursor: result.nextCursor,
        total: result.total,
      }));
    } catch (caughtError) {
      if (requestSequence === sequence.current) {
        setState((current) => ({
          ...current,
          error: expenseErrorMessage(caughtError, "load"),
          isLoadingMore: false,
        }));
      }
    }
  }, [fetchPage, nextCursor]);

  const refresh = useCallback(() => load(true), [load]);

  return { loadMore, refresh, state };
}
