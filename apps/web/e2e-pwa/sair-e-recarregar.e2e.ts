/// <reference lib="dom" />
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { test } from "./support";
import { WORKER_MARK } from "./worker-mark";

/**
 * Reloading right after "Sair" must show the sign-in screen every time, never an empty `#root`, and the first load must
 * not need a second one (`public/boot-retry.js` is for a module that failed to download, not a way to hide a page that
 * did not mount). "Right after" is the moment the server answered the sign-out: the page is still leaving, and the
 * reload is the person's second tap. Two devices: one that has the service worker for days (the same context, the
 * worker in control across the rounds) and one that just installed it (a new context each round, a first visit).
 */
const ROUNDS = 20;
const MOUNT_MS = 20_000;
const SIGN_IN_HEADING = "Entrar no Polaris";
const FIRST_ACCESS_HEADING = "Abra a sua loja";
const ENTRY_RELOAD_MARK = "polaris:entry-reload";
/** The browser logs the 401 the signed-out server answers: expected, and not an error of the page. */
const REFUSED_SESSION = /status of 401/;
const SIGN_OUT = /\/api\/auth\/sign-out$/;
const RPC_PREFIX = /^.*\/rpc\//;

const json = (status: number, body: unknown) => ({
  body: JSON.stringify(body),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
  status,
});

async function serveSession(context: BrowserContext) {
  const state: { signedIn: boolean } = { signedIn: true };
  await context.route("**/api/auth-methods", (route) =>
    route.fulfill(
      json(200, { emailPassword: true, google: true, turnstileSiteKey: null })
    )
  );
  await context.route("**/api/auth/get-session", (route) =>
    route.fulfill(
      json(
        200,
        state.signedIn
          ? {
              session: { id: "s" },
              user: { email: "ana@lojadaana.com.br", id: "u" },
            }
          : null
      )
    )
  );
  await context.route(SIGN_OUT, (route) => {
    state.signedIn = false;
    return route.fulfill(json(200, { success: true }));
  });
  await context.route("**/rpc/**", (route) => {
    const procedure = new URL(route.request().url()).pathname.replace(
      RPC_PREFIX,
      ""
    );
    if (!state.signedIn) {
      return route.fulfill(
        json(401, {
          json: {
            code: "UNAUTHORIZED",
            defined: false,
            message: "UNAUTHORIZED",
            status: 401,
          },
          meta: [],
        })
      );
    }
    const body =
      procedure === "organization/listMine" ||
      procedure === "organization/listClosed"
        ? { organizations: [] }
        : null;
    return body
      ? route.fulfill(json(200, { json: body, meta: [] }))
      : route.abort("internetdisconnected");
  });
  return state;
}

/** The init script tells the test each time `boot-retry.js` marks the tab to reload it: the one reload it allows itself. */
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

function watch(page: Page) {
  const seen = { console: [] as string[], documents: [] as string[] };
  page.on("console", (message) => {
    if (message.type() === "error" && !REFUSED_SESSION.test(message.text())) {
      seen.console.push(message.text());
    }
  });
  page.on("pageerror", (error) => seen.console.push(String(error)));
  page.on("requestfailed", (request) => {
    if (request.resourceType() === "script") {
      seen.console.push(`script failed: ${request.url()}`);
    }
  });
  page.on("request", (request) => {
    if (request.resourceType() === "document") {
      seen.documents.push(new URL(request.url()).pathname);
    }
  });
  return seen;
}

async function signInAndOut(page: Page) {
  await page.goto("/");
  await page
    .getByRole("heading", { level: 1, name: FIRST_ACCESS_HEADING })
    .waitFor();
  const answered = page.waitForResponse(SIGN_OUT);
  await page.getByRole("button", { exact: true, name: "Sair" }).click();
  await answered;
}

/** The reload may meet the page's own move to the start: the browser reports an aborted navigation or a page not yet attached. */
const TRANSIENT = /ERR_ABORTED|detached|Not attached to an active page/;

async function reloadNow(page: Page) {
  try {
    await page.reload({ waitUntil: "commit" });
  } catch (error) {
    if (!TRANSIENT.test(String(error))) {
      throw error;
    }
    await page.waitForLoadState("domcontentloaded");
  }
}

async function reloadAndExpectSignIn(
  page: Page,
  retries: string[],
  round: number
) {
  const seen = watch(page);
  await reloadNow(page);
  await expect(
    page.getByRole("heading", { level: 1, name: SIGN_IN_HEADING }),
    `round ${round}: the sign-in screen after the reload`
  ).toBeVisible({ timeout: MOUNT_MS });
  await expect(page.locator("#root")).not.toBeEmpty();
  await page.waitForLoadState("load");
  expect(
    retries,
    `round ${round}: the entry module did not run and the page reloaded itself (documents ${seen.documents.join(" ")})`
  ).toEqual([]);
  // the sign-in screen is one document of its own, never two
  expect(
    seen.documents.filter((path) => path === "/entrar").length,
    `round ${round}: documents asked ${seen.documents.join(" ")}`
  ).toBeLessThanOrEqual(1);
  expect(seen.console, `round ${round}: the browser log`).toEqual([]);
}

async function freshContext(browser: Browser, baseURL: string) {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  const state = await serveSession(context);
  return { context, page, state };
}

test.describe("recarregar logo depois de sair", () => {
  test(`com o worker já instalado: ${ROUNDS} saídas seguidas de recarga mostram a entrada`, async ({
    baseURL,
    browser,
    buildVersion,
  }) => {
    test.setTimeout(420_000);
    buildVersion("1");
    const { context, page, state } = await freshContext(
      browser,
      baseURL as string
    );
    const retries = await watchBootRetry(page);
    await page.goto("/");
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
      state.signedIn = true;
      // biome-ignore lint/performance/noAwaitInLoops: each round starts from the page the round before left
      await signInAndOut(page);
      await reloadAndExpectSignIn(page, retries, round);
      expect(
        await page.evaluate(() => navigator.serviceWorker.controller !== null)
      ).toBe(true);
    }
    await context.close();
  });

  test(`com o worker recém-instalado: ${ROUNDS} primeiras visitas, sair e recarregar mostram a entrada`, async ({
    baseURL,
    browser,
    buildVersion,
  }) => {
    test.setTimeout(420_000);
    buildVersion("1");
    for (let round = 1; round <= ROUNDS; round += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: a new device each round, one at a time
      const { context, page } = await freshContext(browser, baseURL as string);
      const retries = await watchBootRetry(page);
      await signInAndOut(page);
      await reloadAndExpectSignIn(page, retries, round);
      await context.close();
    }
  });
});
