/// <reference lib="dom" />
import { expect, type Page, test } from "@playwright/test";

/**
 * Reloads with the service worker in control, each one right after the page's `load` (0 to 300 ms later, the window
 * where Chrome cancelled about one script in a hundred while the worker answered with the `Response` of the cache):
 * no script fails, so the boot-retry never reloads by itself and `theme-init.js` always runs. A sentinel, not the
 * proof of the fix: 300 reloads only say the rate is under about 1 %; the proof is `scripts/sw-recarga-bancada.mjs`
 * (3×600). A reload that fails here once is a real failure, so the file runs with no retry.
 */
const TABS = 3;
const RELOADS = 100;
const MAX_DELAY_MS = 300;
const DARK_CLASS = /\bdark\b/;

test.describe.configure({ mode: "parallel", retries: 0, timeout: 180_000 });

/** Park-Miller: the same delays at every run, so a failure is the same sequence again. */
function delays(seed: number) {
  let state = seed;
  return () => {
    state = (state * 16_807) % 2_147_483_647;
    return Math.floor(((state - 1) / 2_147_483_646) * MAX_DELAY_MS);
  };
}

interface Seen {
  failedScripts: string[];
  marks: string[];
  scriptErrors: string[];
}

/** What would show the defect: the boot-retry's mark, an `error` on a <script>, a script request that failed. */
async function watch(page: Page) {
  const seen: Seen = { failedScripts: [], marks: [], scriptErrors: [] };
  const leaving: { now: boolean } = { now: false };
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      leaving.now = false;
    }
  });
  const ownRequests = new WeakSet<object>();
  page.on("request", (request) => {
    if (!leaving.now) {
      ownRequests.add(request);
    }
  });
  page.on("requestfailed", (request) => {
    // the requests of the document a reload leaves are cancelled by the reload itself
    if (
      request.resourceType() === "script" &&
      ownRequests.has(request) &&
      !leaving.now
    ) {
      seen.failedScripts.push(
        `${request.url()} ${request.failure()?.errorText}`
      );
    }
  });
  page.on("console", (message) => {
    const text = message.text();
    if (text.startsWith("RECARGA mark ")) {
      seen.marks.push(text);
    } else if (text.startsWith("RECARGA script-error ")) {
      seen.scriptErrors.push(text);
    }
  });
  await page.addInitScript(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(name, value) {
      if (
        name === "polaris:entry-reload" ||
        name === "polaris:chunk-reload-at"
      ) {
        console.debug(`RECARGA mark ${name} ${document.readyState}`);
      }
      return set.call(this, name, value);
    };
    window.addEventListener(
      "error",
      (event) => {
        if (event.target instanceof HTMLScriptElement) {
          console.debug(
            `RECARGA script-error ${event.target.src} ${document.readyState}`
          );
        }
      },
      true
    );
  });
  return {
    reload: async () => {
      leaving.now = true;
      await page.reload({ waitUntil: "load" });
    },
    seen,
  };
}

/** Lets the page run for `ms` after its `load`, measured on its own clock. */
async function after(page: Page, ms: number) {
  const until = await page.evaluate((wait) => performance.now() + wait, ms);
  await page.waitForFunction((end) => performance.now() >= end, until, {
    polling: "raf",
  });
}

test.describe("com o worker no controle", () => {
  // more than 3 minutes: the browser gate runs it only when the worker, the boot-retry or this file change
  // (`reloads` of scripts/ci-changed.mjs); anywhere else, always
  test.skip(
    process.env.POLARIS_RECARGA_COM_WORKER === "0",
    "nada do worker, do boot-retry nem desta spec mudou"
  );

  for (let tab = 1; tab <= TABS; tab += 1) {
    test(`${RELOADS} recargas da /entrar logo depois do load, com o worker no controle (aba ${tab}): nenhum script falha`, async ({
      page,
    }) => {
      const watched = await watch(page);
      await page.goto("/entrar");
      await page.evaluate(async () => {
        await navigator.serviceWorker.ready;
      });
      await page.reload();
      await expect
        .poll(() =>
          page.evaluate(() => navigator.serviceWorker.controller !== null)
        )
        .toBe(true);
      const delay = delays(tab);
      for (let round = 0; round < RELOADS; round += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: one reload after the other in the same tab is the case
        await after(page, delay());
        await watched.reload();
      }
      await expect(page.locator("#root")).not.toBeEmpty();
      expect(watched.seen).toEqual({
        failedScripts: [],
        marks: [],
        scriptErrors: [],
      });
    });
  }
});

test.describe("sem o theme-init.js", () => {
  test.use({ colorScheme: "light", serviceWorkers: "block" });

  test("o tema escuro salvo volta quando o app monta", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("polaris-tema", "escuro");
    });
    await page.route("**/theme-init.js", (route) => route.abort("failed"));
    const blocked = page.waitForEvent(
      "requestfailed",
      (request) => new URL(request.url()).pathname === "/theme-init.js"
    );
    await page.goto("/entrar");
    await blocked;
    await expect(page.locator("#root")).not.toBeEmpty();
    await expect(page.locator("html")).toHaveClass(DARK_CLASS);
  });
});
