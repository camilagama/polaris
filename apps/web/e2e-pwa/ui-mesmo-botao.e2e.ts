/// <reference lib="dom" />
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { SCREENS, VIEWPORTS } from "./ui-screens";

/**
 * The same action is the same button: the secondary action of a card ("Ver o que falta") is a text-only button with
 * an arrow, never an underlined link, with the height of a text-only button (28 with a mouse, 32 with touch) and the
 * radius of a control (0,55 rem).
 */
const RESULT_SCREEN = "resultado mês incompleto e gráfico de vendas";

const CONTEXTS = [
  { name: "1280 com mouse", textHeight: 28, touch: false, width: "1280" },
  { name: "360 com toque", textHeight: 32, touch: true, width: "360" },
] as const;

const CONTROL_RADIUS_PX = 8.8;

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
      radius: Number.parseFloat(style.borderTopLeftRadius),
      underline: style.textDecorationLine,
    };
  });

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
