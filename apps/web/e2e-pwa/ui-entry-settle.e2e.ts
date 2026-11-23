/// <reference lib="dom" />
import { expect, test } from "@playwright/test";
import { EMAIL, emailField, entryStates, settle } from "./ui-entry-states";

/**
 * Control of `settle` (`ui-entry-states.ts`): the region of the password opens by a CSS transition of 220 ms and
 * stops clipping on a timer 40 ms later, so a `settle` that returns early would hand the measures a screen still
 * moving. After it, the region reads the same box twice, two frames apart, and no longer clips.
 */
test("depois do settle a região da senha não se move nem corta o conteúdo", async ({
  page,
}) => {
  await entryStates.signInEmailComplete(page);
  await emailField(page).fill("");
  await expect(
    page.locator('[data-slot="progressive"][data-open]')
  ).toHaveCount(0);
  await settle(page);
  await emailField(page).fill(EMAIL);
  await settle(page);
  const reads = await page.evaluate(async () => {
    const region = document.querySelector(
      '[data-slot="progressive"][data-open]'
    );
    if (!region?.firstElementChild) {
      throw new Error("the region of the password is not open");
    }
    const read = () => {
      const { height, width, x, y } = region.getBoundingClientRect();
      return {
        clips: getComputedStyle(region.firstElementChild as Element).overflow,
        height,
        width,
        x,
        y,
      };
    };
    const frame = () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const first = read();
    await frame();
    await frame();
    return { first, second: read() };
  });
  expect(reads.first.height).toBeGreaterThan(0);
  expect(reads.first.clips).toBe("visible");
  expect(reads.second).toEqual(reads.first);
});
