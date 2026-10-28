/**
 * The browser of the visual regression (`e2e-pwa/ui-visual.e2e.ts`): Chromium inside one pinned Playwright image,
 * reached by the tests through `playwright run-server`. The baselines are drawn and compared by this browser only:
 * the image fixes the fonts, the FreeType and the Skia build, and the architecture (the CI is amd64; Skia does not
 * draw the same pixels on arm64). A run of the visual project without the server of the image fails before the
 * first screenshot, so no baseline is written from another browser.
 */

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
