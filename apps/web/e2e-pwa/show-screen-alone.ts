import type { Page } from "@playwright/test";

const FINITE_ANIMATION_BUDGET_MS = 10_000;
const STABLE_FRAMES = 3;
const SCRIPT_DRIVEN_SELECTOR = '[data-slot="filter-pill"]';

/**
 * Hides the lab's own controls and waits for the fonts, for the layout to settle after the scroll and the hiding
 * (two frames) and for the finite animations of the clock to end. Not waited for: an animation that repeats forever (the
 * skeleton, the spinner) and one driven by the scroll (it ends only at the end of the scroll), neither of which finishes
 * by itself; nor image decoding, which `getAnimations` does not list.
 *
 * The filter pills enter with a spring of `motion` that runs in script, so `getAnimations` does not list it and the
 * pill (an icon inside it with it) is measured while still scaled: their boxes must also stay unchanged for
 * `STABLE_FRAMES` frames in a row. The selector is not wider because other script-driven movement (the loading
 * shimmer of the charts) never stops.
 *
 * A finite animation still running, or a pill still moving, after `budgetMs` fails with its name and total duration:
 * a very long one would otherwise only show as the 45 s test timeout, with no hint of what holds the screen.
 */
export async function showScreenAlone(
  page: Page,
  { budgetMs = FINITE_ANIMATION_BUDGET_MS }: { budgetMs?: number } = {}
) {
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
  const stuck = await page.evaluate(
    ({ budget, frames, selector }) =>
      new Promise<string[]>((resolve) => {
        const startedAt = performance.now();
        let lastBoxes = "";
        let stableFor = 0;
        const boxes = () =>
          [...document.querySelectorAll(selector)]
            .map((element) => {
              const box = element.getBoundingClientRect();
              return [box.x, box.y, box.width, box.height]
                .map((value) => value.toFixed(2))
                .join(",");
            })
            .join(";");
        const unfinished = () =>
          document
            .getAnimations()
            .filter(
              (animation) =>
                animation.timeline instanceof DocumentTimeline &&
                animation.effect?.getComputedTiming().iterations !==
                  Number.POSITIVE_INFINITY &&
                (animation.playState === "running" || animation.pending)
            );
        const check = () => {
          const left = unfinished();
          const current = boxes();
          stableFor = current === lastBoxes ? stableFor + 1 : 0;
          lastBoxes = current;
          if (left.length === 0 && stableFor >= frames) {
            resolve([]);
            return;
          }
          if (performance.now() - startedAt > budget) {
            const moving =
              stableFor < frames ? [`${selector} (caixa ainda mudando)`] : [];
            resolve([
              ...moving,
              ...left.map((animation) => {
                let name = animation.id || "(sem nome)";
                if (animation instanceof CSSAnimation) {
                  name = animation.animationName;
                } else if (animation instanceof CSSTransition) {
                  name = animation.transitionProperty;
                }
                const total = animation.effect?.getComputedTiming().endTime;
                return `"${name}" (${String(total)} ms no total)`;
              }),
            ]);
            return;
          }
          requestAnimationFrame(check);
        };
        check();
      }),
    {
      budget: budgetMs,
      frames: STABLE_FRAMES,
      selector: SCRIPT_DRIVEN_SELECTOR,
    }
  );
  if (stuck.length > 0) {
    throw new Error(
      `showScreenAlone: ainda se move depois de ${budgetMs} ms: ${stuck.join(", ")}. Encurte a animação ou tire-a da tela capturada.`
    );
  }
}
