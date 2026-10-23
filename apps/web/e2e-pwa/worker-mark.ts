import type { Page } from "@playwright/test";

/**
 * The mark the Worker puts on every response (emenda do ADR 0043): an `X-Request-Id` with a UUID. Every
 * simulated response of /rpc and /api/auth carries it, or the client treats it as no answer from the Worker.
 */
export const WORKER_MARK = {
  "x-request-id": "0199c2d0-0000-7000-8000-00000000e2e0",
} as const;

/**
 * `GET /health` as the Worker answers it, for the pages the tests take offline and back online: the static
 * server has no `/health`, and the client only returns to "online" with a marked answer. While the context
 * is offline (`context.setOffline(true)`) or when `unreachable()` says the scenario has no network, the request fails, since a fulfilled route would not.
 */
async function serveHealth(
  page: Page,
  unreachable: () => boolean = () => false
) {
  const context = page.context();
  let offline = false;
  const setOffline = context.setOffline.bind(context);
  context.setOffline = async (value: boolean) => {
    offline = value;
    await setOffline(value);
  };
  await page.route("**/health", (route) =>
    offline || unreachable()
      ? route.abort("internetdisconnected")
      : route.fulfill({
          body: JSON.stringify({ status: "ok" }),
          contentType: "application/json",
          headers: { ...WORKER_MARK },
        })
  );
}

/**
 * The network of the offline screens lab: its simulated server sits in the page, but each push and pull
 * first calls the Worker (`GET /rpc/__screens-lab`, answered 404 with the mark), as the app's sync does, and
 * the connection probes `/health`. The static server has neither, so they are served here; a test cuts them
 * (`route.abort`) to make the network lie.
 */
export async function serveLabWorker(page: Page) {
  await serveHealth(page);
  await page.route("**/rpc/__screens-lab", (route) =>
    route.fulfill({
      body: JSON.stringify({ error: { code: "not_found" } }),
      contentType: "application/json",
      headers: { ...WORKER_MARK },
      status: 404,
    })
  );
}
