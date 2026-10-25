import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { orpcClient } from "../lib/orpc";
import { readWithRetry } from "../lib/read-with-retry";
import { useDebouncedValue } from "../lib/use-debounced-value";
import type { LocalWorkspace } from "../offline/runtime/use-local-workspace";
import { filterLocalSales } from "./local-history";
import {
  canLoadMore,
  emptyHistoryFilters,
  type HistoryFilters,
  type HistoryState,
  historyListRequest,
  historyLoaded,
  historyLoadFailed,
  historyLoading,
  initialHistoryState,
  loadMoreStarted,
  moreLoaded,
  moreLoadFailed,
  nextOffset,
  periodError,
} from "./sale-history-model";

const SEARCH_DELAY_MS = 300;

interface SaleHistory {
  /** What the inputs show now; the list follows after the search pauses. */
  filters: HistoryFilters;
  loadMore: () => void;
  /** The period contradicts itself, so nothing is requested until it is fixed. */
  period: string | null;
  reload: () => void;
  reset: () => void;
  setFilters: (changes: Partial<HistoryFilters>) => void;
  state: HistoryState;
}

/**
 * The sale list for an organization: filtered on the server, one read per
 * page, text filters debounced, and answers that arrive late for an older
 * filter are ignored. No customer list is loaded: names come with the rows.
 *
 * With a local workspace (no connection) the list is the device's window of
 * recent sales, filtered here, read again whenever the local rows change.
 */
export function useSaleHistory(
  organizationId: string,
  local: LocalWorkspace | null = null
): SaleHistory {
  const [filters, setFiltersState] = useState(emptyHistoryFilters);
  const [state, setState] = useState(initialHistoryState);
  const [reloadVersion, setReloadVersion] = useState(0);
  const latest = useRef(0);
  const debouncedCustomer = useDebouncedValue(
    filters.customer,
    SEARCH_DELAY_MS
  );
  const debouncedQuery = useDebouncedValue(filters.query, SEARCH_DELAY_MS);
  const { from, status, to } = filters;
  const effective = useMemo<HistoryFilters>(
    () => ({
      customer: debouncedCustomer,
      from,
      query: debouncedQuery,
      status,
      to,
    }),
    [debouncedCustomer, debouncedQuery, from, status, to]
  );
  const period = periodError(filters);
  const effectivePeriod = periodError(effective);
  const localWriter = local?.stores.writer;
  const localVersion = local?.dataVersion ?? -1;

  useEffect(() => {
    latest.current += 1;
    if (effectivePeriod !== null) {
      return;
    }
    const request = latest.current;
    setState(historyLoading);
    if (localWriter && localVersion >= 0) {
      localWriter
        .recentSalesRows()
        .then((rows) => {
          if (request === latest.current) {
            setState((current) =>
              historyLoaded(current, filterLocalSales(rows, effective))
            );
          }
        })
        .catch((error: unknown) => {
          if (request === latest.current) {
            setState((current) => historyLoadFailed(current, error));
          }
        });
      return () => {
        latest.current += 1;
      };
    }
    readWithRetry(
      () =>
        orpcClient.sale.list(historyListRequest(organizationId, effective, 0)),
      { isCurrent: () => request === latest.current }
    )
      .then((page) => {
        if (request === latest.current) {
          setState((current) => historyLoaded(current, page));
        }
      })
      .catch((error: unknown) => {
        if (request === latest.current) {
          setState((current) => historyLoadFailed(current, error));
        }
      });
    return () => {
      latest.current += 1;
    };
  }, [
    effective,
    effectivePeriod,
    localVersion,
    localWriter,
    organizationId,
    reloadVersion,
  ]);

  const loadMore = useCallback(() => {
    if (!canLoadMore(state)) {
      return;
    }
    latest.current += 1;
    const request = latest.current;
    setState(loadMoreStarted);
    readWithRetry(
      () =>
        orpcClient.sale.list(
          historyListRequest(organizationId, effective, nextOffset(state))
        ),
      { isCurrent: () => request === latest.current }
    )
      .then((page) => {
        if (request === latest.current) {
          setState((current) => moreLoaded(current, page));
        }
      })
      .catch((error: unknown) => {
        if (request === latest.current) {
          setState((current) => moreLoadFailed(current, error));
        }
      });
  }, [effective, organizationId, state]);

  const reload = useCallback(
    () => setReloadVersion((version) => version + 1),
    []
  );
  const reset = useCallback(() => setFiltersState(emptyHistoryFilters), []);
  const setFilters = useCallback(
    (changes: Partial<HistoryFilters>) =>
      setFiltersState((current) => ({ ...current, ...changes })),
    []
  );

  return { filters, loadMore, period, reload, reset, setFilters, state };
}
