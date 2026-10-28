/// <reference lib="dom" />
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Page } from "@playwright/test";
import { test as base, expect } from "@playwright/test";
import { createStaticServer } from "../scripts/static-server.mjs";

/**
 * The update checks rebuild the app while it runs ("a new version"), so each worker builds into a directory of its
 * own and serves it from its own static server on a free port: they share nothing with the other checks, which
 * read `dist/pwa-e2e`, nor with each other, and the checks of the other files can run at the same time.
 */
export interface BuildOptions {
  /** Built again even if this worker already made it (the same content built later). */
  fresh?: boolean;
  /** When the build was published (ms); by default 3 h before the run: past the 2 h of settling. */
  publishedAt?: number;
}

const HOUR = 60 * 60 * 1000;
/** One time for the whole run: the same variant built twice is the same worker, as the same commit is. */
const SETTLED = Date.now() - 3 * HOUR;

export const test = base.extend<
  { buildVersion: (variant: string, options?: BuildOptions) => void },
  { app: { origin: string; outDir: string } }
>({
  app: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright fixtures need the object pattern as first argument
    async ({}, use, workerInfo) => {
      const outDir = `dist/pwa-e2e-update-${workerInfo.parallelIndex}`;
      rmSync(outDir, { force: true, recursive: true });
      rmSync(`${outDir}-builds`, { force: true, recursive: true });
      const server = createStaticServer(outDir);
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      const { port } = server.address() as AddressInfo;
      await use({ origin: `http://127.0.0.1:${port}`, outDir });
      server.close();
      rmSync(outDir, { force: true, recursive: true });
      rmSync(`${outDir}-builds`, { force: true, recursive: true });
    },
    { scope: "worker" },
  ],
  baseURL: async ({ app }, use) => {
    await use(app.origin);
  },
  buildVersion: async ({ app }, use) => {
    await use((variant, options) =>
      buildVersion(
        app.outDir,
        variant,
        options?.publishedAt ?? SETTLED,
        options?.fresh === true
      )
    );
  },
});

/**
 * Builds the app as "version N": the same code, a different marker in index.html and in every chunk (new file names,
 * as a deploy has), published at `publishedAt` (`POLARIS_BUILD_TIME`, read by the worker's build). What is served is
 * replaced as a deploy replaces it: the files of the build before are gone. A build already made by this worker is
 * copied again instead of built again (the same input gives the same files).
 */
function buildVersion(
  outDir: string,
  variant: string,
  publishedAt: number,
  fresh: boolean
) {
  const made = `${outDir}-builds/${variant}-${publishedAt}`;
  if (fresh || !existsSync(made)) {
    build(made, variant, publishedAt);
  }
  rmSync(outDir, { force: true, recursive: true });
  cpSync(made, outDir, { recursive: true });
}

function build(outDir: string, variant: string, publishedAt: number) {
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
      env: {
        ...process.env,
        POLARIS_BUILD_TIME: String(publishedAt),
        PWA_E2E_VARIANT: variant,
      },
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

/** Waits until the new build is installed and waiting (the page found it). */
export async function waitForWaiting(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const registration = await navigator.serviceWorker.getRegistration();
          return registration?.waiting?.state ?? null;
        }),
      { timeout: 30_000 }
    )
    .toBe("installed");
}

/**
 * The tab goes to the background, or comes back. A headless browser never hides a page by itself, so the page is
 * told: `document.visibilityState` and the `visibilitychange` event, which is what the app listens to.
 */
export async function setVisibility(page: Page, state: "hidden" | "visible") {
  await page.evaluate((next) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => next,
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => next === "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

/** A mark in the page's memory: gone after a reload, so its presence says the page was not reloaded. */
export async function markPage(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { stillHere?: boolean }).stillHere = true;
  });
}

export const stillHere = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { stillHere?: boolean }).stillHere === true
  );
