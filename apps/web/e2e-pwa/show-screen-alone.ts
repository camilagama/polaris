import type { Page } from "@playwright/test";

/**
 * Hides the lab's own controls and waits for the fonts, for the layout to settle after the scroll and the hiding
 * (two frames), for the finite animations of the clock to end and for every `[data-slot="filter-pill"]` to stop moving
 * (identity transform and the same box, pill and icon, in two consecutive frames): the pills move by script (layout
 * spring), which `getAnimations` does not list, and the tail of that spring scales the icon to 16.01 px. Not waited for:
 * an animation that repeats forever (the skeleton, the spinner) and one driven by the scroll (it ends only at the end of
 * the scroll), neither of which finishes by itself; nor script-driven movement of anything other than the filter pills,
 * nor image decoding.
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
  await page.waitForFunction(
    () => {
      const holder = window as { pillBoxes?: string | undefined };
      const boxes: string[] = [];
      for (const pill of document.querySelectorAll(
        '[data-slot="filter-pill"]'
      )) {
        const { transform } = getComputedStyle(pill);
        if (transform !== "none" && !new DOMMatrix(transform).isIdentity) {
          holder.pillBoxes = undefined;
          return false;
        }
        for (const element of [pill, pill.querySelector("svg.lucide")]) {
          const { height, left, top, width } =
            element?.getBoundingClientRect() ?? new DOMRect();
          boxes.push(`${left},${top},${width},${height}`);
        }
      }
      const key = boxes.join("|");
      const stable = holder.pillBoxes === key;
      holder.pillBoxes = stable ? undefined : key;
      return stable;
    },
    undefined,
    { polling: "raf" }
  );
}
