/// <reference lib="dom" />
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import {
  attachTraces,
  createTrace,
  failedFiles,
  since,
  type Trace,
  tracedRoute,
  traceNetwork,
} from "./network-trace";
import { test as base } from "./support";
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
const ROUNDS = 20;
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

/** The trace of each page of the test, attached to the report when the test does not end as expected. */
const test = base.extend<{ traces: Map<string, Trace> }>({
  traces: async (
    // biome-ignore lint/correctness/noEmptyPattern: Playwright fixtures need the object pattern as first argument
    {},
    use,
    testInfo
  ) => {
    const traces = new Map<string, Trace>();
    await use(traces);
    if (
      testInfo.status !== testInfo.expectedStatus ||
      process.env.E2E_NETWORK_TRACE === "1"
    ) {
      await attachTraces(testInfo, traces);
    }
  },
});

const json = (status: number, body: unknown) => ({
  body: JSON.stringify(body),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
  status,
});

async function serveSession(context: BrowserContext, trace: Trace) {
  const state: { signedIn: boolean } = { signedIn: true };
  await tracedRoute(context, trace, "**/api/auth-methods", (route) =>
    route.fulfill(
      json(200, { emailPassword: true, google: true, turnstileSiteKey: null })
    )
  );
  await tracedRoute(context, trace, "**/api/auth/get-session", (route) =>
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
  await tracedRoute(context, trace, SIGN_OUT, (route) => {
    state.signedIn = false;
    return route.fulfill(json(200, { success: true }));
  });
  await tracedRoute(context, trace, "**/rpc/**", (route) => {
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

/**
 * The init script tells the test each time `boot-retry.js` or `chunk-load-error.ts` marks the tab to reload it, and
 * `trace` keeps the order of what the tab did (documents, commits, the module `<script>` errors, the page leaving), so a
 * failure on a slow runner says which document the mark came from instead of only that it came.
 */
async function watchBootRetry(page: Page, trace: Trace) {
  const retries: string[] = [];
  const { note } = trace;
  await traceNetwork(page.context(), page, trace);
  await page.exposeFunction("polarisBootRetry", (mark: string, url: string) => {
    retries.push(`${mark} at ${url}`);
    note(`mark ${mark} at ${url}`);
  });
  await page.exposeFunction("polarisPageEvent", (what: string, url: string) => {
    note(`${what} at ${url}`);
  });
  page.on("request", (request) => {
    if (request.resourceType() === "document") {
      note(`document ${new URL(request.url()).pathname}`);
    }
  });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      note(`committed ${new URL(frame.url()).pathname}`);
    }
  });
  page.on("requestfailed", (request) => {
    note(
      `request failed ${request.resourceType()} ${new URL(request.url()).pathname} (${request.failure()?.errorText})`
    );
  });
  page.on("response", (response) => {
    if (SIGN_OUT.test(response.url())) {
      note("sign-out answered");
    }
  });
  await page.addInitScript((marks) => {
    const tell = (what: string) =>
      (
        window as unknown as {
          polarisPageEvent: (what: string, url: string) => void;
        }
      ).polarisPageEvent(what, window.location.href);
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
    window.addEventListener(
      "error",
      ({ target }) => {
        if (target instanceof HTMLScriptElement) {
          tell(`script error ${target.src} (${document.readyState})`);
        }
      },
      true
    );
    window.addEventListener("pagehide", () => tell("pagehide"));
    window.addEventListener("load", () => tell("load"));
  }, RELOAD_MARKS);
  return { retries, trace };
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

/** Returns how many times the reload was asked: more than one means it met the page already leaving. */
async function reloadAndExpectSignIn(
  page: Page,
  { retries, trace }: { retries: string[]; trace: Trace },
  round: number
) {
  const seen = watch(page);
  const from = trace.lines.length;
  const { attempts, documentsBefore } = await reloadNow(page, seen);
  const happened = () =>
    `files that did not load: ${failedFiles(trace, from)}; ${since(trace, from, 60)}`;
  try {
    await expect(
      page.getByRole("heading", { level: 1, name: SIGN_IN_HEADING })
    ).toBeVisible({ timeout: MOUNT_MS });
  } catch (error) {
    throw new Error(
      `round ${round}: the sign-in screen after the reload (${happened()})`,
      { cause: error }
    );
  }
  await expect(page.locator("#root")).not.toBeEmpty();
  await page.waitForLoadState("load");
  expect(
    retries,
    `round ${round}: the page marked the tab to reload itself (documents ${seen.documents.join(" ")}; ${happened()})`
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

async function freshContext(
  browser: Browser,
  baseURL: string,
  traces: Map<string, Trace>,
  name: string
) {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  const trace = createTrace();
  traces.set(name, trace);
  const state = await serveSession(context, trace);
  return { context, page, state, trace };
}

test.describe("recarregar logo depois de sair", () => {
  test(`com o worker já instalado: ${ROUNDS} saídas seguidas de recarga mostram a entrada`, async ({
    baseURL,
    browser,
    buildVersion,
    traces,
  }, testInfo) => {
    test.setTimeout(420_000);
    buildVersion("1");
    let repeated = 0;
    const { context, page, state, trace } = await freshContext(
      browser,
      baseURL as string,
      traces,
      "worker-instalado"
    );
    try {
      const spy = await watchBootRetry(page, trace);
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
        if ((await reloadAndExpectSignIn(page, spy, round)) > 1) {
          repeated += 1;
        }
        expect(
          await page.evaluate(
            () => navigator.serviceWorker.controller !== null
          ),
          `round ${round}: the worker is in control`
        ).toBe(true);
      }
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
    traces,
  }, testInfo) => {
    test.setTimeout(420_000);
    buildVersion("1");
    let repeated = 0;
    for (let round = 1; round <= ROUNDS; round += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: a new device each round, one at a time
      const { context, page, trace } = await freshContext(
        browser,
        baseURL as string,
        traces,
        `primeira-visita-${round}`
      );
      try {
        const spy = await watchBootRetry(page, trace);
        await signInAndOut(page);
        if ((await reloadAndExpectSignIn(page, spy, round)) > 1) {
          repeated += 1;
        }
        traces.delete(`primeira-visita-${round}`);
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
