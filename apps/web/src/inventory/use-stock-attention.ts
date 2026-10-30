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

export interface StockAttentionView {
  links: StockAttentionLink[];
  unavailable: boolean;
}

/**
 * The links of "Precisa de ação" on the stock screen, from the store's counts (not the list's: its filters do not
 * change them). No links while unread and without a connection (the device does not hold the cost); a failed read
 * is `unavailable`, so the screen does not say nothing needs action without having read. `version` reads again after
 * a movement or a reload.
 */
export function useStockAttention(
  organizationId: string,
  enabled: boolean,
  version: number
): StockAttentionView {
  const [attention, setAttention] = useState<StockAttention | "failed" | null>(
    null
  );
  const latest = useRef(0);
  useEffect(() => {
    latest.current += 1;
    const request = latest.current;
    if (!enabled) {
      setAttention(null);
      return;
    }
    // a new read drops the failure line: it must not stay over a screen that is reading again
    setAttention((previous) => (previous === "failed" ? null : previous));
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
          setAttention("failed");
        }
      });
    return () => {
      latest.current += 1;
    };
  }, [enabled, organizationId, version]);
  return useMemo(
    () => ({
      links:
        attention === null || attention === "failed"
          ? []
          : stockAttentionLinks(attention),
      unavailable: attention === "failed",
    }),
    [attention]
  );
}
