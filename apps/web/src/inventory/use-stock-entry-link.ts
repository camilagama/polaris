import type { InventoryBalanceEntryReadModel } from "@polaris/contracts";
import { useEffect, useRef, useState } from "react";
import { replaceAddress } from "../app-shell/address";
import { orpcClient } from "../lib/orpc";
import { readWithRetry } from "../lib/read-with-retry";
import {
  filterLocalStockEntries,
  localStockEntries,
  readLocalCatalog,
} from "../offline/local-stock-entries";
import type { LocalWorkspace } from "../offline/runtime/use-local-workspace";
import { readStockEntryRequest, withoutStockEntry } from "./stock-entry-link";
import { stockEntryRequest } from "./stock-list-model";

export type StockEntryLookup =
  | { status: "none" }
  | { status: "loading" }
  | { entry: InventoryBalanceEntryReadModel; status: "found" }
  | { status: "missing" };

const NONE: StockEntryLookup = { status: "none" };
const LOADING: StockEntryLookup = { status: "loading" };
const MISSING: StockEntryLookup = { status: "missing" };

/**
 * The variant a link from the sale (`?entrada=`) asks to receive stock for. The parameter is taken out of the address
 * at once (a reload does not reopen the panel); the variant is read by id, from the device when there is no connection.
 * Anything that cannot be read is `missing`, which the screen says in a line and never as an error.
 */
export function useStockEntryLink(
  organizationId: string,
  local: LocalWorkspace | null
): StockEntryLookup {
  const [request] = useState(() =>
    readStockEntryRequest(window.location.search)
  );
  const [lookup, setLookup] = useState<StockEntryLookup>(() => {
    if (request === null) {
      return NONE;
    }
    return request.variantId === null ? MISSING : LOADING;
  });
  const settled = useRef(lookup.status !== "loading");
  const localWriter = local?.stores.writer;
  const localOutbox = local?.stores.outbox;
  const variantId = request?.variantId ?? null;

  useEffect(() => {
    if (request === null) {
      return;
    }
    replaceAddress(
      `${window.location.pathname}${withoutStockEntry(window.location.search)}${window.location.hash}`
    );
  }, [request]);

  useEffect(() => {
    if (variantId === null || settled.current) {
      return;
    }
    let current = true;
    const finish = (entry: InventoryBalanceEntryReadModel | undefined) => {
      if (!current) {
        return;
      }
      settled.current = true;
      setLookup(entry ? { entry, status: "found" } : MISSING);
    };
    const read =
      localWriter && localOutbox
        ? readLocalCatalog(localWriter, localOutbox).then(
            (rows) =>
              filterLocalStockEntries(localStockEntries(rows), {
                productStatus: "all",
                variantIds: [variantId],
              }).entries[0]
          )
        : readWithRetry(
            () =>
              orpcClient.inventory.listBalances(
                stockEntryRequest(organizationId, variantId)
              ),
            { isCurrent: () => current }
          ).then((page) => page.entries[0]);
    read.then(finish).catch(() => finish(undefined));
    return () => {
      current = false;
    };
  }, [localOutbox, localWriter, organizationId, variantId]);

  return lookup;
}
