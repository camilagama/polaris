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

function pillPage(scaleAt: string) {
  return `
<div data-slot="filter-pill" id="pill" style="width: 100px; height: 20px; transform: scale(0.95);"></div>
<script>
  const pill = document.getElementById("pill");
  const startedAt = performance.now();
  const step = () => {
    const elapsed = performance.now() - startedAt;
    pill.style.transform = "scale(" + (${scaleAt}) + ")";
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
</script>
`;
}

test("showScreenAlone: espera a pílula movida por script (fora de getAnimations) parar antes de devolver", async ({
  page,
}) => {
  await page.setContent(pillPage("0.95 + 0.05 * Math.min(elapsed / 600, 1)"));

  await showScreenAlone(page);

  const width = await page.evaluate(
    () => document.getElementById("pill")?.getBoundingClientRect().width
  );
  expect(width).toBe(100);
});

test("showScreenAlone: pílula que não para falha com o seletor e o orçamento, sem esperar o timeout do teste", async ({
  page,
}) => {
  await page.setContent(pillPage("1 + 0.05 * Math.sin(elapsed / 50)"));

  const failure = await showScreenAlone(page, { budgetMs: 500 }).then(
    () => null,
    (error: Error) => error
  );

  expect(failure?.message).toContain("filter-pill");
  expect(failure?.message).toContain("caixa ainda mudando");
  expect(failure?.message).toContain("500 ms");
});

test("showScreenAlone: cauda do spring da pílula, com a caixa quase parada e o ícone ainda escalado, também é esperada", async ({
  page,
}) => {
  await page.setContent(`
<div data-slot="filter-pill" id="pill" style="width: 100px; height: 20px;">
  <svg class="lucide" width="16" height="16"></svg>
</div>
<script>
  const pill = document.getElementById("pill");
  const startedAt = performance.now();
  const step = () => {
    const elapsed = performance.now() - startedAt;
    const scale = elapsed < 700 ? 1 + 0.0008 * Math.exp(-elapsed / 120) : 1;
    pill.style.transform = "scale(" + scale + ")";
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
</script>
`);

  await showScreenAlone(page);

  const state = await page.evaluate(() => {
    const pill = document.getElementById("pill") as HTMLElement;
    return {
      iconWidth: pill.querySelector("svg")?.getBoundingClientRect().width,
      scaled: !new DOMMatrix(getComputedStyle(pill).transform).isIdentity,
    };
  });
  expect(state.scaled).toBe(false);
  expect(state.iconWidth).toBeCloseTo(16, 3);
});
