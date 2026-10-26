/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

/**
 * The level of motion of the page (src/lib/motion-level.ts), checked against the rule of the design written again
 * here as media queries, apart from the code it checks: a desktop that fell to `essential` by a fault would otherwise
 * take a test down the branch with no motion and pass. Returns the level, for the test to expect motion or not.
 */
export async function expectMotionLevel(page: Page): Promise<string> {
  const found = await page.evaluate(() => {
    const phone = matchMedia(
      "(pointer: coarse) and (max-width: 759.98px), (pointer: coarse) and (max-height: 500px)"
    ).matches;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let expected = phone ? "essential" : "full";
    if (reduced) {
      expected = "none";
    }
    return { expected, level: document.documentElement.dataset.motion ?? "" };
  });
  expect(
    found.level,
    "o nível de movimento que a regra dá a este contexto"
  ).toBe(found.expected);
  return found.level;
}
