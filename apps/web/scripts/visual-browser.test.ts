import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  VISUAL_BROWSER_VERSION,
  VISUAL_IMAGE,
  VISUAL_PLAYWRIGHT_VERSION,
} from "./visual-browser";

const require = createRequire(import.meta.url);
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

const testManifest = require.resolve("@playwright/test/package.json");
const coreManifest = createRequire(
  require.resolve("playwright/package.json", { paths: [dirname(testManifest)] })
).resolve("playwright-core/package.json");

describe("the browser of the visual regression", () => {
  // a bump of Playwright without the image would connect a client to a server of another version, and the other way
  // round would draw the baselines with another Chromium
  it("is the image of the Playwright the lockfile installs", () => {
    expect(readJson(testManifest).version).toBe(VISUAL_PLAYWRIGHT_VERSION);
    expect(VISUAL_IMAGE).toMatch(
      new RegExp(
        `^mcr\\.microsoft\\.com/playwright:v${VISUAL_PLAYWRIGHT_VERSION.replaceAll(".", "\\.")}-noble@sha256:[0-9a-f]{64}$`
      )
    );
  });

  it("names the Chromium of that Playwright", () => {
    const browsers = readJson(join(dirname(coreManifest), "browsers.json"))
      .browsers as { browserVersion?: string; name: string }[];
    expect(
      browsers.find((browser) => browser.name === "chromium")?.browserVersion
    ).toBe(VISUAL_BROWSER_VERSION);
  });
});
