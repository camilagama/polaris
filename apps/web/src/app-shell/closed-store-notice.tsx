import TriangleAlertIcon from "lucide-react/dist/esm/icons/triangle-alert";
import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/ui/alert";
import { closedStorePath } from "../lib/closed-store-path";
import {
  browserStorage,
  clearOrganizationsCache,
} from "../lib/current-organization-model";
import {
  closedStoreToShow,
  organizationClosedOnSale,
  useOrganizationsClosedHere,
} from "../lib/organization-closed";
import { orpcClient } from "../lib/orpc";
import { clearPaymentProfileCaches } from "../lib/payment-profile-cache";
import { clearPeriodSummaryCaches } from "../lib/period-summary-cache";
import {
  useOfflineRuntime,
  useRuntimeSnapshot,
} from "../offline/runtime/runtime-context";
import {
  type ClosedStore,
  DEVICE_CLOSED_LINK,
  deviceClosedText,
} from "../organization/closed-store-model";
import { rememberClosedStore } from "../organization/closed-stores-memory";
import { TEXT_LINK } from "../sign-in/entry-ui";

/**
 * The store the server said was closed while this page used it: from any call of the page (`orpc.ts` marks it) or
 * from the runtime's own push and lease (its snapshot says so, for the store it runs).
 */
export function useClosedStoreHere(currentId: string | null): string | null {
  const marked = useOrganizationsClosedHere();
  const snapshot = useRuntimeSnapshot();
  return closedStoreToShow(
    marked,
    currentId,
    snapshot?.organizationClosed === true
  );
}

/**
 * The notice of a device whose store was closed (AC-11): it takes the place of the page, drops the device's copy and
 * leases once, as for a refused session but keeping the remembered user (the session is fine), and keeps the queue.
 * Nothing goes to the sign-in screen. The date comes from one read of the closed store, made only now; for a person
 * who is not its owner the server has nothing to show, and the notice goes without the date and the link.
 */
export function ClosedStoreNotice({
  organizationId,
}: {
  organizationId: string;
}) {
  const runtime = useOfflineRuntime();
  const [store, setStore] = useState<ClosedStore | null>(null);
  const [copyDropped, setCopyDropped] = useState(runtime === null);
  const noticeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let current = true;
    runtime
      ?.dropClosedCopy(organizationId)
      .then(() => {
        const after = runtime.getSnapshot();
        if (current) {
          setCopyDropped(
            after.organizationClosed && after.reason !== "purge_failed"
          );
        }
      })
      .catch(() => undefined);
    const storage = browserStorage();
    clearOrganizationsCache(storage);
    clearPaymentProfileCaches(storage);
    clearPeriodSummaryCaches(storage);
    orpcClient.organization
      .closedStatus({ organizationId })
      .then(({ organization }) => {
        rememberClosedStore(storage, organizationId, organization);
        if (current) {
          setStore(organization);
        }
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [organizationId, runtime]);

  useEffect(() => {
    const typing = document.activeElement?.closest(
      "input, textarea, select, [contenteditable='true']"
    );
    if (!typing) {
      noticeRef.current?.focus({ preventScroll: true });
    }
  }, []);

  return (
    <Alert
      className="focus-ring mb-4 font-sans"
      data-notice="organization-closed"
      ref={noticeRef}
      role="alert"
      tabIndex={-1}
      variant="warning"
    >
      <TriangleAlertIcon aria-hidden="true" />
      <AlertDescription className="grid justify-items-start gap-2 [&_p:not(:last-child)]:mb-0">
        <p>
          {deviceClosedText(
            store,
            copyDropped,
            organizationClosedOnSale(organizationId)
          )}
        </p>
        {store ? (
          <a
            className={TEXT_LINK}
            href={closedStorePath({ storeId: store.id })}
          >
            {DEVICE_CLOSED_LINK}
          </a>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
