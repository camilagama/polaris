import type { Page } from "@playwright/test";

/**
 * Hides the lab's own controls and waits for the fonts, for the layout to settle after the scroll and the hiding
 * (two frames) and for the finite animations of the clock to end. Not waited for: an animation that repeats forever (the
 * skeleton, the spinner) and one driven by the scroll (it ends only at the end of the scroll), neither of which finishes
 * by itself; nor script-driven movement or image decoding, which `getAnimations` does not list.
 */
export async function showScreenAlone(page: Page) {
  await page.evaluate(() => {
    for (const element of document.querySelectorAll("[data-lab-chrome]")) {
      (element as HTMLElement).hidden = true;
    }
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          !(animation.timeline instanceof DocumentTimeline) ||
          animation.effect?.getComputedTiming().iterations ===
            Number.POSITIVE_INFINITY ||
          (animation.playState !== "running" && !animation.pending)
      )
  );
}
