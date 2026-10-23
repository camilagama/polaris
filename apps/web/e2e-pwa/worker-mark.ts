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
export async function serveHealth(
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
