import type {
  InventoryBalanceEntryReadModel,
  InventoryBalanceReadModel,
  PaymentProfileReadModel,
} from "@polaris/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { orpcClient } from "../lib/orpc";
import {
  filterLocalStockEntries,
  localStockEntries,
  readLocalCatalog,
} from "../offline/local-stock-entries";
import type { LocalWorkspace } from "../offline/runtime/use-local-workspace";
import { type Loadable, loadErrorMessage } from "./sale-form-model";
import {
  balanceOfEntry,
  chunkIds,
  lineBalancesRequest,
  stockAfterRefresh,
} from "./sale-variant-picker-model";

type LoadableMap<T> = Record<string, Loadable<T>>;

interface SaleCatalog {
  profiles: Loadable<PaymentProfileReadModel[]>;
  /**
   * Reloads the payment profiles and re-reads the balances of the variants on
   * the sale, all variants in one call (two for more than 100 lines).
   */
  refresh: (variantIds: readonly string[]) => void;
  /** Forgets the cached balances, e.g. after a confirmed sale moved stock. */
  resetStock: () => void;
  /** Keeps the balances a search already returned, so lines need no read. */
  seedStock: (entries: readonly InventoryBalanceEntryReadModel[]) => void;
  stock: LoadableMap<InventoryBalanceReadModel>;
}

function keepReady<T>(current: Loadable<T>): Loadable<T> {
  return current.status === "ready" ? current : { status: "loading" };
}

/**
 * Read-only data the sale form needs: the payment profiles and the balances of
 * the variants on the sale. Variants are found by the picker's search (one read
 * per search), never one request per product or per variant.
 *
 * With a local workspace (no connection, the sale will be queued on the device)
 * nothing is read from the server: there are no payment profiles, and the
 * balances come from the device's collections with the queue applied.
 */
export function useSaleCatalog(
  organizationId: string,
  onProfilesLoaded: (profiles: PaymentProfileReadModel[]) => void,
  local: LocalWorkspace | null = null
): SaleCatalog {
  const localRef = useRef(local);
  localRef.current = local;
  const usesLocal = local !== null;
  const [profiles, setProfiles] = useState<Loadable<PaymentProfileReadModel[]>>(
    { status: "loading" }
  );
  const [stock, setStock] = useState<LoadableMap<InventoryBalanceReadModel>>(
    {}
  );
  const generation = useRef(0);

  const loadProfiles = useCallback(async () => {
    if (usesLocal) {
      setProfiles({ status: "ready", value: [] });
      onProfilesLoaded([]);
      return;
    }
    setProfiles(keepReady);
    try {
      const result = await orpcClient.paymentProfile.list({
        organizationId,
        status: "active",
      });
      setProfiles({ status: "ready", value: result.profiles });
      onProfilesLoaded(result.profiles);
    } catch (error) {
      setProfiles({
        message: loadErrorMessage(error, "os perfis de pagamento"),
        status: "error",
      });
    }
  }, [onProfilesLoaded, organizationId, usesLocal]);

  useEffect(() => {
    loadProfiles().catch(() => undefined);
  }, [loadProfiles]);

  const seedStock = useCallback(
    (entries: readonly InventoryBalanceEntryReadModel[]) => {
      setStock((map) => {
        const next = { ...map };
        for (const entry of entries) {
          next[entry.variantId] = {
            status: "ready",
            value: balanceOfEntry(entry),
          };
        }
        return next;
      });
    },
    []
  );

  const resetStock = useCallback(() => {
    generation.current += 1;
    setStock({});
  }, []);

  const refresh = useCallback(
    (variantIds: readonly string[]) => {
      generation.current += 1;
      const { current } = generation;
      loadProfiles().catch(() => undefined);
      if (variantIds.length === 0) {
        return;
      }
      const workspace = localRef.current;
      if (workspace) {
        const { outbox, writer } = workspace.stores;
        readLocalCatalog(writer, outbox)
          .then((rows) => {
            if (generation.current === current) {
              const { entries } = filterLocalStockEntries(
                localStockEntries(rows),
                { productStatus: "all", variantIds }
              );
              setStock((map) => stockAfterRefresh(map, variantIds, entries));
            }
          })
          .catch((error: unknown) => {
            if (generation.current === current) {
              setStock((map) => {
                const next = { ...map };
                for (const variantId of variantIds) {
                  next[variantId] = {
                    message: loadErrorMessage(error, "o estoque do aparelho"),
                    status: "error",
                  };
                }
                return next;
              });
            }
          });
        return;
      }
      setStock((map) => {
        const next = { ...map };
        for (const variantId of variantIds) {
          next[variantId] = { status: "loading" };
        }
        return next;
      });
      for (const chunk of chunkIds(variantIds)) {
        orpcClient.inventory
          .listBalances(lineBalancesRequest(organizationId, chunk))
          .then(({ entries }) => {
            if (generation.current === current) {
              setStock((map) => stockAfterRefresh(map, chunk, entries));
            }
          })
          .catch((error: unknown) => {
            if (generation.current === current) {
              setStock((map) => {
                const next = { ...map };
                for (const variantId of chunk) {
                  next[variantId] = {
                    message: loadErrorMessage(error, "o estoque"),
                    status: "error",
                  };
                }
                return next;
              });
            }
          });
      }
    },
    [loadProfiles, organizationId]
  );

  return { profiles, refresh, resetStock, seedStock, stock };
}
