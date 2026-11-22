import type {
  ExpenseCategoryTotalReadModel,
  ExpenseReadModel,
} from "@polaris/contracts";
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
  /** The same total per category; absent when the answer has no such field. */
  totalsByCategory?: ExpenseCategoryTotalReadModel[] | undefined;
}

interface ExpenseListPage {
  count: number;
  expenses: ExpenseReadModel[];
  nextCursor: string | null;
  total: string;
  totalsByCategory?: ExpenseCategoryTotalReadModel[] | undefined;
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
  totalsByCategory: undefined,
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
  const pagesLoaded = useRef(1);
  const nextCursorRef = useRef<string | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const committed = useRef<{ cursor: string | null; pages: number }>({
    cursor: null,
    pages: 1,
  });

  /** What the screen shows is the page count and the cursor that go with it; a failed read goes back to this pair. */
  const commit = useCallback((pages: number, cursor: string | null) => {
    pagesLoaded.current = pages;
    nextCursorRef.current = cursor;
    committed.current = { cursor, pages };
  }, []);

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
      pagesLoaded.current = 1;
      nextCursorRef.current = null;
      if (!keepRows) {
        committed.current = { cursor: null, pages: 1 };
      }
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
        commit(1, result.nextCursor);
        setState({
          count: result.count,
          error: null,
          expenses: result.expenses,
          isLoading: false,
          isLoadingMore: false,
          nextCursor: result.nextCursor,
          total: result.total,
          totalsByCategory: result.totalsByCategory,
        });
      } catch (caughtError) {
        if (requestSequence === sequence.current) {
          pagesLoaded.current = committed.current.pages;
          nextCursorRef.current = committed.current.cursor;
          setState((current) => ({
            ...current,
            error: expenseErrorMessage(caughtError, "load"),
            isLoading: false,
          }));
        }
      }
    },
    [commit, fetchPage]
  );

  useEffect(() => {
    load(false);
    return () => {
      sequence.current += 1;
    };
  }, [load]);

  /**
   * One read of pages at a time: the pages swapped by a re-read and the page "Carregar mais" adds never cross. The
   * tail takes the next piece of work even if the one before rejected, so a queue never stays stuck.
   */
  const inOrder = useCallback((work: () => Promise<void>) => {
    const next = queue.current.then(work, work);
    queue.current = next;
    return next;
  }, []);

  const loadMore = useCallback(() => {
    const requestSequence = sequence.current;
    return inOrder(async () => {
      const from = nextCursorRef.current;
      if (requestSequence !== sequence.current || from === null) {
        return;
      }
      setState((current) => ({
        ...current,
        error: null,
        isLoadingMore: true,
      }));
      try {
        const result = await fetchPage(from);
        if (requestSequence !== sequence.current) {
          return;
        }
        pagesLoaded.current += 1;
        nextCursorRef.current = result.nextCursor;
        setState((current) => ({
          ...current,
          count: result.count,
          expenses: [...current.expenses, ...result.expenses],
          isLoadingMore: false,
          nextCursor: result.nextCursor,
          total: result.total,
          totalsByCategory: result.totalsByCategory,
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
    });
  }, [commit, fetchPage, inOrder]);

  const refresh = useCallback(() => load(true), [load]);

  /**
   * Reads again as many pages as are on screen, one after the other, and swaps the rows for them: the names the rows
   * carry are the server's, and the page the person is on, its cursor and the place in the list stay. A read that a
   * newer load overtook is dropped; one that fails says so as any read of the list does, and keeps the rows.
   */
  const refreshKeepingPages = useCallback(() => {
    const requestSequence = sequence.current;
    return inOrder(async () => {
      if (requestSequence !== sequence.current) {
        return;
      }
      const readFrom = async (
        from: string | null,
        pages: number,
        rows: ExpenseReadModel[]
      ): Promise<{ page: ExpenseListPage; pages: number } | null> => {
        const result = await fetchPage(from);
        if (requestSequence !== sequence.current) {
          return null;
        }
        const joined = [...rows, ...result.expenses];
        if (pages >= pagesLoaded.current || result.nextCursor === null) {
          return { page: { ...result, expenses: joined }, pages };
        }
        return readFrom(result.nextCursor, pages + 1, joined);
      };
      try {
        const read = await readFrom(null, 1, []);
        if (read === null) {
          return;
        }
        pagesLoaded.current = read.pages;
        nextCursorRef.current = read.page.nextCursor;
        setState((current) => ({
          ...current,
          count: read.page.count,
          error: null,
          expenses: read.page.expenses,
          nextCursor: read.page.nextCursor,
          total: read.page.total,
          totalsByCategory: read.page.totalsByCategory,
        }));
      } catch (caughtError) {
        if (requestSequence === sequence.current) {
          setState((current) => ({
            ...current,
            error: expenseErrorMessage(caughtError, "load"),
          }));
        }
      }
    });
  }, [commit, fetchPage, inOrder]);

  return { loadMore, refresh, refreshKeepingPages, state };
}
