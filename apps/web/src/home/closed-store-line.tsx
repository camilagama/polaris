import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/ui/alert";
import {
  closedStorePath,
  justReopened,
  withoutOpeningMarks,
} from "../lib/closed-store-path";
import { browserStorage } from "../lib/current-organization-model";
import { REOPENED_TEXT } from "../organization/closed-store-model";
import {
  CLOSED_STORE_LINE_LINK,
  closedStoreLineText,
  closedStoresBeside,
  readClosedStores,
} from "../organization/closed-stores-memory";
import { TEXT_LINK } from "../sign-in/entry-ui";

/**
 * The owner has an active store and a closed one (L6): one discreet line per closed store, with "Ver". The list is
 * the one this browser already read for the panel (no read of its own on each opening of the Início).
 */
export function ClosedStoreLine({
  activeIds,
}: {
  activeIds: readonly string[];
}) {
  const [stores] = useState(() =>
    closedStoresBeside(readClosedStores(browserStorage()), activeIds)
  );
  if (stores.length === 0) {
    return null;
  }
  return (
    <ul className="m-0 grid list-none gap-1 p-0 text-muted-foreground text-support">
      {stores.map((store) => (
        <li key={store.id}>
          {closedStoreLineText(store.name)}{" "}
          <a
            className={TEXT_LINK}
            href={closedStorePath({ storeId: store.id })}
          >
            {CLOSED_STORE_LINE_LINK}
            <span className="sr-only"> a loja encerrada {store.name}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/** Right after the closure was undone on the panel: said once, and the mark leaves the address. */
export function ReopenedNotice() {
  const [shown] = useState(() => justReopened(window.location.search));
  useEffect(() => {
    if (shown) {
      window.history.replaceState(
        window.history.state,
        "",
        withoutOpeningMarks(window.location.pathname, window.location.search)
      );
    }
  }, [shown]);
  if (!shown) {
    return null;
  }
  return (
    <Alert role="status">
      <AlertDescription className="text-foreground">
        {REOPENED_TEXT}
      </AlertDescription>
    </Alert>
  );
}
