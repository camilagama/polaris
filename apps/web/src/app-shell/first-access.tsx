import { type ReactNode, useEffect, useState } from "react";
import {
  closedStorePath,
  wantsNewStore,
  withoutOpeningMarks,
} from "../lib/closed-store-path";
import { browserStorage } from "../lib/current-organization-model";
import { orpcClient } from "../lib/orpc";
import { rememberClosedStores } from "../organization/closed-stores-memory";
import { PageLoading } from "./page-loading";

/**
 * An account with no active store (L6): an owner whose stores are all closed goes to the closed store's panel, not to
 * "Abra a sua loja"; anyone else (no closed store, or not its owner: `listClosed` lists only the owner's) gets the
 * form, as before. `listClosed` is read only here, after `listMine` came back empty, so the common path makes no call
 * more. "Abrir outra loja" of the panel opens the form at once. A failed read gives the form: opening a store is
 * allowed with a closed one, and the server keeps the limit of one active store.
 */
export function FirstAccess({ children }: { children: ReactNode }) {
  const [checking, setChecking] = useState(
    () => !wantsNewStore(window.location.search)
  );

  useEffect(() => {
    if (wantsNewStore(window.location.search)) {
      window.history.replaceState(
        window.history.state,
        "",
        withoutOpeningMarks(window.location.pathname, window.location.search)
      );
    }
  }, []);

  useEffect(() => {
    if (!checking) {
      return;
    }
    let current = true;
    orpcClient.organization
      .listClosed()
      .then(({ organizations }) => {
        rememberClosedStores(browserStorage(), organizations);
        const [only, ...more] = organizations.filter(
          (store) => store.phase !== "purged"
        );
        if (!current) {
          return;
        }
        if (only) {
          window.location.replace(
            closedStorePath(more.length === 0 ? { storeId: only.id } : {})
          );
          return;
        }
        setChecking(false);
      })
      .catch(() => {
        if (current) {
          setChecking(false);
        }
      });
    return () => {
      current = false;
    };
  }, [checking]);

  return checking ? <PageLoading fullPage /> : children;
}
