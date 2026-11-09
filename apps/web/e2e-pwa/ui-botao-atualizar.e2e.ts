/// <reference lib="dom" />
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { SCREENS, VIEWPORTS } from "./ui-screens";

/**
 * "Atualizar" is one component on Início, Resultado, Metas, Estoque and Vender: the same height in every one (32 with a mouse,
 * 36 with touch from 760 px, the icon of `ctl-lg` below it, as "Esconder valores"), a name that starts with
 * "Atualizar" and keeps the object ("Atualizar metas", "Atualizar estoque e perfis"), and a turning icon only with
 * full motion: a phone and `prefers-reduced-motion` keep it still, and the button keeps its size while it reads.
 * Estoque and Vender have no state of their own for reading (the first draws its loading card, the second keeps what
 * is ready), so on them the icon is still at rest in every context.
 */
const RESULT_SCREEN = "resultado mês incompleto e gráfico de vendas";

const REFRESHES = [
  { name: "Atualizar", screen: "início com vendas" },
  { name: "Atualizar", screen: RESULT_SCREEN },
  { name: "Atualizar metas", screen: "resultado metas" },
  { name: "Atualizar", screen: "estoque lista" },
  { name: "Atualizar estoque e perfis", screen: "venda com itens" },
] as const;

const CONTEXTS = [
  { height: 32, name: "1280 com mouse", touch: false, width: "1280" },
  { height: 36, name: "1280 com toque", touch: true, width: "1280" },
  { height: 40, name: "360 com toque", touch: true, width: "360" },
  { height: 40, name: "320 com toque", touch: true, width: "320" },
] as const;

const openScreen = async (page: Page, name: string) => {
  const screen = SCREENS.find((candidate) => candidate.name === name);
  expect(screen, `a tela "${name}" não está em SCREENS`).toBeDefined();
  await screen?.open(page, page.context());
};

/**
 * The Resultado with its reads held: the answers of the server wait for `release`, so the button stays in the
 * state of reading for as long as the test looks at it. The held route is the last one registered, the first asked.
 */
async function readingResult(page: Page) {
  await openScreen(page, RESULT_SCREEN);
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/rpc/**", async (route) => {
    await held;
    await route.fallback();
  });
  const button = page.getByRole("button", { exact: true, name: "Atualizar" });
  const before = await button.boundingBox();
  await button.click();
  await expect(button).toHaveAttribute("aria-busy", "true");
  return { before, button, release };
}

const heightOf = async (page: Page, name: string) => {
  const button = page.getByRole("button", { exact: true, name });
  await expect(button).toBeVisible();
  const box = await button.boundingBox();
  return box?.height ?? 0;
};

test.beforeEach(({ browserName }, testInfo) => {
  test.skip(
    browserName !== "chromium" || testInfo.project.name !== "chromium-desktop",
    "the matrix sets its own viewports, pointer and motion preference"
  );
});

for (const context of CONTEXTS) {
  test.describe(`altura e nome · ${context.name}`, () => {
    test.use({
      hasTouch: context.touch,
      isMobile: context.touch,
      viewport: VIEWPORTS[context.width],
    });

    for (const { name, screen } of REFRESHES) {
      test(`${screen}: "${name}" tem ${context.height} px`, async ({
        page,
      }) => {
        await openScreen(page, screen);
        expect(await heightOf(page, name)).toBeCloseTo(context.height, 0);
      });
    }

    test("resultado lendo: o botão tem a mesma altura e diz aria-busy", async ({
      page,
    }) => {
      const read = await readingResult(page);
      expect(await heightOf(page, "Atualizar")).toBeCloseTo(context.height, 0);
      const during = await read.button.boundingBox();
      expect(during, "o botão lendo não muda de lugar nem de tamanho").toEqual(
        read.before
      );
      read.release();
      await expect(read.button).not.toHaveAttribute("aria-busy", "true");
    });
  });
}

const spinOf = (read: { button: Locator }) =>
  read.button
    .locator("svg")
    .evaluate((icon) => getComputedStyle(icon).animationName);

const RESTING = [
  { name: "Atualizar", screen: "estoque lista" },
  { name: "Atualizar estoque e perfis", screen: "venda com itens" },
] as const;

const restingSpin = async (page: Page, screen: string, name: string) => {
  await openScreen(page, screen);
  const button = page.getByRole("button", { exact: true, name });
  await expect(button).toBeVisible();
  await expect(button).not.toHaveAttribute("aria-busy", "true");
  return spinOf({ button });
};

test.describe("o ícone gira só com movimento completo", () => {
  test.describe("mouse e movimento padrão", () => {
    test.use({ hasTouch: false, viewport: VIEWPORTS["1280"] });

    for (const { name, screen } of RESTING) {
      test(`${screen}: sem aria-busy e sem giro em repouso`, async ({
        page,
      }) => {
        expect(await restingSpin(page, screen, name)).toBe("none");
        await expect(page.locator("html")).toHaveAttribute(
          "data-motion",
          "full"
        );
      });
    }

    test("gira enquanto lê (controle)", async ({ page }) => {
      const read = await readingResult(page);
      await expect(page.locator("html")).toHaveAttribute("data-motion", "full");
      expect(await spinOf(read)).toBe("spin");
    });
  });

  test.describe("prefers-reduced-motion", () => {
    test.use({
      hasTouch: false,
      reducedMotion: "reduce",
      viewport: VIEWPORTS["1280"],
    });

    for (const { name, screen } of RESTING) {
      test(`${screen}: sem giro em repouso`, async ({ page }) => {
        expect(await restingSpin(page, screen, name)).toBe("none");
        await expect(page.locator("html")).toHaveAttribute(
          "data-motion",
          "none"
        );
      });
    }

    test("fica parado, e continua com aria-busy", async ({ page }) => {
      const read = await readingResult(page);
      await expect(page.locator("html")).toHaveAttribute("data-motion", "none");
      expect(await spinOf(read)).toBe("none");
      await expect(
        page.getByRole("button", { exact: true, name: "Atualizar" })
      ).toHaveAttribute("aria-busy", "true");
    });
  });

  test.describe("celular com toque", () => {
    test.use({
      hasTouch: true,
      isMobile: true,
      viewport: VIEWPORTS["360"],
    });

    for (const { name, screen } of RESTING) {
      test(`${screen}: sem giro em repouso`, async ({ page }) => {
        expect(await restingSpin(page, screen, name)).toBe("none");
        await expect(page.locator("html")).toHaveAttribute(
          "data-motion",
          "essential"
        );
      });
    }

    test("fica parado, e continua com aria-busy", async ({ page }) => {
      const read = await readingResult(page);
      await expect(page.locator("html")).toHaveAttribute(
        "data-motion",
        "essential"
      );
      expect(await spinOf(read)).toBe("none");
      await expect(
        page.getByRole("button", { exact: true, name: "Atualizar" })
      ).toHaveAttribute("aria-busy", "true");
    });
  });
});
