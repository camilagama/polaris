/// <reference lib="dom" />

import type { Page } from "@playwright/test";
import { createJourneySession, expect, openJourney, test } from "../fixtures";

/**
 * Reloading right after "Sair" on the real stack (the build that is deployed: service worker, offline runtime, Better
 * Auth, the real sign-out): the sign-in screen shows every time, never an empty `#root`, and the first load does not
 * need a second one (`public/boot-retry.js` marks the tab each time it reloads the page). "Right after" is the moment
 * the server answered the sign-out, with the page still leaving. The sign-out ends the server session, so a round
 * cannot reuse the one before: the device used for days gets a new session of its user each round, and each first
 * visit is a context, a user and a store of its own.
 */
const ROUNDS = 20;
/** A first visit costs a whole runtime start each round (about 20 s); the 20 first visits are `e2e-pwa/sair-e-recarregar.e2e.ts`. */
const FIRST_VISIT_ROUNDS = 5;
const MOUNT_MS = 10_000;
const RUNTIME_MS = 30_000;
const ENTRY_RELOAD_MARK = "polaris:entry-reload";
const SIGN_OUT = /\/api\/auth\/sign-out$/;
const SIGN_IN_HEADING = "Entrar no Polaris";
const STORE_MENU_NAME = /^Loja, conta e ajuda: /;
const REFUSED_SESSION = /status of 401/;
const SIGN_IN_ADDRESS = /\/entrar/;
const TRANSIENT = /ERR_ABORTED|detached|Not attached to an active page/;

type Sql = Parameters<Parameters<typeof test>[2]>[0]["sql"];

/** Offline is a Pro capability and the stack has no provider: the billing record of an active subscription. */
async function makePro(sql: Sql, organizationId: string): Promise<void> {
  await sql.query(
    `INSERT INTO organization_billing (organization_id, state, access_ends_at, cycle_months)
     VALUES ($1, 'active', now() + interval '365 days', 1)`,
    [organizationId]
  );
}

async function watchBootRetry(page: Page) {
  const retries: string[] = [];
  await page.exposeFunction("polarisBootRetry", (url: string) => {
    retries.push(url);
  });
  await page.addInitScript((key) => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name: string, value: string) {
      if (name === key) {
        (
          window as unknown as { polarisBootRetry: (url: string) => void }
        ).polarisBootRetry(window.location.href);
      }
      return set.call(this, name, value);
    };
  }, ENTRY_RELOAD_MARK);
  return retries;
}

function watchPage(page: Page) {
  const seen = { documents: [] as string[], log: [] as string[] };
  page.on("console", (message) => {
    if (message.type() === "error" && !REFUSED_SESSION.test(message.text())) {
      seen.log.push(message.text());
    }
  });
  page.on("pageerror", (error) => seen.log.push(String(error)));
  page.on("requestfailed", (request) => {
    if (request.resourceType() === "script") {
      seen.log.push(`script failed: ${request.url()}`);
    }
  });
  page.on("request", (request) => {
    if (request.resourceType() === "document") {
      seen.documents.push(new URL(request.url()).pathname);
    }
  });
  return seen;
}

async function signOutAndReload(page: Page) {
  // "Sair" looks at the queue of the device, which exists once the runtime has opened it ("depois que o app terminar de abrir")
  await expect(
    page.getByRole("status").filter({ hasText: "Tudo sincronizado" })
  ).toBeVisible({ timeout: RUNTIME_MS });
  await page.getByRole("button", { name: STORE_MENU_NAME }).click();
  const answered = page.waitForResponse(SIGN_OUT);
  await page.getByRole("menuitem", { exact: true, name: "Sair" }).click();
  await answered;
  // a reload that met the page's own move to the start did not happen: it is asked again once the page reached the sign-in address
  for (let attempt = 1; ; attempt += 1) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: the second ask only follows a reload that did not happen
      await page.reload({ waitUntil: "commit" });
      return;
    } catch (error) {
      if (!TRANSIENT.test(String(error)) || attempt === 3) {
        throw error;
      }
      await page.waitForURL(SIGN_IN_ADDRESS, { waitUntil: "commit" });
    }
  }
}

async function expectSignInAfterReload(
  page: Page,
  retries: string[],
  round: number
) {
  const seen = watchPage(page);
  await signOutAndReload(page);
  await expect(
    page.getByRole("heading", { level: 1, name: SIGN_IN_HEADING }),
    `round ${round}: the sign-in screen after the reload`
  ).toBeVisible({ timeout: MOUNT_MS });
  await page.waitForLoadState("load");
  expect(
    retries,
    `round ${round}: the entry module did not run and the page reloaded itself (documents ${seen.documents.join(" ")})`
  ).toEqual([]);
  expect(seen.log, `round ${round}: the browser log`).toEqual([]);
}

const storeMenu = (page: Page) =>
  page.getByRole("button", { name: STORE_MENU_NAME });

/**
 * One device used for days: the worker is in control from the first round on and stays so, and each round is a new
 * session of the same user (the sign-out ended the one before).
 */
test(`sair e recarregar logo em seguida, ${ROUNDS} vezes, no mesmo aparelho com o worker já no controle: a tela de entrar sempre aparece`, async ({
  browser,
  sql,
}, testInfo) => {
  test.setTimeout(ROUNDS * 30_000);
  const journey = await openJourney(browser, testInfo, "sair-recarregar-usado");
  const { page } = journey;
  await makePro(sql, journey.organizationId as string);
  const retries = await watchBootRetry(page);
  const origin = String(testInfo.project.use.baseURL);
  await page.goto("/");
  await expect(storeMenu(page)).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect
    .poll(() =>
      page.evaluate(() => navigator.serviceWorker.controller !== null)
    )
    .toBe(true);
  for (let round = 1; round <= ROUNDS; round += 1) {
    if (round > 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each round starts from the sign-in screen the round before left
      const cookies = await createJourneySession(origin, journey.user);
      await page.context().addCookies(cookies);
      await page.goto("/");
    }
    await expect(storeMenu(page)).toBeVisible();
    expect(
      await page.evaluate(() => navigator.serviceWorker.controller !== null),
      `round ${round}: the worker is in control`
    ).toBe(true);
    await expectSignInAfterReload(page, retries, round);
  }
});

/** A first visit: a device with nothing yet (a context of its own), the runtime opened for the first time when "Sair" is used. */
test(`sair e recarregar logo em seguida, ${FIRST_VISIT_ROUNDS} vezes, na primeira visita, com o worker recém-instalado: a tela de entrar sempre aparece`, async ({
  browser,
  sql,
}, testInfo) => {
  test.setTimeout(FIRST_VISIT_ROUNDS * 40_000);
  for (let round = 1; round <= FIRST_VISIT_ROUNDS; round += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: one device at a time, each with the session its sign-out ends
    const journey = await openJourney(
      browser,
      testInfo,
      `sair-recarregar-novo-${round}`
    );
    const { page } = journey;
    try {
      await makePro(sql, journey.organizationId as string);
      const retries = await watchBootRetry(page);
      await page.goto("/");
      await expect(storeMenu(page)).toBeVisible();
      await expectSignInAfterReload(page, retries, round);
    } finally {
      await page.context().close();
    }
  }
});
