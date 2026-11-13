/// <reference lib="dom" />

import type { Page } from "@playwright/test";
import { createJourneySession, expect, openJourney, test } from "../fixtures";

/**
 * Reloading right after "Sair" on the real stack (the build that is deployed: service worker, offline runtime, Better
 * Auth, the real sign-out): the sign-in screen shows every time, never an empty `#root`, and the first load does not
 * need a second one: neither `public/boot-retry.js` nor `app-shell/chunk-load-error.ts` marks the tab (each writes its
 * mark right before it reloads the page) and, counting from the last reload the test asked for, at most one document
 * of the sign-in address is requested. Proved by mutation: with the chunk-load-error reload forced after the mount
 * the test fails on both the mark and the count. "Right after" is the moment
 * the server answered the sign-out, with the page still leaving. The sign-out ends the server session, so a round
 * cannot reuse the one before: the device used for days gets a new session of its user each round, and each first
 * visit is a context, a user and a store of its own.
 */
const ROUNDS = 20;
/** A first visit costs a whole runtime start each round (about 20 s); the 20 first visits are `e2e-pwa/sair-e-recarregar.e2e.ts`. */
const FIRST_VISIT_ROUNDS = 5;
const MOUNT_MS = 10_000;
const RUNTIME_MS = 30_000;
const RELOAD_MARKS = ["polaris:entry-reload", "polaris:chunk-reload-at"];
const REPEATED_RELOAD =
  "rounds where the reload was asked again on the sign-in page";
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
  await page.exposeFunction("polarisBootRetry", (mark: string, url: string) => {
    retries.push(`${mark} at ${url}`);
  });
  await page.addInitScript((marks) => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name: string, value: string) {
      if (marks.includes(name)) {
        (
          window as unknown as {
            polarisBootRetry: (mark: string, url: string) => void;
          }
        ).polarisBootRetry(name, window.location.href);
      }
      return set.call(this, name, value);
    };
  }, RELOAD_MARKS);
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

/** Returns how many times the reload was asked and the documents requested since the last ask. */
async function signOutAndReload(page: Page, seen: { documents: string[] }) {
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
    const documentsBefore = seen.documents.length;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: the second ask only follows a reload that did not happen
      await page.reload({ waitUntil: "commit" });
      return { attempts: attempt, documentsBefore };
    } catch (error) {
      if (!TRANSIENT.test(String(error)) || attempt === 3) {
        throw error;
      }
      await page.waitForURL(SIGN_IN_ADDRESS, { waitUntil: "commit" });
    }
  }
}

/** Returns how many times the reload was asked: more than one means it met the page already leaving (the page was at the sign-in address by then). */
async function expectSignInAfterReload(
  page: Page,
  retries: string[],
  round: number
) {
  const seen = watchPage(page);
  const { attempts, documentsBefore } = await signOutAndReload(page, seen);
  await expect(
    page.getByRole("heading", { level: 1, name: SIGN_IN_HEADING }),
    `round ${round}: the sign-in screen after the reload`
  ).toBeVisible({ timeout: MOUNT_MS });
  await page.waitForLoadState("load");
  expect(
    retries,
    `round ${round}: the page marked the tab to reload itself (documents ${seen.documents.join(" ")})`
  ).toEqual([]);
  const signInDocuments = seen.documents
    .slice(documentsBefore)
    .filter((path) => SIGN_IN_ADDRESS.test(path));
  expect(
    signInDocuments.length,
    `round ${round}: sign-in documents since the last reload (${seen.documents.join(" ")})`
  ).toBeLessThanOrEqual(1);
  expect(seen.log, `round ${round}: the browser log`).toEqual([]);
  return attempts;
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
  let repeated = 0;
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
    if ((await expectSignInAfterReload(page, retries, round)) > 1) {
      repeated += 1;
    }
  }
  testInfo.annotations.push({
    description: `${repeated} of ${ROUNDS}`,
    type: REPEATED_RELOAD,
  });
});

/** A first visit: a device with nothing yet (a context of its own), the runtime opened for the first time when "Sair" is used. */
test(`sair e recarregar logo em seguida, ${FIRST_VISIT_ROUNDS} vezes, na primeira visita, com o worker recém-instalado: a tela de entrar sempre aparece`, async ({
  browser,
  sql,
}, testInfo) => {
  test.setTimeout(FIRST_VISIT_ROUNDS * 40_000);
  let repeated = 0;
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
      if ((await expectSignInAfterReload(page, retries, round)) > 1) {
        repeated += 1;
      }
    } finally {
      await page.context().close();
    }
  }
  testInfo.annotations.push({
    description: `${repeated} of ${FIRST_VISIT_ROUNDS}`,
    type: REPEATED_RELOAD,
  });
});
