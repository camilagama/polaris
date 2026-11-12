/// <reference lib="dom" />
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { test } from "./support";
import { WORKER_MARK } from "./worker-mark";

/**
 * Reloading right after "Sair" must show the sign-in screen every time, never an empty `#root`, and the first load must
 * not need a second one (`public/boot-retry.js` is for a module that failed to download, not a way to hide a page that
 * did not mount; `app-shell/chunk-load-error.ts` reloads for a screen that failed to download): neither marks the tab
 * and, counting from the last reload the test asked for, at most one document of the sign-in address is requested.
 * Proved by mutation: with the chunk-load-error reload forced after the mount the test fails on both the mark and the
 * count. "Right after" is the moment the server answered the sign-out: the page is still leaving, and the
 * reload is the person's second tap. Two devices: one that has the service worker for days (the same context, the
 * worker in control across the rounds) and one that just installed it (a new context each round, a first visit).
 */
const ROUNDS = 70;
const MOUNT_MS = 20_000;
const SIGN_IN_HEADING = "Entrar no Polaris";
const FIRST_ACCESS_HEADING = "Abra a sua loja";
const RELOAD_MARKS = ["polaris:entry-reload", "polaris:chunk-reload-at"];
/** The browser logs the 401 the signed-out server answers: expected, and not an error of the page. */
const REFUSED_SESSION = /status of 401/;
const SIGN_OUT = /\/api\/auth\/sign-out$/;
const REPEATED_RELOAD =
  "rounds where the reload was asked again on the sign-in page";
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

/** The init script tells the test each time `boot-retry.js` or `chunk-load-error.ts` marks the tab to reload it. */
const T0 = Date.now();
export const timeline: string[] = [];
const stamp = (m: string) => timeline.push(`${String(Date.now() - T0).padStart(7)} ${m}`);
async function watchBootRetry(page: Page) {
  const retries: string[] = [];
  page.on("framenavigated", (f) => { if (f === page.mainFrame()) stamp(`framenavigated ${f.url()}`); });
  page.on("request", (r) => { if (r.resourceType() === "document") stamp(`request doc ${r.url()}`); });
  page.on("response", (r) => { if (r.url().includes("sign-out")) stamp("sign-out answered"); });
  await page.exposeFunction("polarisStamp", (m: string) => stamp(m));
  await page.addInitScript(() => {
    const p = (m: string) => { const k = "zzlog"; try { localStorage.setItem(k, `${localStorage.getItem(k) ?? ""}${Date.now()} ${m} @${location.pathname}\n`); } catch {} (window as any).polarisStamp?.(`${m} @${location.pathname}`); };
    window.addEventListener("error", (e) => { const t = e.target as any; p(`error-event ${t?.tagName ?? "window"} ${t?.src ?? ""} rs=${document.readyState} online=${navigator.onLine} vis=${document.visibilityState}`); }, true);
    window.addEventListener("pagehide", () => p("pagehide"));
    window.addEventListener("beforeunload", () => p("beforeunload"));
    window.addEventListener("load", () => p("load"));
    const rl = window.location.reload.bind(window.location);
    document.addEventListener("DOMContentLoaded", () => p("DOMContentLoaded"));
  });
  await page.exposeFunction("polarisBootRetry", (mark: string, url: string) => {
    retries.push(`${mark} at ${url}`);
  });
  await page.addInitScript((marks) => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name: string, value: string) {
      if (marks.includes(name)) {
        const k = "zzlog"; set.call(localStorage, k, `${localStorage.getItem(k) ?? ""}${Date.now()} MARK ${name} @${location.pathname}\n`);
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
const SIGN_IN_ADDRESS = /\/entrar/;
const TRANSIENT = /ERR_ABORTED|detached|Not attached to an active page/;

/**
 * A reload that met the page's own move to the start did not happen: it is asked again once the page reached the
 * sign-in address. Returns how many times it was asked and the documents requested before the last ask.
 */
async function reloadNow(page: Page, seen: { documents: string[] }) {
  for (let attempt = 1; ; attempt += 1) {
    const documentsBefore = seen.documents.length;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: the second ask only follows a reload that did not happen
      stamp(`reload attempt ${attempt}`);
      await page.reload({ waitUntil: "commit" });
      stamp(`reload attempt ${attempt} committed`);
      return { attempts: attempt, documentsBefore };
    } catch (error) {
      stamp(`reload attempt ${attempt} threw ${String(error).split("\n")[0]}`);
      if (!TRANSIENT.test(String(error)) || attempt === 3) {
        throw error;
      }
      await page.waitForURL(SIGN_IN_ADDRESS, { waitUntil: "commit" });
      await page.waitForLoadState("load");
      stamp("waitForURL+load done");
    }
  }
}

/** Returns how many times the reload was asked: more than one means it met the page already leaving. */
async function reloadAndExpectSignIn(
  page: Page,
  retries: string[],
  round: number
) {
  const seen = watch(page);
  stamp(`round ${round} reload asked`);
  const { attempts, documentsBefore } = await reloadNow(page, seen);
  await expect(
    page.getByRole("heading", { level: 1, name: SIGN_IN_HEADING }),
    `round ${round}: the sign-in screen after the reload`
  ).toBeVisible({ timeout: MOUNT_MS });
  await expect(page.locator("#root")).not.toBeEmpty();
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
  expect(seen.console, `round ${round}: the browser log`).toEqual([]);
  return attempts;
}

async function freshContext(browser: Browser, baseURL: string) {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: Number(process.env.REPRO_CPU ?? 1) });
  const state = await serveSession(context);
  return { context, page, state };
}

test.describe("recarregar logo depois de sair", () => {
  test(`com o worker já instalado: ${ROUNDS} saídas seguidas de recarga mostram a entrada`, async ({
    baseURL,
    browser,
    buildVersion,
  }, testInfo) => {
    test.setTimeout(900_000);
    buildVersion("1");
    let repeated = 0;
    const { context, page, state } = await freshContext(
      browser,
      baseURL as string
    );
    try {
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
        if ((await reloadAndExpectSignIn(page, retries, round)) > 1) {
          repeated += 1;
        }
        expect(
          await page.evaluate(
            () => navigator.serviceWorker.controller !== null
          ),
          `round ${round}: the worker is in control`
        ).toBe(true);
      }
    } catch (error) {
      const ls = await page.evaluate(() => localStorage.getItem("zzlog")).catch(() => "?");
      throw new Error(`${String(error)}\nTIMELINE\n${timeline.slice(-60).join("\n")}\nPAGELOG\n${ls}`);
    } finally {
      await context.close();
    }
    testInfo.annotations.push({
      description: `${repeated} of ${ROUNDS}`,
      type: REPEATED_RELOAD,
    });
  });

  test(`com o worker recém-instalado: ${ROUNDS} primeiras visitas, sair e recarregar mostram a entrada`, async ({
    baseURL,
    browser,
    buildVersion,
  }, testInfo) => {
    test.setTimeout(900_000);
    buildVersion("1");
    let repeated = 0;
    for (let round = 1; round <= ROUNDS; round += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: a new device each round, one at a time
      const { context, page } = await freshContext(browser, baseURL as string);
      try {
        const retries = await watchBootRetry(page);
        await signInAndOut(page);
        if ((await reloadAndExpectSignIn(page, retries, round)) > 1) {
          repeated += 1;
        }
      } finally {
        await context.close();
      }
    }
    testInfo.annotations.push({
      description: `${repeated} of ${ROUNDS}`,
      type: REPEATED_RELOAD,
    });
  });
});
