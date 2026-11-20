import type { Page, Request, Response } from "@playwright/test";

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
  const isSentinel = (request: Request) =>
    new URL(request.url()).pathname === sentinel;
  const responses: Response[] = [];
  let failures = 0;
  const onResponse = (response: Response) => {
    if (isSentinel(response.request())) {
      responses.push(response);
    }
  };
  const onFailed = (request: Request) => {
    if (isSentinel(request)) {
      failures += 1;
    }
  };
  page.on("response", onResponse);
  page.on("requestfailed", onFailed);
  try {
    await page.clock.runFor(milliseconds);
    await page.evaluate((path) => fetch(path).catch(() => undefined), sentinel);
  } finally {
    page.off("response", onResponse);
    page.off("requestfailed", onFailed);
  }
  const addresses = await Promise.all(
    responses.map((response) => response.serverAddr())
  );
  if (failures + responses.length === 0) {
    throw new Error(
      `runClockFor: the sentinel ${sentinel} never went out through the page, so nothing ordered the count after the run.`
    );
  }
  if (addresses.some((address) => address !== null)) {
    throw new Error(
      `runClockFor: the sentinel ${sentinel} reached the server, not a route of the test. Serve it with page.route and answer it, or pass the path of a route the test already serves.`
    );
  }
}
