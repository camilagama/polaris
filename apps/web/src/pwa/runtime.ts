import { OFFLINE_RUNTIME_ENABLED } from "../offline/runtime/enabled";
import { keepScrollForReload, startAutoSwap } from "./auto-swap";
import { readPageSwapState, subscribePageSwapState } from "./swap-guard";
import type { RegistrationLike } from "./update-controller";
import { workSourceBeforeRuntime } from "./update-model";
import { createUpdateStore, type UpdateStore } from "./update-store";

/**
 * The update store of the running page (plan PR61, ADR 0041): one per page, created on first use, null where there
 * is no service worker support. `main.tsx` attaches the registration to it and starts the swaps; the offline runtime
 * hands it the outbox with `getUpdateStore()?.setWorkSource(...)` once the app reads one.
 */
let store: UpdateStore | null | undefined;

export function getUpdateStore(): UpdateStore | null {
  if (store === undefined) {
    store =
      typeof navigator !== "undefined" && "serviceWorker" in navigator
        ? createUpdateStore({
            container: navigator.serviceWorker,
            keepScreen: (moment) => {
              // the swap with the tab in front comes back exactly where it was; the others open as a load does
              if (moment === "idle") {
                keepScrollForReload();
              }
            },
            readGuard: readPageSwapState,
            reload: () => window.location.reload(),
            workSource: workSourceBeforeRuntime(OFFLINE_RUNTIME_ENABLED),
          })
        : null;
  }
  return store;
}

const CHECK_EVERY_MS = 60 * 60 * 1000;

/** Watches the registration and swaps to a new build at the safe moments of this page. */
export function startUpdates(
  updates: UpdateStore,
  registration: RegistrationLike
): void {
  updates.attach(registration).catch(() => undefined);
  startAutoSwap(updates, {
    addDocumentListener: (type, listener, options) =>
      document.addEventListener(type, listener, options),
    addWindowListener: (type, listener, options) =>
      window.addEventListener(type, listener, options),
    clearTimeout: (timer) => clearTimeout(timer),
    now: () => Date.now(),
    setTimeout: (run, ms) => setTimeout(run, ms),
    subscribeGuard: subscribePageSwapState,
    visibility: () => document.visibilityState,
  });
}

/** Looks for a new build when the person comes back to the app and every hour. */
export function checkForUpdatesRegularly(registration: {
  update: () => Promise<unknown>;
}): void {
  const check = () => registration.update().catch(() => undefined);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      check();
    }
  });
  setInterval(check, CHECK_EVERY_MS);
}
