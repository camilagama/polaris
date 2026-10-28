/// <reference lib="dom" />
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Page, Route } from "@playwright/test";
import { expect } from "@playwright/test";
import {
  checkForUpdate,
  markPage,
  openControlled,
  runningVersion,
  setVisibility,
  stillHere,
  test,
  waitForWaiting,
} from "./support";
import { dropChartsChunkFromCaches, serveHome } from "./ui-home-states";
import { WORKER_MARK } from "./worker-mark";

/**
 * The swap of the build by itself (ADR 0041, emenda de 28/10/2026), with two real builds of the app served by the
 * same server: the new build goes in when the tab is hidden and the page holds nothing, never over a dialog, a sale
 * with an item or work in the queue, never at another tab's moment, and the tab held on the old build still opens a
 * lazy screen of its own build. The moments that need a clock (the return after 5 min, the idle tab, the 2 h of
 * settling) are in `update-moments.e2e.ts`.
 */
const CHARTS_FILE = /^charts-[\w-]+\.js$/;
const SHIRT_OPTION = /Camiseta do teste/;
const SETTINGS_ADDRESS = /\/configuracoes$/;
const VERSION_LINE = /Versão \d{4}\.\d{2}\.\d{2} · atualizado em \d{2}\/\d{2}/;
const HOLD_MS = 2500;

const rpc = (body: unknown) => ({
  body: JSON.stringify({ json: body, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
});

const SHIRT = {
  isDefaultVariant: false,
  listPrice: "50.00",
  movingAverageCost: null,
  productId: "0199c2d0-0000-7000-8000-0000000000f1",
  productName: "Camiseta do teste",
  productStatus: "active",
  quantity: 5,
  sku: "SKU-1",
  updatedAt: "2026-10-14T12:00:00.000Z",
  values: [{ optionName: "cor", optionValueName: "Azul" }],
  variantId: "0199c2d0-0000-7000-8000-0000000000b1",
  version: 1,
};

/** A signed-in store with the Início, the sale and the payment profiles answered by the test (synthetic data). */
async function serveApp(page: Page) {
  await serveHome(page, { signedIn: true });
  await page.route("**/rpc/inventory/listBalances", (route: Route) =>
    route.fulfill(rpc({ entries: [SHIRT], nextCursor: null }))
  );
  await page.route("**/rpc/paymentProfile/list", (route: Route) =>
    route.fulfill(rpc({ profiles: [] }))
  );
}

/** Version 1 open and controlled, then version 2 published and waiting. */
async function waitingOverVersion1(
  page: Page,
  buildVersion: (variant: string) => void,
  path = "/"
) {
  buildVersion("1");
  await serveApp(page);
  await openControlled(page);
  if (path !== "/") {
    await page.goto(path);
  }
  await markPage(page);
  buildVersion("2");
  await checkForUpdate(page);
  await waitForWaiting(page);
}

/** The tab goes to the background and nothing happens: still version 1, never reloaded. */
async function expectHeld(page: Page) {
  await setVisibility(page, "hidden");
  await page.waitForTimeout(HOLD_MS);
  expect(await runningVersion(page)).toBe("1");
  expect(await stillHere(page)).toBe(true);
}

async function addShirtToSale(page: Page) {
  await page
    .getByRole("heading", { exact: true, name: "Nova venda" })
    .waitFor();
  const item = page.getByRole("group", { exact: true, name: "Item 1" });
  await item.getByLabel("Produto ou variante").fill("cam");
  await item
    .getByRole("list", { name: "Variantes encontradas" })
    .getByRole("button", { name: SHIRT_OPTION })
    .click();
}

test("a build nova não aparece nem troca com a aba à vista; com a aba oculta, entra sozinha e em silêncio", async ({
  buildVersion,
  page,
}) => {
  await waitingOverVersion1(page, buildVersion);
  await page.waitForTimeout(HOLD_MS);
  expect(await runningVersion(page)).toBe("1");
  expect(await stillHere(page)).toBe(true);
  // no notice of any kind: the swap is silent (the old one was a status "Atualização do aplicativo")
  await expect(page.getByText("nova versão", { exact: false })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Atualizar agora" })
  ).toHaveCount(0);

  await setVisibility(page, "hidden");
  await expect.poll(() => runningVersion(page), { timeout: 20_000 }).toBe("2");
  expect(await stillHere(page)).toBe(false);
  // both builds' shells are kept (the previous ones for pages still open)
  expect(await page.evaluate(() => caches.keys())).toHaveLength(2);
});

test("com um Dialog aberto a aba oculta não troca; fechado o Dialog, a aba oculta troca", async ({
  buildVersion,
  page,
}) => {
  await waitingOverVersion1(page, buildVersion, "/configuracoes");
  await page.getByRole("button", { name: "Novo perfil" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expectHeld(page);
  await expect(page.getByRole("dialog")).toBeVisible();

  await setVisibility(page, "visible");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await setVisibility(page, "hidden");
  await expect.poll(() => runningVersion(page), { timeout: 20_000 }).toBe("2");
  // the same screen, by the address
  await expect(page).toHaveURL(SETTINGS_ADDRESS);
});

test("uma venda com item segura a troca: a aba oculta não troca e a venda continua lá", async ({
  buildVersion,
  page,
}) => {
  await waitingOverVersion1(page, buildVersion, "/sales");
  await addShirtToSale(page);
  await expectHeld(page);
  await setVisibility(page, "visible");
  await expect(
    page
      .getByRole("group", { exact: true, name: "Item 1" })
      .getByText("Camiseta do teste")
  ).toBeVisible();
});

test("duas abas, uma com rascunho: só a outra troca, e a segurada abre uma tela preguiçosa da build dela sem erro", async ({
  buildVersion,
  context,
  page,
}) => {
  buildVersion("1");
  await serveApp(page);
  await openControlled(page);
  const other = await context.newPage();
  await serveApp(other);
  await openControlled(other);
  await other.goto("/configuracoes");
  // the draft: a new payment profile with a name typed (it stays after Esc, as every form dialog keeps its draft)
  await other.getByRole("button", { name: "Novo perfil" }).click();
  await other.getByRole("dialog").getByLabel("Nome").first().fill("Maquininha");
  await markPage(other);

  buildVersion("2");
  await checkForUpdate(page);
  await waitForWaiting(page);
  // the tab with the draft goes to the background first: it holds
  await expectHeld(other);
  // the other one swaps at its own moment; its swap reloads nobody else
  await setVisibility(page, "hidden");
  await expect.poll(() => runningVersion(page), { timeout: 20_000 }).toBe("2");
  await other.waitForTimeout(HOLD_MS);
  expect(await runningVersion(other)).toBe("1");
  expect(await stillHere(other)).toBe(true);
  // the worker of version 2 now serves the held tab too; the files of version 1 are gone from the server
  expect(
    await other.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return registration?.waiting === null && registration.active !== null;
    })
  ).toBe(true);

  // the held tab opens a tab it never opened, with no load of the page: a lazy chunk of version 1, from the cache kept
  const failed: string[] = [];
  other.on("response", (response) => {
    if (response.status() >= 400 && response.url().includes("/assets/")) {
      failed.push(response.url());
    }
  });
  await setVisibility(other, "visible");
  await other.keyboard.press("Escape");
  await expect(other.getByRole("dialog")).toHaveCount(0);
  await other.getByRole("tab", { name: "Catálogo público" }).click();
  await expect(
    other.getByRole("heading", { exact: true, name: "Catálogo público" })
  ).toBeVisible({ timeout: 15_000 });
  await expect(other.getByText("Não foi possível abrir")).toHaveCount(0);
  expect(failed).toEqual([]);
  expect(await runningVersion(other)).toBe("1");
  expect(await stillHere(other)).toBe(true);
});

declare global {
  interface Window {
    polarisQueue?: { pending: number; rejected: number };
    polarisUpdateStore?: {
      setWorkSource: (source: {
        read: () => Promise<{
          pending: number;
          rejected: number;
          sending: number;
        }>;
        sync: () => Promise<void>;
      }) => void;
    };
  }
}

/** The test plays the part of the outbox, through the store the browser-check build exposes. */
async function queueWith(
  page: Page,
  queued: { pending: number; rejected: number }
) {
  await page.evaluate((initial) => {
    const control = { ...initial };
    window.polarisQueue = control;
    window.polarisUpdateStore?.setWorkSource({
      read: () =>
        Promise.resolve({
          pending: control.pending,
          rejected: control.rejected,
          sending: 0,
        }),
      sync: () => Promise.resolve(),
    });
  }, queued);
}

test("com trabalho na fila de sincronização a aba oculta não troca; com a fila vazia, troca", async ({
  buildVersion,
  page,
}) => {
  await waitingOverVersion1(page, buildVersion);
  await queueWith(page, { pending: 2, rejected: 0 });
  await expectHeld(page);
  expect(await page.evaluate(() => window.polarisQueue?.pending)).toBe(2);

  await setVisibility(page, "visible");
  await page.evaluate(() => {
    if (window.polarisQueue) {
      window.polarisQueue.pending = 0;
    }
  });
  await setVisibility(page, "hidden");
  await expect.poll(() => runningVersion(page), { timeout: 20_000 }).toBe("2");
});

test("com registro recusado a troca espera, e Configurações diz por quê, com Ver pendências", async ({
  buildVersion,
  page,
}) => {
  await waitingOverVersion1(page, buildVersion, "/configuracoes");
  await queueWith(page, { pending: 0, rejected: 1 });
  const line = page.locator("#versao-do-app");
  await expect(line).toContainText(
    "Nova versão pronta. Entra depois que as pendências forem resolvidas.",
    { timeout: 20_000 }
  );
  await expect(
    line.getByRole("link", { name: "Ver pendências" })
  ).toHaveAttribute("href", "/attention");
  await expect(line.getByRole("button")).toHaveCount(0);
  await expectHeld(page);
});

test("Configurações diz a versão e, com uma build esperando, que ela entra quando o app fechar", async ({
  buildVersion,
  page,
}) => {
  await waitingOverVersion1(page, buildVersion, "/configuracoes");
  const line = page.locator("#versao-do-app");
  await expect(line).toContainText(VERSION_LINE);
  await expect(line).toContainText(
    "Nova versão pronta. Entra quando você fechar o app."
  );
  await expect(line.getByRole("button")).toHaveCount(0);
  await expect(line.getByRole("link")).toHaveCount(0);
});

test("desfazer: publicada a B e depois de novo a A, a troca volta sozinha para a A", async ({
  buildVersion,
  page,
}) => {
  await waitingOverVersion1(page, buildVersion);
  await setVisibility(page, "hidden");
  await expect.poll(() => runningVersion(page), { timeout: 20_000 }).toBe("2");

  // the way back is publishing the previous content again: the browser sees another sw.js and installs it
  buildVersion("1");
  await checkForUpdate(page);
  await waitForWaiting(page);
  await setVisibility(page, "hidden");
  await expect.poll(() => runningVersion(page), { timeout: 20_000 }).toBe("1");
});

test("a primeira instalação não é uma troca: a página não recarrega", async ({
  buildVersion,
  page,
}) => {
  buildVersion("1");
  await page.goto("/");
  await markPage(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await setVisibility(page, "hidden");
  await page.waitForTimeout(HOLD_MS);
  expect(await stillHere(page)).toBe(true);
});

test("o mesmo conteúdo publicado de novo (outra hora, mesmo id) não instala nada nem troca", async ({
  buildVersion,
  page,
}) => {
  buildVersion("1");
  await openControlled(page);
  await markPage(page);
  const before = await page.evaluate(() => caches.keys());
  // the same files again, a moment later: nothing in the worker depends on when the build was made
  await page.waitForTimeout(1100);
  buildVersion("1", { fresh: true });
  await checkForUpdate(page);
  await page.waitForTimeout(HOLD_MS);
  expect(
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return [registration?.waiting, registration?.installing];
    })
  ).toEqual([null, null]);
  expect(await page.evaluate(() => caches.keys())).toEqual(before);
  await setVisibility(page, "hidden");
  await page.waitForTimeout(HOLD_MS);
  expect(await stillHere(page)).toBe(true);
});

test("um documento antigo pede o pedaço do gráfico de um build já limpo: os números ficam, 'O gráfico não abriu.' e Tentar novamente", async ({
  app,
  buildVersion,
  page,
}) => {
  buildVersion("1");
  await serveHome(page, { signedIn: true });
  // the figures wait until the build is cleaned: only then does the Início ask for the chunk
  let release: () => void = () => undefined;
  const cleaned = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/rpc/report/periodSummary", async (route) => {
    await cleaned;
    await route.fallback();
  });
  await openControlled(page);
  // a newer build went out and the files of this one are gone: from the server and from the worker's caches
  const assets = join(app.outDir, "assets");
  for (const file of readdirSync(assets).filter((name) =>
    CHARTS_FILE.test(name)
  )) {
    rmSync(join(assets, file));
  }
  await dropChartsChunkFromCaches(page);
  release();
  const chart = page.getByRole("region", { name: "Vendas por dia" });
  await expect(chart).toContainText("O gráfico não abriu.", {
    timeout: 20_000,
  });
  await expect(
    chart.getByRole("button", { name: "Tentar novamente" })
  ).toBeVisible();
  await expect(chart).toContainText("Melhor dia");
  await expect(page.getByRole("region", { name: "Hoje" })).toContainText("R$");
});
