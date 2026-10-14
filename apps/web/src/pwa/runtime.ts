import { createUpdateStore, type UpdateStore } from "./update-store";

/**
 * The update store of the running page (plan PR61): one per page, created on
 * first use, null where there is no service worker support. `main.tsx` attaches
 * the registration to it; the offline runtime hands it the outbox with
 * `getUpdateStore()?.setWorkSource(...)` once the app reads one.
 */
let store: UpdateStore | null | undefined;

export function getUpdateStore(): UpdateStore | null {
  if (store === undefined) {
    store =
      typeof navigator !== "undefined" && "serviceWorker" in navigator
        ? createUpdateStore({
            container: navigator.serviceWorker,
            reload: () => window.location.reload(),
          })
        : null;
  }
  return store;
}

const CHECK_EVERY_MS = 60 * 60 * 1000;

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
