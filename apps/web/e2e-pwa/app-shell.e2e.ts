/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

const shellCachePattern = /^polaris-shell-/;
const polarisTitle = /Polaris$/;

/** Opens the app and waits until the worker controls the page (after a reload). */
async function installAndControl(page: Page) {
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
}

const cachedPaths = (page: Page) =>
  page.evaluate(async () => {
    const caches_ = await Promise.all(
      (await caches.keys()).map((name) => caches.open(name))
    );
    const keys = await Promise.all(caches_.map((cache) => cache.keys()));
    return keys.flat().map((request) => new URL(request.url).pathname);
  });

test("o service worker instala, pré-guarda o shell e controla a página", async ({
  page,
}) => {
  await installAndControl(page);
  const names = await page.evaluate(() => caches.keys());
  expect(names).toHaveLength(1);
  expect(names[0]).toMatch(shellCachePattern);
  const paths = await cachedPaths(page);
  expect(paths).toContain("/");
  expect(paths).toContain("/manifest.webmanifest");
  expect(paths.some((path) => path.startsWith("/assets/"))).toBe(true);
});

test("sem rede o app abre a partir do shell em cache, inclusive numa rota interna", async ({
  context,
  page,
}) => {
  await installAndControl(page);
  await context.setOffline(true);

  await page.reload();
  await expect(page).toHaveTitle(polarisTitle);
  await expect(page.locator("#root")).not.toBeEmpty();

  await page.goto("/vendas/historico");
  await expect(page).toHaveTitle(polarisTitle);
  await expect(page.locator("#root")).not.toBeEmpty();
});

test("sem rede, o endereço de uma tela que virou aba abre a aba no próprio navegador (t417)", async ({
  context,
  page,
}) => {
  await installAndControl(page);
  await context.setOffline(true);
  for (const [old, address, title] of [
    ["/expenses", "/dashboard?aba=despesas", "Despesas · Polaris"],
    ["/categories", "/products?aba=categorias", "Categorias · Polaris"],
    ["/devices", "/configuracoes?aba=aparelhos", "Aparelhos · Polaris"],
  ] as const) {
    // biome-ignore lint/performance/noAwaitInLoops: one address at a time
    await page.goto(old);
    await expect
      .poll(() => {
        const url = new URL(page.url());
        return `${url.pathname}${url.search}`;
      })
      .toBe(address);
    await expect(page).toHaveTitle(title);
  }
});

test("a API do tenant e a autenticação nunca passam pelo cache", async ({
  context,
  page,
}) => {
  await installAndControl(page);
  // these go to the network (the static server answers with its fallback page)
  await page.evaluate(() => fetch("/rpc/sale/list").catch(() => null));
  await page.evaluate(() => fetch("/api/auth/get-session").catch(() => null));

  await context.setOffline(true);
  const offline = await page.evaluate(async () => {
    try {
      await fetch("/rpc/sale/list");
      return "answered";
    } catch {
      return "failed";
    }
  });
  expect(offline).toBe("failed");
  const paths = await cachedPaths(page);
  expect(paths.some((path) => path.startsWith("/rpc/"))).toBe(false);
  expect(paths.some((path) => path.startsWith("/api/"))).toBe(false);
});

test("o manifesto e os ícones existem e o manifesto está ligado à página", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    "href",
    "/manifest.webmanifest"
  );
  const manifest = await (await request.get("/manifest.webmanifest")).json();
  expect(manifest).toMatchObject({
    display: "standalone",
    lang: "pt-BR",
    name: "Polaris",
    start_url: "/",
  });
  for (const icon of manifest.icons as { src: string }[]) {
    // biome-ignore lint/performance/noAwaitInLoops: each icon is verified on its own
    const response = await request.get(icon.src);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("image/png");
  }
});

test("os laboratórios offline não registram o service worker", async ({
  page,
}) => {
  await page.goto("/offline-outbox-lab");
  const count = await page.evaluate(
    async () => (await navigator.serviceWorker.getRegistrations()).length
  );
  expect(count).toBe(0);
});
