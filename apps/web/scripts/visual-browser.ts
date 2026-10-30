/**
 * The browser of the visual regression (`e2e-pwa/ui-visual.e2e.ts`): Chromium inside one pinned Playwright image,
 * reached by the tests through `playwright run-server`. The baselines are drawn and compared by this browser only:
 * the image fixes the fonts, the FreeType and the Skia build, and the architecture is the CI's (amd64): Skia has
 * code paths per CPU, and a match between architectures is not promised. A run of the visual project fails before the
 * first screenshot unless its browser is a remote Chromium of the pinned version on Linux x86_64, the one the
 * launcher (`scripts/pwa-browser-tests.ts`) starts from the image.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** The Playwright version of the image: the same as `@playwright/test` (the client and the server speak one protocol). */
export const VISUAL_PLAYWRIGHT_VERSION = "1.63.0";

/** The image by tag and by the digest of its index: a tag can be pushed again, the digest cannot. */
export const VISUAL_IMAGE = `mcr.microsoft.com/playwright:v${VISUAL_PLAYWRIGHT_VERSION}-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27`;

/** The platform of the image the baselines come from: the one of the CI runner. */
export const VISUAL_PLATFORM = "linux/amd64";

/** The Chromium of that Playwright (`playwright-core/browsers.json`), which the spec reads back from the browser. */
export const VISUAL_BROWSER_VERSION = "153.0.8010.12";

/** The endpoint the launcher (`scripts/pwa-browser-tests.ts`) hands to the config of the tests. */
export const VISUAL_WS_ENV = "POLARIS_VISUAL_WS";

/** The project of `playwright.pwa.config.ts` that runs the visual spec, and only it. */
export const VISUAL_PROJECT = "chromium-visual";

/** `use.connectOptions` of the visual project: the server of the image, or nothing (and the spec fails). */
export function visualConnectOptions() {
  const wsEndpoint = process.env[VISUAL_WS_ENV];
  return wsEndpoint ? { wsEndpoint } : undefined;
}

/**
 * The playwright-core under `@playwright/test`, followed through the dependencies each package declares (the bun
 * install keeps every package in its own folder): its server speaks the protocol of the client the tests use.
 */
export function playwrightCoreDir() {
  let manifest = createRequire(import.meta.url).resolve(
    "@playwright/test/package.json"
  );
  for (const step of [0, 1]) {
    const dependency = Object.keys(
      JSON.parse(readFileSync(manifest, "utf8")).dependencies ?? {}
    ).find((name) => name.startsWith("playwright"));
    if (!dependency) {
      throw new Error(`no playwright dependency in ${manifest} (step ${step})`);
    }
    manifest = createRequire(manifest).resolve(`${dependency}/package.json`);
  }
  if (!manifest.endsWith(join("playwright-core", "package.json"))) {
    throw new Error(`expected playwright-core, found ${manifest}`);
  }
  return dirname(manifest);
}
