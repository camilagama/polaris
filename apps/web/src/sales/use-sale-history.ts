import { useCallback, useEffect, useRef, useState } from "react";
import { orpcClient } from "../lib/orpc";
import { readWithRetry } from "../lib/read-with-retry";
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
} from "./sale-history-model";

interface SaleHistory {
  /** What the bar shows now: the list is read for exactly these. */
  filters: HistoryFilters;
  loadMore: () => void;
  reload: () => void;
  setFilters: (changes: Partial<HistoryFilters>) => void;
  state: HistoryState;
}

/**
 * The sale list for an organization: filtered on the server, one read per
 * page, and answers that arrive late for an older filter are ignored. A text
 * filter comes from the bar already applied (Enter or "Pronto"), so there is nothing to debounce. No customer list is loaded: names come with the rows.
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
  const localWriter = local?.stores.writer;
  const localVersion = local?.dataVersion ?? -1;

  useEffect(() => {
    latest.current += 1;
    const request = latest.current;
    setState(historyLoading);
    if (localWriter && localVersion >= 0) {
      localWriter
        .recentSalesRows()
        .then((rows) => {
          if (request === latest.current) {
            setState((current) =>
              historyLoaded(current, filterLocalSales(rows, filters))
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
        orpcClient.sale.list(historyListRequest(organizationId, filters, 0)),
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
  }, [filters, localVersion, localWriter, organizationId, reloadVersion]);

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
          historyListRequest(organizationId, filters, nextOffset(state))
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
  }, [filters, organizationId, state]);

  const reload = useCallback(
    () => setReloadVersion((version) => version + 1),
    []
  );
  const setFilters = useCallback(
    (changes: Partial<HistoryFilters>) =>
      setFiltersState((current) => ({ ...current, ...changes })),
    []
  );

  return { filters, loadMore, reload, setFilters, state };
}
