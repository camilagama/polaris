/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { watchCspViolations } from "../e2e/csp-fixture";
import { expectMotionLevel } from "./motion-expect";

/**
 * The thumbnail of a product in the gallery, as the browser draws it: the same box in the same place in every state
 * (AC-2), the marker without noise (AC-3), the photo as decoration (AC-4), and the photo appearing at once on a phone
 * and with `prefers-reduced-motion`, with a fade of 150 ms only at the `full` level. Both themes.
 */
const STATES = [
  "cache",
  "sem-imagem",
  "carregando",
  "erro",
  "offline-cache",
  "offline-vazio",
] as const;
const WITH_PHOTO = new Set(["cache", "offline-cache"]);

async function openGallery(page: Page, theme: "claro" | "escuro") {
  await page.addInitScript((stored) => {
    window.localStorage.setItem("polaris-tema", stored);
  }, theme);
  await page.goto("/ui-galeria");
  const section = page.getByRole("region", { name: "Miniatura do produto" });
  await section.scrollIntoViewIfNeeded();
  for (const state of WITH_PHOTO) {
    // biome-ignore lint/performance/noAwaitInLoops: each state settles on its own
    await expect(
      page.getByTestId(`miniatura-${state}`).locator("[data-thumbnail]")
    ).toHaveCount(2);
    await expect(
      page.getByTestId(`miniatura-${state}`).locator('[data-thumbnail="photo"]')
    ).toHaveCount(2);
  }
  return section;
}

function boxes(page: Page) {
  return page.evaluate(
    (states) =>
      states.map((state) => {
        const cell = document.querySelector(
          `[data-testid="miniatura-${state}"]`
        );
        const thumbs = [...(cell?.querySelectorAll("[data-thumbnail]") ?? [])];
        const row = cell?.getBoundingClientRect();
        return {
          state,
          thumbs: thumbs.map((thumb) => {
            const box = thumb.getBoundingClientRect();
            const style = getComputedStyle(thumb);
            return {
              background: style.backgroundColor,
              height: box.height,
              left: Math.round((box.left - (row?.left ?? 0)) * 10) / 10,
              tags: [...thumb.querySelectorAll("*")].map(
                (node) => node.tagName
              ),
              text: thumb.textContent,
              top: Math.round((box.top - (row?.top ?? 0)) * 10) / 10,
              width: box.width,
            };
          }),
        };
      }),
    STATES
  );
}

for (const theme of ["claro", "escuro"] as const) {
  test(`a caixa é a mesma nos seis estados, com o marcador sem ruído (tema ${theme})`, async ({
    page,
  }) => {
    const csp = await watchCspViolations(page);
    await openGallery(page, theme);
    const measured = await boxes(page);
    const [reference] = measured;
    for (const { state, thumbs } of measured) {
      expect(thumbs, state).toHaveLength(2);
      const [large, small] = thumbs;
      expect([large?.width, large?.height], state).toEqual([40, 40]);
      expect([small?.width, small?.height], state).toEqual([32, 32]);
      expect(
        thumbs.map(({ left, top }) => ({ left, top })),
        `${state}: mesma posição do estado em cache`
      ).toEqual(reference?.thumbs.map(({ left, top }) => ({ left, top })));
      for (const thumb of thumbs) {
        expect(thumb.text, state).toBe("CA");
        expect(thumb.background, state).toBe(reference?.thumbs[0]?.background);
        expect(thumb.tags, state).toEqual(WITH_PHOTO.has(state) ? ["IMG"] : []);
      }
    }
    expect(csp.violations()).toEqual([]);
  });
}

test("a foto é decoração: alt vazio, fora da árvore de acessibilidade e sem foco", async ({
  page,
}) => {
  await openGallery(page, "claro");
  const cell = page.getByTestId("miniatura-cache");
  await expect(cell.locator("img")).toHaveCount(2);
  for (const img of await cell.locator("img").all()) {
    // biome-ignore lint/performance/noAwaitInLoops: two images
    await expect(img).toHaveAttribute("alt", "");
    expect(await img.evaluate((node) => node.tabIndex)).toBe(-1);
  }
  await expect(cell.getByRole("img")).toHaveCount(0);
  const tree = await page.getByTestId("miniatura-sem-imagem").ariaSnapshot();
  expect(tree).not.toContain("CA");
});

test("a foto entra por cima com opacidade em 150 ms só no nível full; no celular e com movimento reduzido, de uma vez", async ({
  page,
}) => {
  await openGallery(page, "claro");
  const level = await expectMotionLevel(page);
  const img = page.getByTestId("miniatura-cache").locator("img").first();
  await expect(img).toHaveCSS("opacity", "1");
  await expect(img).toHaveCSS("object-fit", "cover");
  await expect(img).toHaveCSS(
    "transition-duration",
    level === "full" ? "0.15s" : "0s"
  );
});

test.describe("com prefers-reduced-motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("a foto aparece sem transição", async ({ page }) => {
    await openGallery(page, "escuro");
    expect(await expectMotionLevel(page)).toBe("none");
    const img = page.getByTestId("miniatura-cache").locator("img").first();
    await expect(img).toHaveCSS("opacity", "1");
    // the reset of theme.css for `prefers-reduced-motion` leaves 0.01 ms: no frame is drawn in between
    const seconds = await img.evaluate((node) =>
      Number.parseFloat(getComputedStyle(node).transitionDuration)
    );
    expect(seconds).toBeLessThan(0.001);
  });
});
