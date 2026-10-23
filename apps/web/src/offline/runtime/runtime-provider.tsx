import { type ReactNode, useEffect, useMemo, useRef } from "react";
import {
  addConnectionTry,
  browserConnection,
  lockInBrowser,
  markInBrowser,
} from "../../lib/browser-connection";
import { timerSchedule } from "../../lib/connection";
import { useOrganizationLoad } from "../../lib/current-organization";
import {
  isLegalAcceptanceRequired,
  subscribeLegalAcceptance,
} from "../../lib/legal-acceptance";
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
import { isSessionOver } from "./session-ended";
import { startSyncScheduler } from "./sync-scheduler";

/**
 * Starts the offline runtime for the organization the person is working in and
 * keeps it syncing (`startSyncScheduler`: at start, when the connection comes
 * back, when the person returns to the app, every minute while it is in front,
 * and again after a failed send). Behind a build flag
 * (VITE_OFFLINE_RUNTIME_ENABLED) that stays off in production until the physical
 * device checklist of Gate 5 is done: with it off nothing here runs, registers a
 * device or touches the disk. The connection state of the tab listens to the
 * browser either way: the screens that need a connection say so without it.
 */
function createBrowserRuntime(): OfflineRuntime {
  return new OfflineRuntime({
    api: createRpcRuntimeApi(orpcClient, browserConnection.fetch),
    // No label: a User-Agent string is long and personal, and the server accepts at most 80 characters.
    deviceLabel: null,
    exclusive: lockInBrowser,
    isOnline: browserConnection.isOnline,
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
    mark: markInBrowser,
    mayTry: () => navigator.onLine,
    namespaceFor: localNamespace,
    openDataChannel: openBrowserDataChannel,
    openStores: openRuntimeStores,
    purge: purgeNamespace,
    wipeCollections: async (namespace) => {
      await wipeLocalStore(namespace);
    },
  });
}

function onPageVisible(listener: () => void): () => void {
  const onVisibility = () => {
    if (document.visibilityState === "visible") {
      listener();
    }
  };
  document.addEventListener("visibilitychange", onVisibility);
  return () => document.removeEventListener("visibilitychange", onVisibility);
}

export function OfflineRuntimeProvider({ children }: { children: ReactNode }) {
  const { load, reload } = useOrganizationLoad();
  const organizationId = load.status === "ready" ? load.current.id : null;
  const runtime = useMemo(
    () => (OFFLINE_RUNTIME_ENABLED ? createBrowserRuntime() : null),
    []
  );

  // the browser's signals (offline, online, pageshow, the return to the page) feed the connection state
  useEffect(() => browserConnection.attach(window, document), []);

  useEffect(() => {
    if (!(runtime && organizationId)) {
      return;
    }
    let scheduler: ReturnType<typeof startSyncScheduler> | null = null;
    let stopped = false;
    const schedule = () => {
      if (stopped) {
        return;
      }
      getUpdateStore()?.setWorkSource(runtime.workSource());
      scheduler = startSyncScheduler({
        connection: browserConnection,
        isVisible: () => document.visibilityState === "visible",
        onVisible: onPageVisible,
        random: Math.random,
        runtime,
        schedule: timerSchedule,
      });
      return scheduler.syncNow();
    };
    runtime
      .start(organizationId)
      .then(schedule)
      .catch(() => undefined);
    // "Tentar agora" of the notices: the same real try as the timer's
    const removeTry = addConnectionTry(
      () => scheduler?.syncNow() ?? Promise.resolve()
    );
    return () => {
      stopped = true;
      removeTry();
      scheduler?.stop();
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
        // a screen already knows this session is over and keeps saying so: reading the organizations again would take it away
        if (!isSessionOver()) {
          reload();
        }
      } else if (!refused) {
        handled = false;
      }
    });
  }, [reload, runtime]);

  // The acceptance was recorded (in another tab, mostly: the notice opens it there when something is typed):
  // read the organizations again if they were refused for it, and let the queue go out again.
  const latest = useRef({ load, organizationId, reload });
  latest.current = { load, organizationId, reload };
  useEffect(() => {
    let waiting = isLegalAcceptanceRequired();
    return subscribeLegalAcceptance(() => {
      const required = isLegalAcceptanceRequired();
      if (waiting && !required) {
        const { current } = latest;
        if (current.load.status === "legal_acceptance_required") {
          current.reload();
        } else if (runtime && current.organizationId) {
          const restart =
            runtime.getSnapshot().phase === "unavailable"
              ? runtime.start(current.organizationId)
              : Promise.resolve();
          restart.then(() => runtime.syncNow()).catch(() => undefined);
        }
      }
      waiting = required;
    });
  }, [runtime]);

  return (
    <RuntimeContext.Provider value={runtime}>
      {children}
    </RuntimeContext.Provider>
  );
}

/**
 * A runtime that never starts, for a screen outside the store (the acceptance screen): it only lets
 * "Sair" look at the queue of this device before ending the session. Nothing syncs or registers here.
 */
export function IdleRuntimeProvider({ children }: { children: ReactNode }) {
  const runtime = useMemo(
    () => (OFFLINE_RUNTIME_ENABLED ? createBrowserRuntime() : null),
    []
  );
  return (
    <RuntimeContext.Provider value={runtime}>
      {children}
    </RuntimeContext.Provider>
  );
}
