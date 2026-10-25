/// <reference lib="dom" />
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";
import {
  checkForUpdate,
  openControlled,
  runningVersion,
  test,
} from "./support";
import { dropChartsChunkFromCaches, serveHome } from "./ui-home-states";

const CHARTS_FILE = /^charts-[\w-]+\.js$/;

test("uma nova versão aparece como aviso, sem recarregar sozinha, e só troca quando a pessoa pede", async ({
  buildVersion,
  page,
}) => {
  buildVersion("1");
  await openControlled(page);
  expect(
    await page
      .locator('meta[name="build-variant"]')
      .getAttribute("content", { timeout: 15_000 })
  ).toBe("1");
  await page.evaluate(() => {
    (window as unknown as { stillHere: boolean }).stillHere = true;
  });

  buildVersion("2");
  await checkForUpdate(page);

  const banner = page.getByRole("status", {
    name: "Atualização do aplicativo",
  });
  await expect(banner).toContainText("Há uma nova versão do Polaris", {
    timeout: 20_000,
  });
  // the app in use is untouched: still version 1, the page was not reloaded
  await page.waitForTimeout(1500);
  expect(await runningVersion(page)).toBe("1");
  expect(
    await page.evaluate(
      () => (window as unknown as { stillHere?: boolean }).stillHere
    )
  ).toBe(true);

  await page.getByRole("button", { name: "Atualizar agora" }).click();
  await expect.poll(() => runningVersion(page), { timeout: 20_000 }).toBe("2");
  await expect(banner).toHaveCount(0);

  // both builds' shells are kept (the previous one for pages still open)
  const names = await page.evaluate(() => caches.keys());
  expect(names).toHaveLength(2);
});

test("a primeira instalação não é anunciada como atualização", async ({
  buildVersion,
  page,
}) => {
  buildVersion("1");
  await page.goto("/");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.waitForTimeout(1000);
  await expect(
    page.getByRole("status", { name: "Atualização do aplicativo" })
  ).toHaveCount(0);
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

test("o mesmo conteúdo publicado de novo (outra hora, mesmo id) não gera aviso de nova versão", async ({
  buildVersion,
  page,
}) => {
  buildVersion("1");
  await openControlled(page);
  const before = await page.evaluate(() => caches.keys());
  // the same files again, a moment later: nothing in the worker depends on when the build was made
  await page.waitForTimeout(1100);
  buildVersion("1");
  await checkForUpdate(page);
  await page.waitForTimeout(2500);
  await expect(
    page.getByRole("status", { name: "Atualização do aplicativo" })
  ).toHaveCount(0);
  expect(
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return [registration?.waiting, registration?.installing];
    })
  ).toEqual([null, null]);
  expect(await page.evaluate(() => caches.keys())).toEqual(before);
});

test("com duas abas abertas, Atualizar agora numa só troca a versão dela; a outra não recarrega e mantém o rascunho", async ({
  buildVersion,
  context,
  page,
}) => {
  buildVersion("1");
  await openControlled(page);
  const other = await context.newPage();
  await openControlled(other);
  // a draft that lives only in the page's memory: a reload would lose it (ADR 0041, "Nunca automático")
  await other.evaluate(() => {
    (window as unknown as { draft?: string }).draft = "rascunho";
  });

  buildVersion("2");
  await checkForUpdate(page);
  const banner = page.getByRole("status", {
    name: "Atualização do aplicativo",
  });
  await expect(banner).toContainText("Há uma nova versão do Polaris", {
    timeout: 20_000,
  });
  await page.getByRole("button", { name: "Atualizar agora" }).click();

  await expect.poll(() => runningVersion(page), { timeout: 20_000 }).toBe("2");
  await expect(banner).toHaveCount(0);

  // the other tab was not asked: it keeps its page, its build's files and what was typed
  await other.waitForTimeout(6000);
  expect(await runningVersion(other)).toBe("1");
  expect(
    await other.evaluate(() => (window as unknown as { draft?: string }).draft)
  ).toBe("rascunho");
});
