/// <reference lib="dom" />

import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { buildOfflineLeaseClaims } from "@polaris/domain/offline/offline-lease";
import { signOfflineLease } from "../src/lib/offline-lease-token";
import { WORKER_MARK } from "./worker-mark";

/**
 * How often the real offline runtime pulls (t400): one pull per tick per browser, whatever the number of tabs
 * (the tab holding the Web Lock pulls, the others hear it through the data channel), and no pull for a page
 * load when a tab pulled less than a tick ago (each screen is a page load; that was the ~2.5 s pull of the
 * QA of 26/10). The server is simulated by network interception, for the whole context: both tabs are counted.
 */
const ORGANIZATION_ID = "0199c2d0-0000-7000-8000-00000000a001";
const USER_ID = "user-do-teste";
const LEASE_KEY = {
  id: "teste",
  secret: "teste-secret-teste-secret-teste-secret-0123456789",
};
const HOUR = 3_600_000;
const TICK_MS = 60_000;
const DEVICE = {
  createdAt: "2026-10-01T12:00:00.000Z",
  id: "0199c2d0-0000-7000-8000-000000000001",
  label: "Caixa da loja",
  lastSeenAt: "2026-10-14T10:00:00.000Z",
  revokedAt: null,
};

const json = (body: unknown, status = 200) => ({
  body: JSON.stringify({ json: body, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
  status,
});
const inputOf = (route: { request: () => { postDataJSON: () => unknown } }) =>
  (route.request().postDataJSON() as { json: Record<string, unknown> }).json;

/** The server, for every tab of the context; returns the count of `sync/pull` calls. */
async function serve(context: BrowserContext) {
  const pulls = { count: 0 };
  await context.route("**/health", (route) =>
    route.fulfill({
      body: JSON.stringify({ status: "ok" }),
      contentType: "application/json",
      headers: { ...WORKER_MARK },
    })
  );
  // whatever else a screen reads answers "not here", with the mark: an answer, so the connection stays proven
  await context.route("**/rpc/**", (route) =>
    route.fulfill(
      json(
        {
          code: "NOT_FOUND",
          defined: false,
          message: "NOT_FOUND",
          status: 404,
        },
        404
      )
    )
  );
  await context.route("**/rpc/organization/listMine", (route) =>
    route.fulfill(
      json({
        organizations: [
          {
            id: ORGANIZATION_ID,
            name: "Loja do teste",
            role: "owner",
            timezone: "America/Sao_Paulo",
          },
        ],
      })
    )
  );
  await context.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      body: JSON.stringify({ user: { id: USER_ID } }),
      contentType: "application/json",
      headers: { ...WORKER_MARK },
    })
  );
  await context.route("**/rpc/device/register", (route) =>
    route.fulfill(json({ device: DEVICE }))
  );
  await context.route("**/rpc/device/check", (route) =>
    route.fulfill(json({ device: DEVICE }))
  );
  await context.route("**/rpc/device/list", (route) =>
    route.fulfill(json({ devices: [DEVICE] }))
  );
  await context.route("**/rpc/offline/issueLease", async (route) => {
    const input = inputOf(route) as {
      deviceId: string;
      organizationId: string;
    };
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 72 * HOUR);
    const grantId = "0199c2d0-0000-7000-8000-000000000901";
    const lease = await signOfflineLease(
      buildOfflineLeaseClaims({
        capabilities: ["customer:create", "customer:update"],
        deviceId: input.deviceId,
        epoch: 0,
        expiresAt,
        grantId,
        issuedAt,
        organizationId: input.organizationId,
        userId: USER_ID,
      }),
      LEASE_KEY
    );
    await route.fulfill(
      json({
        expiresAt: expiresAt.toISOString(),
        grantId,
        issuedAt: issuedAt.toISOString(),
        lease,
      })
    );
  });
  await context.route("**/rpc/sync/getCursor", (route) =>
    route.fulfill(json({ cursor: "0" }))
  );
  await context.route("**/rpc/sync/bootstrapPage", (route) =>
    route.fulfill(
      json({
        collection: (inputOf(route) as { collection: string }).collection,
        nextAfterId: null,
        rows: [],
      })
    )
  );
  await context.route("**/rpc/sync/pull", (route) => {
    pulls.count += 1;
    return route.fulfill(
      json({ changes: [], hasMore: false, nextCursor: "0" })
    );
  });
  await context.route("**/rpc/sale/list", (route) =>
    route.fulfill(json({ hasMore: false, sales: [] }))
  );
  return pulls;
}

const chip = (page: Page) => page.locator(".sync-status");

/**
 * Opens a screen and waits until the runtime says it is in sync, and a little more: the sync of the page load
 * (or its skipping) is decided once the runtime is ready, which the chip already shows.
 */
async function openSynced(page: Page, path: string) {
  await page.goto(path);
  await expect(chip(page)).toContainText("Tudo sincronizado", {
    timeout: 20_000,
  });
  await page.waitForTimeout(1500);
  await expect(chip(page)).toContainText("Tudo sincronizado");
}

test("duas abas fazem um pull por ciclo, não dois (t400)", async ({
  context,
}) => {
  test.setTimeout(TICK_MS * 2 + 60_000);
  const pulls = await serve(context);
  const first = await context.newPage();
  const second = await context.newPage();
  await openSynced(first, "/customers");
  await openSynced(second, "/devices");
  // both tabs are in front and the Web Locks are there, the conditions of the leader
  for (const page of [first, second]) {
    // biome-ignore lint/performance/noAwaitInLoops: two tabs, one after the other
    expect(await page.evaluate(() => document.visibilityState)).toBe("visible");
    expect(await page.evaluate(() => typeof navigator.locks?.request)).toBe(
      "function"
    );
  }
  const atStart = pulls.count;

  // a whole tick of each tab (they started a few seconds apart), and a margin
  await first.waitForTimeout(TICK_MS + 5000);

  expect(pulls.count - atStart).toBe(1);
});

test("trocar de tela não puxa de novo quando uma aba puxou há menos de um ciclo (t400)", async ({
  page,
}) => {
  const pulls = await serve(page.context());
  await openSynced(page, "/customers");
  const pulledAt = Date.now();
  const afterStart = pulls.count;
  expect(afterStart).toBeGreaterThanOrEqual(1);

  // each screen is a page load, and each load started a sync with a pull
  for (const path of ["/devices", "/customers", "/devices", "/customers"]) {
    // biome-ignore lint/performance/noAwaitInLoops: one screen after the other, as a person does
    await openSynced(page, path);
  }

  // past a tick the copy is old and a load pulls, rightly: the loads above must fit in one
  expect(Date.now() - pulledAt).toBeLessThan(TICK_MS);
  expect(pulls.count).toBe(afterStart);
});
