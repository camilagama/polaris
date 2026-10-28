/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  cutHomeNetwork,
  dropChartsChunkFromCaches,
  readHomeInLab,
  startHomeLab,
} from "./ui-home-states";

/**
 * The chart of the Início without a connection, with the service worker of the real build (desenho do Início v2, § 7.4,
 * "Chunk do gráfico"; AC-21): the charts chunk is in the precache, so a device that installed the app draws the
 * chart of the copy offline; with the chunk gone from Cache Storage, the page opened offline keeps the figures and
 * says the chart opens when the internet comes back. The Início runs in the lab of the screens, whose runtime is
 * ready with a usable lease, as the copy asks. The case of an old document asking for a chunk of a build already
 * cleaned is in `update.e2e.ts`.
 */

const CHARTS_CHUNK = /\/assets\/charts-[\w-]+\.js$/;

/** Installs the app's service worker and waits until it controls the lab's page: the precache, with the charts chunk, is in place. */
async function controlled(page: Page, user: string) {
  // the labs do not register the worker; the app does, for the whole origin, the lab's page included
  await page.goto("/");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await startHomeLab(page, user);
  await expect
    .poll(() =>
      page.evaluate(() => navigator.serviceWorker.controller !== null)
    )
    .toBe(true);
}

test("o pedaço do gráfico está no precache: aberto sem rede, o gráfico da cópia é desenhado", async ({
  page,
}) => {
  const user = await readHomeInLab(page);
  await controlled(page, user);
  await cutHomeNetwork(page);
  await startHomeLab(page, user);
  const chart = page.getByRole("region", { name: "Vendas por dia" });
  await expect(page.getByText("Último resultado confirmado")).toBeVisible({
    timeout: 20_000,
  });
  await expect(chart.getByRole("img")).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByText("O gráfico abre quando a internet voltar.")
  ).toHaveCount(0);
  // the map of the copy, from its own chunk in the precache
  const map = page.getByRole("region", { name: "Ritmo de vendas" });
  await expect(map.locator("[data-heatmap] svg")).toBeVisible({
    timeout: 20_000,
  });
  await expect(map.locator("[data-rhythm-reading]")).toHaveText(
    "Sexta, 23/10 · R$ 520,00 · 2 vendas · hoje"
  );
  await expect(map.locator("[data-rhythm-best]")).toHaveText(
    "Melhor dia: 18/10, R$ 1.840,00"
  );
});

test("sem o pedaço no Cache Storage e sem rede: os números ficam e o gráfico abre quando a internet voltar", async ({
  page,
}) => {
  const user = await readHomeInLab(page);
  await controlled(page, user);
  // the chunk leaves the caches of the worker, and nothing on the way can bring it
  await page.context().route(CHARTS_CHUNK, (route) => route.abort());
  await dropChartsChunkFromCaches(page);
  await cutHomeNetwork(page);
  await startHomeLab(page, user);
  const chart = page.getByRole("region", { name: "Vendas por dia" });
  await expect(chart).toContainText(
    "O gráfico abre quando a internet voltar. Os números estão acima.",
    { timeout: 20_000 }
  );
  await expect(chart.getByRole("img")).toHaveCount(0);
  await expect(
    chart.getByRole("button", { name: "Tentar novamente" })
  ).toHaveCount(0);
  // the figures stay: the total, the best day and "Ver os números"
  await expect(chart).toContainText("Melhor dia");
  await expect(
    chart.getByRole("button", { name: "Ver os números" })
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Hoje" })).toContainText("R$");
});
