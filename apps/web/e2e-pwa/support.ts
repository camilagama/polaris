/// <reference lib="dom" />
import { execFileSync } from "node:child_process";
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

/** Builds the app as "version N": the same code, a different marker in index.html. */
export function buildVersion(variant: string) {
  execFileSync(
    "bunx",
    ["vite", "build", "--config", "vite.pwa.config.ts", "--mode", "pwa-e2e"],
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
