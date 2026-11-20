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

const MOVERS = {
  box: "pill.style.marginLeft = (20 * (1 - progress)) + 'px';",
  transform:
    "pill.style.transform = 'scale(' + (0.95 + 0.05 * progress) + ')';",
};

function pillLab(move: string) {
  return `
<body style="margin: 0">
<div data-lab-chrome>controls</div>
<div data-slot="filter-pill" id="pill" style="display: inline-flex; width: 120px; height: 36px;">
  <svg class="lucide" width="16" height="16"></svg>
</div>
<script>
  const pill = document.getElementById("pill");
  const start = performance.now();
  const step = (now) => {
    const progress = Math.min((now - start) / 500, 1);
    ${move}
    if (progress < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
</script>
</body>
`;
}

for (const [kind, move] of Object.entries(MOVERS)) {
  test(`showScreenAlone: pill movido por script (${kind}, fora do getAnimations) só é medido depois de parar`, async ({
    page,
  }) => {
    await page.setContent(pillLab(move));

    await showScreenAlone(page);

    const state = await page.evaluate(() => {
      const pill = document.getElementById("pill") as HTMLElement;
      const icon = pill.querySelector("svg") as SVGElement;
      return {
        iconWidth: icon.getBoundingClientRect().width,
        left: pill.getBoundingClientRect().left,
        moving: !new DOMMatrix(getComputedStyle(pill).transform).isIdentity,
      };
    });
    expect(state.moving).toBe(false);
    expect(state.iconWidth).toBe(16);
    expect(state.left).toBe(0);
  });
}
