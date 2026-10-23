import { useSyncExternalStore } from "react";
import { Connection } from "./connection";

/**
 * The one connection state of this tab (emenda do ADR 0043): the RPC client classifies every response
 * through it, the offline runtime reads it, and the runtime provider listens to the browser's signals and
 * schedules the syncs on it. Created once per page load, which is once per tab.
 */
const OFFLINE_SINCE_KEY = "polaris.connection.offline-since";

function markInBrowser(name: string) {
  try {
    // stays in this browser's performance timeline (DevTools); nothing is sent anywhere
    performance.mark(name);
  } catch {
    // no performance timeline: nothing to mark
  }
}

async function lockInBrowser(
  name: string,
  task: () => Promise<void>
): Promise<boolean> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (typeof locks?.request !== "function") {
    await task();
    return true;
  }
  return await locks.request(name, { ifAvailable: true }, async (lock) => {
    if (!lock) {
      return false; // another tab of this browser holds it
    }
    await task();
    return true;
  });
}

function session(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null; // storage blocked: the reload just starts online and finds out
  }
}

function createBrowserConnection(): Connection {
  return new Connection({
    // outside a browser (a test that only renders markup) there is nothing to doubt
    browserOnline: () => typeof navigator === "undefined" || navigator.onLine,
    fetch: (input, init) => globalThis.fetch(input, init),
    isVisible: () =>
      typeof document === "undefined" || document.visibilityState !== "hidden",
    lock: lockInBrowser,
    mark: markInBrowser,
    memory: {
      read: () => session()?.getItem(OFFLINE_SINCE_KEY) ?? null,
      remove: () => session()?.removeItem(OFFLINE_SINCE_KEY),
      write: (value) => session()?.setItem(OFFLINE_SINCE_KEY, value),
    },
    now: () => Date.now(),
    schedule: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    },
  });
}

export const browserConnection = createBrowserConnection();

export { lockInBrowser, markInBrowser };

/** Whether this tab reaches the Worker now; a screen re-renders when it changes. */
export function useConnectionOnline(): boolean {
  return useSyncExternalStore(
    browserConnection.subscribe,
    browserConnection.isOnline
  );
}

type TryNow = () => Promise<void>;
const tries = new Set<TryNow>();

/** The runtime provider adds its real sync attempt to "Tentar agora"; returns how to take it out. */
export function addConnectionTry(attempt: TryNow): () => void {
  tries.add(attempt);
  return () => {
    tries.delete(attempt);
  };
}

/**
 * "Tentar agora": the probe and, when the offline runtime runs, a real sync (an answer of the Worker to
 * it proves the connection even when `/health` does not get through).
 */
export async function tryConnectionNow(): Promise<void> {
  await Promise.allSettled([
    browserConnection.probeNow(),
    ...[...tries].map((attempt) => attempt()),
  ]);
}
