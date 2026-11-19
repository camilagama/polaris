import { expect, test } from "@playwright/test";
import { showScreenAlone } from "./show-screen-alone";

const LAB = `
<style>
  @keyframes pulse { 50% { opacity: 0.4; } }
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
  @keyframes by-scroll { to { opacity: 0.5; } }
  body { height: 3000px; }
  .skeleton { animation: pulse 1s infinite; height: 20px; background: #ccc; }
  .card { animation: fade 400ms both; height: 20px; background: #999; }
  .scrolled { animation: by-scroll 1ms both; animation-timeline: scroll(root block); height: 20px; background: #666; }
</style>
<div data-lab-chrome>controls</div>
<div class="skeleton"></div>
<div class="card" id="card"></div>
<div class="scrolled"></div>
`;

test("showScreenAlone: com esqueleto e animação de rolagem na tela a espera termina, depois da animação finita", async ({
  page,
}) => {
  await page.setContent(LAB);

  await showScreenAlone(page);

  const state = await page.evaluate(() => {
    const animations = document.getAnimations();
    const card = document
      .getElementById("card")
      ?.getAnimations()
      .map((animation) => animation.playState);
    return {
      cardStates: card,
      chromeHidden: (document.querySelector("[data-lab-chrome]") as HTMLElement)
        .hidden,
      skeletonStillRuns: animations.some(
        (animation) =>
          animation.playState === "running" &&
          animation.effect?.getComputedTiming().iterations ===
            Number.POSITIVE_INFINITY
      ),
    };
  });
  expect(state.chromeHidden).toBe(true);
  expect(state.cardStates).toEqual(["finished"]);
  expect(state.skeletonStillRuns).toBe(true);
});

test("showScreenAlone: animação finita longa demais falha com o nome e a duração, sem esperar o timeout do teste", async ({
  page,
}) => {
  await page.setContent(`
<style>
  @keyframes slow-reveal { from { opacity: 0; } to { opacity: 1; } }
  .slow { animation: slow-reveal 60s both; height: 20px; background: #999; }
</style>
<div class="slow"></div>
`);

  const failure = await showScreenAlone(page, { budgetMs: 500 }).then(
    () => null,
    (error: Error) => error
  );

  expect(failure?.message).toContain("slow-reveal");
  expect(failure?.message).toContain("60000 ms");
  expect(failure?.message).toContain("500 ms");
});
