/// <reference lib="dom" />
import type { BrowserContext, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { openControlled, test } from "./support";

/**
 * A page opened by its address whose entry module never runs: an empty, dark `#root`, the load finished and nothing in
 * the console (the failed downloads are network log entries, not console calls). It happens when the service worker
 * answering the page's files goes away while they load: its registration removed (site data cleared, here by
 * `Storage.clearDataForOrigin`, the same as DevTools or a long-lived browser profile clearing the origin), which kills
 * every fetch it still had in hand. The page has to mount by itself, as a reload by hand did.
 */
const MOUNT_MS = 3000;
/** Without the reload, 8 of 10 of these loads stayed empty: three in a row all mount by chance about 1 time in 100. */
const ROUNDS = 3;
const ENTRY_SCRIPT =
  /<script\b[^>]*\btype="module"[^>]*\bsrc="(\/assets\/[^"]+\.js)"/;

/** The path of the entry module the served page asks for, and only it (another chunk may also be `index-*.js`). */
async function entryPath(page: Page) {
  const html = await (await page.request.get("/")).text();
  const path = ENTRY_SCRIPT.exec(html)?.[1];
  expect(path, "the module <script> of the served page").toBeTruthy();
  return path as string;
}

const isEntryDocument = (url: string) => new URL(url).pathname === "/inventory";

async function clearOriginWorker(context: BrowserContext, origin: string) {
  const other = await context.newPage();
  await other.goto("/manifest.webmanifest");
  const cdp = await context.newCDPSession(other);
  return async () => {
    await cdp.send("Storage.clearDataForOrigin", {
      origin,
      storageTypes: "service_workers,cache_storage",
    });
  };
}

function countDocuments(page: Page) {
  const counted = { documents: 0 };
  page.on("request", (request) => {
    if (
      request.resourceType() === "document" &&
      isEntryDocument(request.url())
    ) {
      counted.documents += 1;
    }
  });
  return counted;
}

test("o worker apagado com a página carregando: a carga pelo endereço monta a raiz sozinha, em até 3 s", async ({
  baseURL,
  buildVersion,
  context,
  page,
}) => {
  test.setTimeout(90_000);
  buildVersion("1");
  const clear = await clearOriginWorker(context, baseURL as string);
  for (let round = 0; round < ROUNDS; round += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each round needs the worker the round before removed, back in control
    await openControlled(page);
    await page.goto("/dashboard");
    await expect(page.locator("#root")).not.toBeEmpty();

    await page.goto("/inventory", { waitUntil: "commit" });
    const committed = performance.now();
    await clear();

    await expect(page.locator("#root")).not.toBeEmpty({ timeout: MOUNT_MS });
    expect(performance.now() - committed).toBeLessThanOrEqual(MOUNT_MS);
  }
});

test.describe("sem o worker no caminho", () => {
  test.use({ serviceWorkers: "block" });

  test("o módulo de entrada que não baixou: a página recarrega uma vez e monta em até 3 s", async ({
    buildVersion,
    page,
  }) => {
    buildVersion("1");
    const entry = await entryPath(page);
    let asked = 0;
    await page.route(
      (url) => url.pathname === entry,
      (route) => {
        asked += 1;
        return asked === 1 ? route.abort("failed") : route.fallback();
      }
    );
    const counted = countDocuments(page);

    const started = performance.now();
    await page.goto("/inventory", { waitUntil: "commit" });
    await expect(page.locator("#root")).not.toBeEmpty({ timeout: MOUNT_MS });
    expect(performance.now() - started).toBeLessThanOrEqual(MOUNT_MS);
    expect(asked).toBe(2);
    expect(counted.documents).toBe(2);
  });

  test("o módulo de entrada que nunca baixa: recarrega só uma vez, sem laço", async ({
    buildVersion,
    page,
  }) => {
    buildVersion("1");
    const entry = await entryPath(page);
    let asked = 0;
    await page.route(
      (url) => url.pathname === entry,
      (route) => {
        asked += 1;
        return route.abort("failed");
      }
    );
    const counted = countDocuments(page);

    await page.goto("/inventory");
    await expect.poll(() => asked, { timeout: MOUNT_MS }).toBe(2);
    // the second load is the last: a third would have started by its `load`, from the same `error` of its module
    await page.waitForLoadState("load");
    await expect(page.locator("#root")).toBeEmpty();
    expect(counted.documents).toBe(2);
    expect(asked).toBe(2);
  });
});
