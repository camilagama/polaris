import type { InventoryBalanceReadModel } from "@polaris/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDebouncedValue } from "../lib/use-debounced-value";
import { orpcClient } from "../lib/orpc";
import {
  canLoadMoreStock,
  defaultStockFilters,
  initialStockListState,
  type StockFilters,
  type StockListState,
  stockBalanceUpdated,
  stockListRequest,
  stockLoadFailed,
  stockLoaded,
  stockLoading,
  stockMoreFailed,
  stockMoreLoaded,
  stockMoreStarted,
} from "./stock-list-model";

const SEARCH_DELAY_MS = 300;

interface StockList {
  /** Applies a balance a command returned to its row. */
  applyBalance: (
    balance: InventoryBalanceReadModel,
    updatedAt: string | null
  ) => void;
  /** What the inputs show now; the list follows after the search pauses. */
  filters: StockFilters;
  loadMore: () => void;
  reload: () => void;
  setFilters: (changes: Partial<StockFilters>) => void;
  state: StockListState;
}

/**
 * The stock list of an organization: one read per page, a debounced search,
 * and answers that arrive late for an older search are ignored.
 */
export function useStockList(organizationId: string): StockList {
  const [filters, setFiltersState] = useState(defaultStockFilters);
  const [state, setState] = useState(initialStockListState);
  const [reloadVersion, setReloadVersion] = useState(0);
  const latest = useRef(0);
  const debouncedQuery = useDebouncedValue(filters.query, SEARCH_DELAY_MS);
  const { includeArchived, stock } = filters;
  const effective = useMemo<StockFilters>(
    () => ({ includeArchived, query: debouncedQuery, stock }),
    [debouncedQuery, includeArchived, stock]
  );

  useEffect(() => {
    // A new search, filter, organization or explicit reload starts over.
    latest.current += 1;
    const request = latest.current;
    setState(stockLoading);
    orpcClient.inventory
      .listBalances(stockListRequest(organizationId, effective, null))
      .then((page) => {
        if (request === latest.current) {
          setState((current) => stockLoaded(current, page));
        }
      })
      .catch((error: unknown) => {
        if (request === latest.current) {
          setState((current) => stockLoadFailed(current, error));
        }
      });
    return () => {
      latest.current += 1;
    };
  }, [effective, organizationId, reloadVersion]);

  const loadMore = useCallback(() => {
    if (!canLoadMoreStock(state) || state.nextCursor === null) {
      return;
    }
    const cursor = state.nextCursor;
    latest.current += 1;
    const request = latest.current;
    setState(stockMoreStarted);
    orpcClient.inventory
      .listBalances(stockListRequest(organizationId, effective, cursor))
      .then((page) => {
        if (request === latest.current) {
          setState((current) => stockMoreLoaded(current, page));
        }
      })
      .catch((error: unknown) => {
        if (request === latest.current) {
          setState((current) => stockMoreFailed(current, error));
        }
      });
  }, [effective, organizationId, state]);

  const reload = useCallback(
    () => setReloadVersion((version) => version + 1),
    []
  );
  const setFilters = useCallback(
    (changes: Partial<StockFilters>) =>
      setFiltersState((current) => ({ ...current, ...changes })),
    []
  );
  const applyBalance = useCallback(
    (balance: InventoryBalanceReadModel, updatedAt: string | null) =>
      setState((current) => stockBalanceUpdated(current, balance, updatedAt)),
    []
  );

  return { applyBalance, filters, loadMore, reload, setFilters, state };
}
