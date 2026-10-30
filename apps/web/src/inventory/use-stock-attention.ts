import { useEffect, useMemo, useRef, useState } from "react";
import { orpcClient } from "../lib/orpc";
import { readWithRetry } from "../lib/read-with-retry";
import {
  type StockAttention,
  type StockAttentionLink,
  stockAttentionLinks,
  stockAttentionRequest,
  variantCount,
} from "./stock-list-model";

/**
 * The links of the strip, from the counts behind "Precisa de ação" on the stock screen. They are the store's, not the list's: the filters of the
 * list do not change them. None while unread, without a connection (the device does not hold the cost) and when a
 * read fails: the strip is then simply not there. `version` reads again after a movement or a reload.
 */
export function useStockAttention(
  organizationId: string,
  enabled: boolean,
  version: number
): StockAttentionLink[] {
  const [attention, setAttention] = useState<StockAttention | null>(null);
  const latest = useRef(0);
  useEffect(() => {
    latest.current += 1;
    const request = latest.current;
    if (!enabled) {
      setAttention(null);
      return;
    }
    const isCurrent = () => request === latest.current;
    const read = (kind: "unknown-cost" | "without-stock") =>
      readWithRetry(
        (signal) =>
          orpcClient.inventory.listBalances(
            stockAttentionRequest(organizationId, kind),
            { signal }
          ),
        { isCurrent }
      );
    const withoutStock = read("without-stock");
    // awaited below: a failure meanwhile is not an unhandled rejection
    withoutStock.catch(() => undefined);
    read("unknown-cost")
      .then(async (unknownCost) => ({
        unknownCost: variantCount(unknownCost),
        withoutStock: variantCount(await withoutStock),
      }))
      .then((next) => {
        if (isCurrent()) {
          setAttention(next);
        }
      })
      .catch(() => {
        if (isCurrent()) {
          setAttention(null);
        }
      });
    return () => {
      latest.current += 1;
    };
  }, [enabled, organizationId, version]);
  return useMemo(
    () => (attention === null ? [] : stockAttentionLinks(attention)),
    [attention]
  );
}
