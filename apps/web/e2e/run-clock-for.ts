import type { Page } from "@playwright/test";

/**
 * Runs the page clock and then sends one call of its own: it reaches the route after any resend the run let go,
 * so a count read right after is not early. The sentinel path needs a route the test serves; `page.clock.install()` comes before the page opens.
 */
export async function runClockFor(
  page: Page,
  milliseconds: number,
  sentinel = "/rpc/settle"
) {
  await page.clock.runFor(milliseconds);
  await page.evaluate((path) => fetch(path).catch(() => undefined), sentinel);
}
