import type { APIRequestContext, APIResponse } from "@playwright/test";
import { createJourneyUser, expect, test } from "../fixtures";
import { journeyName } from "../journey-names";

/**
 * The /rpc rate limit of the preview, with the limits of `wrangler.jsonc` (t400): reads count in a bucket of their
 * own (600 per minute per session, 1800 per address) and writes in the old one (120 per minute per session and per
 * address). Each test has its own user, so its own session and address (journeyClientIp): its buckets start empty.
 * The local limiter counts in windows aligned to the minute of the clock, so a burst starts early in a minute.
 */
const WINDOW_MS = 60_000;
/** A burst that starts later than this into the minute could straddle two windows. */
const LATEST_START_MS = 40_000;

async function startOfAFreshWindow() {
  const into = Date.now() % WINDOW_MS;
  if (into > LATEST_START_MS) {
    await new Promise((resolve) => setTimeout(resolve, WINDOW_MS - into + 200));
  }
}

function call(
  request: APIRequestContext,
  origin: string,
  headers: Headers,
  procedure: string,
  input: unknown
): Promise<APIResponse> {
  return request.post(`/rpc/${procedure}`, {
    data: { json: input },
    headers: {
      ...Object.fromEntries(headers),
      "content-type": "application/json",
      origin,
    },
  });
}

test("uma rajada de 150 leituras numa sessão não toma 429", async ({
  request,
}, testInfo) => {
  test.setTimeout(WINDOW_MS + 60_000);
  const origin = String(testInfo.project.use.baseURL);
  const user = await createJourneyUser(
    origin,
    journeyName("pilha", "limite-leitura", testInfo.retry)
  );
  const { organization } = await user.rpc.organization.createInitial({
    name: user.name,
    timezone: "America/Sao_Paulo",
  });
  await startOfAFreshWindow();

  const statuses: number[] = [];
  for (let n = 0; n < 150; n += 1) {
    // the pull of a device that is up to date, one after the other, as the app makes them
    // biome-ignore lint/performance/noAwaitInLoops: the order of the burst is what is measured
    const response = await call(request, origin, user.headers, "sync/pull", {
      cursor: "0",
      limit: 500,
      organizationId: organization.id,
    });
    statuses.push(response.status());
  }

  expect(statuses).toHaveLength(150);
  expect(statuses.filter((status) => status === 429)).toEqual([]);
  expect(statuses.every((status) => status === 200)).toBe(true);
});

test("130 escritas numa sessão tomam 429 a partir da 121ª", async ({
  request,
}, testInfo) => {
  test.setTimeout(WINDOW_MS + 60_000);
  const origin = String(testInfo.project.use.baseURL);
  const user = await createJourneyUser(
    origin,
    journeyName("pilha", "limite-escrita", testInfo.retry)
  );
  await startOfAFreshWindow();

  const statuses: number[] = [];
  for (let n = 0; n < 130; n += 1) {
    // a write with an input the contract refuses: the limit counts it before the input is read, and the database is
    // not touched (400 within the limit, 429 past it)
    // biome-ignore lint/performance/noAwaitInLoops: the order of the burst is what is measured
    const response = await call(
      request,
      origin,
      user.headers,
      "category/create",
      {}
    );
    statuses.push(response.status());
    if (response.status() === 429) {
      expect(response.headers()["retry-after"]).toBe("60");
      expect(await response.json()).toMatchObject({
        error: { code: "rate_limited" },
      });
    }
  }

  expect(statuses).toHaveLength(130);
  expect(statuses.indexOf(429) + 1).toBe(121);
  expect(statuses.slice(0, 120).every((status) => status === 400)).toBe(true);
  expect(statuses.slice(120).every((status) => status === 429)).toBe(true);
});
