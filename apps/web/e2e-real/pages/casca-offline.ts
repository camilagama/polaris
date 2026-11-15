import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

/**
 * A link that is a plain `<a href>` loads the page again, and with no connection only the service worker answers that
 * load from its cache. The page loads before the worker finishes installing the shell, so a journey that goes offline
 * and then follows such a link first waits for the worker to be active: its install is the end of the caching.
 */
export async function waitForOfflineShell(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const registration = await navigator.serviceWorker.getRegistration();
          return registration?.active?.state ?? null;
        }),
      {
        message: "o service worker ativo, que serve a página sem conexão",
        timeout: 30_000,
      }
    )
    .toBe("activated");
}
