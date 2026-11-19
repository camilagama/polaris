import type { Page } from "@playwright/test";

const FINITE_ANIMATION_BUDGET_MS = 10_000;

/**
 * Hides the lab's own controls and waits for the fonts, for the layout to settle after the scroll and the hiding
 * (two frames) and for the finite animations of the clock to end. Not waited for: an animation that repeats forever (the
 * skeleton, the spinner) and one driven by the scroll (it ends only at the end of the scroll), neither of which finishes
 * by itself; nor script-driven movement or image decoding, which `getAnimations` does not list.
 *
 * A finite animation still running after `budgetMs` fails with its name and total duration: a very long one would
 * otherwise only show as the 45 s test timeout, with no hint of which animation holds the screen.
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
    (budget) =>
      new Promise<string[]>((resolve) => {
        const startedAt = performance.now();
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
          if (left.length === 0) {
            resolve([]);
            return;
          }
          if (performance.now() - startedAt > budget) {
            resolve(
              left.map((animation) => {
                let name = animation.id || "(sem nome)";
                if (animation instanceof CSSAnimation) {
                  name = animation.animationName;
                } else if (animation instanceof CSSTransition) {
                  name = animation.transitionProperty;
                }
                const total = animation.effect?.getComputedTiming().endTime;
                return `"${name}" (${String(total)} ms no total)`;
              })
            );
            return;
          }
          requestAnimationFrame(check);
        };
        check();
      }),
    budgetMs
  );
  if (stuck.length > 0) {
    throw new Error(
      `showScreenAlone: animação finita ainda rodando depois de ${budgetMs} ms: ${stuck.join(", ")}. Encurte-a ou tire-a da tela capturada.`
    );
  }
}
