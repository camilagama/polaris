/// <reference lib="dom" />
import { execFileSync } from "node:child_process";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

/** Builds the app as "version N": the same code, a different marker in index.html. */
function buildVersion(variant: string) {
  execFileSync("bunx", ["vite", "build", "--config", "vite.pwa.config.ts"], {
    env: { ...process.env, PWA_E2E_VARIANT: variant },
    shell: process.platform === "win32",
    stdio: "ignore",
  });
}

const runningVersion = (page: Page) =>
  page.locator('meta[name="build-variant"]').getAttribute("content");

async function openControlled(page: Page) {
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

const checkForUpdate = (page: Page) =>
  page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    await registration?.update();
  });

test.afterAll(() => {
  buildVersion("1");
});

test("uma nova versão aparece como aviso, sem recarregar sozinha, e só troca quando a pessoa pede", async ({
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
