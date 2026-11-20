import type { Page, Request } from "@playwright/test";

/**
 * Runs the page clock and then sends one call of its own: it reaches the route after any resend the run let go,
 * so a count read right after is not early. The sentinel path needs a route the test serves, and `page.clock.install()` comes before
 * the page opens. A sentinel that no route of the test answers (it went to the server, which has no ordering to give)
 * fails here, not as a count that is silently early.
 */
export async function runClockFor(
  page: Page,
  milliseconds: number,
  sentinel = "/rpc/settle"
) {
  await page.clock.runFor(milliseconds);
  const sent: Request[] = [];
  const onRequest = (request: Request) => {
    if (new URL(request.url()).pathname === sentinel) {
      sent.push(request);
    }
  };
  page.on("request", onRequest);
  try {
    await page.evaluate((path) => fetch(path).catch(() => undefined), sentinel);
  } finally {
    page.off("request", onRequest);
  }
  if (sent.length === 0) {
    throw new Error(
      `runClockFor: the sentinel ${sentinel} never went out through the page, so nothing ordered the count after the run.`
    );
  }
  for (const request of sent) {
    // biome-ignore lint/performance/noAwaitInLoops: one request in practice, and each answer is read in turn
    const response = await request.response();
    if (response && (await response.serverAddr()) !== null) {
      throw new Error(
        `runClockFor: the sentinel ${sentinel} reached the server, not a route of the test. Serve it with page.route and answer it, or pass the path of a route the test already serves.`
      );
    }
  }
}
