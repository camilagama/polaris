/// <reference lib="dom" />
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Page } from "@playwright/test";
import { test as base, expect } from "@playwright/test";
import { createStaticServer } from "../scripts/static-server.mjs";

/**
 * The update checks rebuild the app while it runs ("a new version"), so each worker builds into a directory of its
 * own and serves it from its own static server on a free port: they share nothing with the other checks, which
 * read `dist/pwa-e2e`, nor with each other, and the checks of the other files can run at the same time.
 */
export const test = base.extend<
  { buildVersion: (variant: string) => void },
  { app: { origin: string; outDir: string } }
>({
  app: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright fixtures need the object pattern as first argument
    async ({}, use, workerInfo) => {
      const outDir = `dist/pwa-e2e-update-${workerInfo.parallelIndex}`;
      rmSync(outDir, { force: true, recursive: true });
      const server = createStaticServer(outDir);
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      const { port } = server.address() as AddressInfo;
      await use({ origin: `http://127.0.0.1:${port}`, outDir });
      server.close();
      rmSync(outDir, { force: true, recursive: true });
    },
    { scope: "worker" },
  ],
  baseURL: async ({ app }, use) => {
    await use(app.origin);
  },
  buildVersion: async ({ app }, use) => {
    await use((variant) => buildVersion(app.outDir, variant));
  },
});

/** Builds the app as "version N": the same code, a different marker in index.html. */
function buildVersion(outDir: string, variant: string) {
  execFileSync(
    "bunx",
    [
      "vite",
      "build",
      "--config",
      "vite.pwa.config.ts",
      "--mode",
      "pwa-e2e",
      "--outDir",
      outDir,
    ],
    {
      env: { ...process.env, PWA_E2E_VARIANT: variant },
      shell: process.platform === "win32",
      stdio: "ignore",
    }
  );
}

export const runningVersion = (page: Page) =>
  page.locator('meta[name="build-variant"]').getAttribute("content");

/** Opens the app and waits until the service worker controls the page. */
export async function openControlled(page: Page) {
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

export const checkForUpdate = (page: Page) =>
  page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    await registration?.update();
  });
