import type { Page } from "@playwright/test";

/**
 * Runs the page clock and then sends one call of its own: it reaches the route after any resend the run let go,
 * so a count read right after is not early. Needs `page.clock.install()` before the page opens.
 */
export async function runClockFor(
  page: Page,
  milliseconds: number,
  sentinel = "/rpc/settle"
) {
  await page.clock.runFor(milliseconds);
  await page.evaluate((path) => fetch(path).catch(() => undefined), sentinel);
}
