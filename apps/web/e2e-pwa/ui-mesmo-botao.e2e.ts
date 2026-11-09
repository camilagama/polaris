/// <reference lib="dom" />
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { SCREENS, VIEWPORTS } from "./ui-screens";

/**
 * The same action is the same button: "Esconder valores" has one size on Início and Resultado, and the secondary
 * actions of a card ("Ver o resultado", "Ver o que falta") are text-only buttons with an arrow, never an underlined
 * link, with the height of a text-only button (28 with a mouse, 32 with touch) and the radius of a control (0,55 rem).
 */
const HOME_SCREEN = "início com vendas";
const RESULT_SCREEN = "resultado mês incompleto e gráfico de vendas";

const CONTEXTS = [
  { name: "1280 com mouse", textHeight: 28, touch: false, width: "1280" },
  { name: "360 com toque", textHeight: 32, touch: true, width: "360" },
] as const;

const CONTROL_RADIUS_PX = 8.8;
const CARD_ACTION_ROW_PX = 16;

const openScreen = async (page: Page, name: string) => {
  const screen = SCREENS.find((candidate) => candidate.name === name);
  expect(screen, `a tela "${name}" não está em SCREENS`).toBeDefined();
  await screen?.open(page, page.context());
};

const styleOf = (locator: Locator) =>
  locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      height: element.getBoundingClientRect().height,
      layoutHeight:
        element.getBoundingClientRect().height +
        Number.parseFloat(style.marginTop) +
        Number.parseFloat(style.marginBottom),
      radius: Number.parseFloat(style.borderTopLeftRadius),
      underline: style.textDecorationLine,
    };
  });

const hideValuesHeight = async (page: Page, screen: string) => {
  await openScreen(page, screen);
  const button = page.getByRole("button", {
    exact: true,
    name: "Esconder valores",
  });
  await expect(button).toBeVisible();
  return (await button.boundingBox())?.height ?? 0;
};

test.beforeEach(({ browserName }, testInfo) => {
  test.skip(
    browserName !== "chromium" || testInfo.project.name !== "chromium-desktop",
    "the matrix sets its own viewports and pointer"
  );
});

for (const context of CONTEXTS) {
  test.describe(`mesmo botão · ${context.name}`, () => {
    test.use({
      hasTouch: context.touch,
      isMobile: context.touch,
      viewport: VIEWPORTS[context.width],
    });

    test('"Esconder valores" tem a mesma altura no Início e no Resultado', async ({
      page,
    }) => {
      const home = await hideValuesHeight(page, HOME_SCREEN);
      const result = await hideValuesHeight(page, RESULT_SCREEN);
      expect(home).toBeGreaterThan(0);
      expect(result).toBe(home);
    });

    test('"Ver o resultado" é botão só texto, sem sublinhado, com o raio de controle', async ({
      page,
    }) => {
      await openScreen(page, HOME_SCREEN);
      const link = page.getByRole("link", {
        exact: true,
        name: "Ver o resultado",
      });
      await expect(link).toHaveAttribute("href", "/dashboard");
      const style = await styleOf(link);
      expect(style.underline).toBe("none");
      expect(style.height).toBeCloseTo(context.textHeight, 0);
      expect(style.radius).toBeCloseTo(CONTROL_RADIUS_PX, 1);
      expect(
        style.layoutHeight,
        "o cartão guarda 16 px para a ação: o botão não o alarga"
      ).toBeCloseTo(CARD_ACTION_ROW_PX, 0);
    });

    test('"Ver o que falta" é botão só texto, sem sublinhado, e mantém aria-expanded', async ({
      page,
    }) => {
      await openScreen(page, RESULT_SCREEN);
      const button = page.getByRole("button", {
        exact: true,
        name: "Ver o que falta",
      });
      await expect(button).toHaveAttribute("aria-expanded", "false");
      const style = await styleOf(button);
      expect(style.underline).toBe("none");
      expect(style.height).toBeCloseTo(context.textHeight, 0);
      expect(style.radius).toBeCloseTo(CONTROL_RADIUS_PX, 1);
      await button.click();
      await expect(button).toHaveAttribute("aria-expanded", "true");
    });
  });
}
