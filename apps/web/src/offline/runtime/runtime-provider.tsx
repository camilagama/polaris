import { type ReactNode, useEffect, useMemo } from "react";
import { useOrganizationLoad } from "../../lib/current-organization";
import { orpcClient } from "../../lib/orpc";
import { getUpdateStore } from "../../pwa/runtime";
import { wipeLocalStore } from "../local-store";
import { purgeNamespace } from "../logout-purge";
import { localNamespace } from "../namespace";
import { openBrowserDataChannel } from "./data-channel";
import { OFFLINE_RUNTIME_ENABLED } from "./enabled";
import { OfflineRuntime } from "./offline-runtime";
import { createRpcRuntimeApi } from "./runtime-api";
import { RuntimeContext } from "./runtime-context";
import { openRuntimeStores } from "./runtime-stores";

/**
 * Starts the offline runtime for the organization the person is working in and
 * keeps it syncing: when it starts, when the network comes back, when the person
 * returns to the app and every minute while it is in front. Behind a build flag
 * (VITE_OFFLINE_RUNTIME_ENABLED) that stays off in production until the physical
 * device checklist of Gate 5 is done: with it off nothing here runs, registers a
 * device or touches the disk.
 */
const SYNC_EVERY_MS = 60_000;

function createBrowserRuntime(): OfflineRuntime {
  return new OfflineRuntime({
    api: createRpcRuntimeApi(orpcClient),
    // No label: a User-Agent string is long and personal, and the server accepts at most 80 characters.
    deviceLabel: null,
    isOnline: () => navigator.onLine,
    keyValues: {
      keys: () => {
        try {
          return Object.keys(window.localStorage);
        } catch {
          return [];
        }
      },
      read: (key) => {
        try {
          return window.localStorage.getItem(key);
        } catch {
          return null;
        }
      },
      remove: (key) => {
        try {
          window.localStorage.removeItem(key);
        } catch {
          // storage unavailable: nothing to forget
        }
      },
      write: (key, value) => {
        window.localStorage.setItem(key, value);
      },
    },
    namespaceFor: localNamespace,
    openDataChannel: openBrowserDataChannel,
    openStores: openRuntimeStores,
    purge: purgeNamespace,
    wipeCollections: async (namespace) => {
      await wipeLocalStore(namespace);
    },
  });
}

export function OfflineRuntimeProvider({ children }: { children: ReactNode }) {
  const { load, reload } = useOrganizationLoad();
  const organizationId = load.status === "ready" ? load.current.id : null;
  const runtime = useMemo(
    () => (OFFLINE_RUNTIME_ENABLED ? createBrowserRuntime() : null),
    []
  );

  useEffect(() => {
    if (!(runtime && organizationId)) {
      return;
    }
    const sync = () => {
      runtime.syncNow().catch(() => undefined);
    };
    runtime
      .start(organizationId)
      .then(() => {
        getUpdateStore()?.setWorkSource(runtime.workSource());
        sync();
      })
      .catch(() => undefined);
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        sync();
      }
    };
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    document.addEventListener("visibilitychange", onVisible);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        sync();
      }
    }, SYNC_EVERY_MS);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(timer);
      runtime.stop().catch(() => undefined);
    };
  }, [organizationId, runtime]);

  // The server refused the session or the membership while the app was open:
  // read the organizations again, so the screen shows what the server now says
  // (and the cached list is dropped when the session is really over).
  useEffect(() => {
    if (!runtime) {
      return;
    }
    let handled = false;
    return runtime.subscribe(() => {
      const refused = runtime.getSnapshot().sessionRefused;
      if (refused && !handled) {
        handled = true;
        reload();
      } else if (!refused) {
        handled = false;
      }
    });
  }, [reload, runtime]);

  return (
    <RuntimeContext.Provider value={runtime}>
      {children}
    </RuntimeContext.Provider>
  );
}
