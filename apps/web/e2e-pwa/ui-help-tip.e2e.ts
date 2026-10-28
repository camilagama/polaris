/// <reference lib="dom" />
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { watchCspViolations } from "../e2e/csp-fixture";
import { axeFaults, touchFaults } from "./ui-guardrails";

/**
 * The HelpTip in the gallery (`/ui-galeria`, section "Ajuda (i)"): it opens by click, touch, Enter and Space and never
 * by hover; focus goes into the popup and comes back to the button on Esc, on a press outside and on the button itself;
 * the popup comes out whole from a card that clips its overflow; it is 18 rem wide, below the button and aligned to
 * its start, and it fits the 360 px window; axe finds no violation with it open, in each theme.
 */
const THEMES = [
  { name: "claro", stored: "claro" },
  { name: "escuro", stored: "escuro" },
] as const;

const RESULT_TEXT =
  "Vendas menos custos, taxas e despesas de 1 a 23/10. Compara com 1 a 23/09.";

async function openGallery(page: Page, stored: string | null = null) {
  if (stored) {
    await page.addInitScript((theme) => {
      window.localStorage.setItem("polaris-tema", theme);
    }, stored);
  }
  await page.goto("/ui-galeria");
  await expect(
    page.getByRole("heading", { name: "Galeria da interface" })
  ).toBeVisible();
  // Geist must be in before axe measures contrast and sizes
  await page.evaluate(() => document.fonts.ready);
}

const section = (page: Page) => page.getByRole("region", { name: "Ajuda (i)" });
const helpButton = (page: Page, about = "Resultado estimado") =>
  section(page).getByRole("button", { name: `Sobre ${about}` });
const popup = (page: Page, about = "Resultado estimado") =>
  page.getByRole("dialog", { name: about });

/** The popup zooms and slides in: wait for the animations that end, never the ones that loop (a skeleton pulse). */
async function settle(page: Page) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.effect?.getComputedTiming().iterations !==
            Number.POSITIVE_INFINITY
        )
        .map((animation) => animation.finished.catch(() => undefined))
    )
  );
}

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  expect(found).not.toBeNull();
  return found as NonNullable<typeof found>;
}

test("o botão se chama 'Sobre {título}', tem 24 px visíveis e promete um diálogo", async ({
  page,
}) => {
  await openGallery(page);
  const button = helpButton(page);
  await button.scrollIntoViewIfNeeded();
  await expect(button).toHaveAttribute("aria-haspopup", "dialog");
  await expect(button).toHaveAttribute("aria-expanded", "false");
  const visible = await box(button);
  expect([visible.width, visible.height]).toEqual([24, 24]);
  // the icon is 16 px and the screen reader hears only the name of the button
  const icon = button.locator("svg");
  await expect(icon).toHaveAttribute("aria-hidden", "true");
  expect((await box(icon)).width).toBe(16);
  await expect(popup(page)).toHaveCount(0);
});

test("o clique abre e o botão fecha: o foco entra no popup e volta ao botão", async ({
  page,
}) => {
  await openGallery(page);
  const button = helpButton(page);
  await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  const open = popup(page);
  await expect(open).toBeVisible();
  await expect(open).toContainText(RESULT_TEXT);
  await expect(
    open.getByText("Resultado estimado", { exact: true })
  ).toBeVisible();
  await expect(open).toBeFocused();

  await button.click();
  await expect(open).toHaveCount(0);
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await expect(button).toBeFocused();
});

for (const key of ["Enter", "Space"]) {
  test(`${key} abre; Esc fecha e devolve o foco ao botão`, async ({ page }) => {
    await openGallery(page);
    const button = helpButton(page);
    await button.focus();
    await page.keyboard.press(key);
    await expect(popup(page)).toBeVisible();
    await expect(popup(page)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(popup(page)).toHaveCount(0);
    await expect(button).toBeFocused();
  });
}

test("um toque ou clique fora fecha e o foco volta ao botão", async ({
  page,
}) => {
  await openGallery(page);
  const button = helpButton(page);
  await button.click();
  await expect(popup(page)).toBeVisible();
  await page.getByRole("heading", { name: "Galeria da interface" }).click();
  await expect(popup(page)).toHaveCount(0);
  await expect(button).toBeFocused();
});

test("o hover não abre nada", async ({ page }) => {
  await openGallery(page);
  const button = helpButton(page);
  await button.hover();
  // a hover popup would open within its delay; wait past any delay the library has
  await page.waitForTimeout(800);
  await expect(popup(page)).toHaveCount(0);
  await expect(button).toHaveAttribute("aria-expanded", "false");
});

test("o link da ajuda é o único item que o Tab alcança dentro do popup", async ({
  page,
}) => {
  await openGallery(page);
  await helpButton(page, "Ticket médio").click();
  const open = popup(page, "Ticket médio");
  await expect(open).toBeVisible();
  const link = open.getByRole("link", { name: "Ver o resultado" });
  await expect(link).toHaveAttribute("href", "/dashboard");
  await expect(open).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(link).toBeFocused();
});

test("o popup mede 18 rem, abre abaixo do botão alinhado ao início e sai inteiro do cartão que corta o que passa da borda", async ({
  page,
}) => {
  await openGallery(page);
  const button = helpButton(page);
  await button.scrollIntoViewIfNeeded();
  await button.click();
  const open = popup(page);
  await expect(open).toBeVisible();
  // the popup animates in (zoom, slide): measure it at rest
  await settle(page);
  const trigger = await box(button);
  const shown = await box(open);
  expect(shown.width).toBeCloseTo(288, 0);
  const windowWidth = page.viewportSize()?.width ?? 0;
  if (trigger.x + shown.width <= windowWidth) {
    expect(Math.abs(shown.x - trigger.x)).toBeLessThanOrEqual(1);
  } else {
    // no room to the right of the button: the popup slides left to stay whole in the window
    expect(shown.x + shown.width).toBeLessThanOrEqual(windowWidth);
  }
  expect(
    Math.abs(shown.y - (trigger.y + trigger.height + 4))
  ).toBeLessThanOrEqual(1);

  // in a portal: no card is its ancestor, so no `overflow` of the card can cut it
  expect(
    await open.evaluate((el) => el.closest('[data-slot="card"]'))
  ).toBeNull();
  // and the card that holds the button is shorter than the popup, which is nevertheless whole and on top
  const card = await box(page.locator('[data-slot="card"]').first());
  expect(shown.y + shown.height).toBeGreaterThan(card.y + card.height);
  const topmost = await page.evaluate(
    ([x, y]) =>
      document
        .elementFromPoint(x as number, y as number)
        ?.closest('[role="dialog"]') !== null,
    [shown.x + shown.width / 2, shown.y + shown.height - 3]
  );
  expect(topmost).toBe(true);
});

test.describe("a 360 px, com toque", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { height: 740, width: 360 },
  });

  test("um toque abre, um toque fora fecha, o popup cabe na janela e o alvo tem 48 px", async ({
    page,
  }) => {
    await openGallery(page);
    const button = helpButton(page);
    await button.scrollIntoViewIfNeeded();

    // 24 px visible, 48 px to touch: the pseudo-element grows the area (the guardrail measures it)
    const faults = (
      await touchFaults(page, { exemptInlineLinks: false, minimum: 48 })
    ).filter((fault) => fault.includes("Sobre "));
    expect(faults).toEqual([]);

    await button.tap();
    const open = popup(page);
    await expect(open).toBeVisible();
    await expect(open).toBeFocused();
    await settle(page);
    const shown = await box(open);
    expect(shown.x).toBeGreaterThanOrEqual(0);
    expect(shown.x + shown.width).toBeLessThanOrEqual(360);
    expect(shown.width).toBeCloseTo(288, 0);

    await page.getByRole("heading", { name: "Galeria da interface" }).tap();
    await expect(open).toHaveCount(0);
    await expect(button).toBeFocused();
  });
});

for (const theme of THEMES) {
  test(`tema ${theme.name}: axe não acha violação com a ajuda aberta`, async ({
    page,
  }) => {
    const csp = await watchCspViolations(page);
    await openGallery(page, theme.stored);
    await helpButton(page).click();
    await expect(popup(page)).toBeVisible();
    await settle(page);
    expect(await axeFaults(page)).toEqual([]);
    expect(csp.violations()).toEqual([]);
  });
}
