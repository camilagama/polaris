/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { SCREENS, VIEWPORTS } from "./ui-screens";

/**
 * Estoque, Resultado and Histórico put their action on the line of the title (`TitleLine`): at the right of it from
 * 760 px, on the same line; under it and as wide as the screen on a phone, with no sideways scroll even with the
 * letter at 20 px. The title, the (i) of it and the action come in this order in the tab order, there is one `h1`, and
 * the first thing after the heading block is at the same distance from it as on the screens that already followed the
 * pattern. The Resultado draws the period and "Atualizar" only on the Resultado tab: the Metas have their own.
 */
const SAME_LINE = 2;
const PHONE_MARGIN = 48;
const BIG_LETTER = 20;
/** The space between the heading block and what comes after it: the gap of the page grid of a screen (`gap-4`). */
const HEADER_GAP = 16;
const PERIOD_BUTTON = /^Período/;
const METAS_TAB = /^Metas/;
const GOALS_REFRESH = /^Atualizar metas/;
const NEW_GOAL = /^Nova meta$/;
const TABS_SAME_PLACE = 1;

const ON_THE_LINE = [
  {
    action: /^Atualizar$/,
    actionLabel: "Atualizar",
    hasAbout: true,
    heading: "Estoque",
    screen: "estoque lista",
  },
  {
    action: /^Período/,
    actionLabel: "Período",
    hasAbout: true,
    heading: "Resultado",
    screen: "resultado mês incompleto e gráfico de vendas",
  },
  {
    action: /^Período/,
    actionLabel: "Período",
    hasAbout: false,
    heading: "Histórico de vendas",
    screen: "histórico lista",
  },
  {
    action: /^Atualizar metas/,
    actionLabel: "Atualizar metas",
    hasAbout: true,
    heading: "Resultado",
    screen: "resultado metas",
  },
] as const;

const REFERENCES = [
  { heading: "Produtos", screen: "produtos lista" },
  { heading: "Despesas", screen: "despesas lista" },
  { heading: "Clientes", screen: "clientes lista" },
] as const;

const screenOf = (name: string) => {
  const found = SCREENS.find((candidate) => candidate.name === name);
  expect(found, `a tela "${name}" não está em SCREENS`).toBeDefined();
  return found as NonNullable<typeof found>;
};

interface Box {
  bottom: number;
  height: number;
  left: number;
  right: number;
  top: number;
  width: number;
}

interface Geometry {
  action: Box;
  actions: Box;
  headings: number;
  scrollWidth: number;
  title: Box;
  viewportWidth: number;
}

function geometryOf(
  page: Page,
  heading: string,
  action: { flags: string; source: string }
): Promise<Geometry> {
  return page.evaluate(
    ([headingText, actionSource, actionFlags]) => {
      const box = (element: Element): Box => {
        const { bottom, height, left, right, top, width } =
          element.getBoundingClientRect();
        return { bottom, height, left, right, top, width };
      };
      const matcher = new RegExp(actionSource, actionFlags);
      const title = [...document.querySelectorAll("h1")].find(
        (candidate) => candidate.textContent?.trim() === headingText
      ) as HTMLElement;
      const control = [
        ...document.querySelectorAll<HTMLElement>("main button, main a[href]"),
      ].find((candidate) =>
        matcher.test(
          (
            candidate.getAttribute("aria-label") ??
            candidate.textContent ??
            ""
          ).trim()
        )
      ) as HTMLElement;
      return {
        action: box(control),
        actions: box(control.closest("[data-title-actions]") as HTMLElement),
        headings: [...document.querySelectorAll("h1")].filter((shown) =>
          shown.checkVisibility()
        ).length,
        scrollWidth: document.documentElement.scrollWidth,
        title: box(title),
        viewportWidth: innerWidth,
      };
    },
    [heading, action.source, action.flags] as const
  );
}

test.beforeEach(({ browserName }, testInfo) => {
  test.skip(
    browserName !== "chromium" || testInfo.project.name !== "chromium-desktop",
    "the matrix sets its own viewports and touch"
  );
});

const CONTEXTS = [
  { name: "1280 com mouse", touch: false, viewport: VIEWPORTS["1280"] },
  { name: "360 com toque", touch: true, viewport: VIEWPORTS["360"] },
  { name: "320 com toque", touch: true, viewport: VIEWPORTS["320"] },
] as const;

for (const line of ON_THE_LINE) {
  for (const context of CONTEXTS) {
    test.describe(`${line.screen} · ${context.name}`, () => {
      test.use({
        hasTouch: context.touch,
        isMobile: context.touch,
        viewport: context.viewport,
      });

      test("a ação está na linha do título (1280) ou sob ele, na largura toda, sem rolagem lateral", async ({
        page,
      }) => {
        await screenOf(line.screen).open(page, page.context());
        const shape = await geometryOf(page, line.heading, {
          flags: line.action.flags,
          source: line.action.source,
        });
        expect(shape.headings, "um h1 por página").toBe(1);
        expect(shape.scrollWidth, "rolagem lateral").toBeLessThanOrEqual(
          shape.viewportWidth
        );
        if (context.touch) {
          expect(shape.action.top, "abaixo do título").toBeGreaterThanOrEqual(
            shape.title.bottom - 1
          );
          expect(shape.actions.width, "largura da tela").toBeGreaterThan(
            shape.viewportWidth - PHONE_MARGIN
          );
          expect(shape.action.left).toBeGreaterThanOrEqual(0);
          expect(shape.action.right).toBeLessThanOrEqual(shape.viewportWidth);
        } else {
          expect(
            Math.abs(shape.action.top - shape.title.top),
            "o mesmo top do título"
          ).toBeLessThanOrEqual(SAME_LINE);
          expect(shape.action.left, "à direita do título").toBeGreaterThan(
            shape.title.right
          );
          expect(shape.action.right, "na borda direita").toBeGreaterThan(
            shape.viewportWidth / 2
          );
        }
      });
    });
  }

  test.describe(`${line.screen} · 320 com letra de ${BIG_LETTER} px`, () => {
    test.use({
      hasTouch: true,
      isMobile: true,
      viewport: VIEWPORTS["320"],
    });

    test("nada é cortado nem passa da borda", async ({ page }) => {
      await screenOf(line.screen).open(page, page.context());
      await page.evaluate((pixels) => {
        document.documentElement.style.fontSize = `${pixels}px`;
      }, BIG_LETTER);
      const shape = await geometryOf(page, line.heading, {
        flags: line.action.flags,
        source: line.action.source,
      });
      expect(shape.scrollWidth).toBeLessThanOrEqual(shape.viewportWidth);
      expect(shape.action.left).toBeGreaterThanOrEqual(0);
      expect(shape.action.right).toBeLessThanOrEqual(shape.viewportWidth);
      expect(shape.title.right).toBeLessThanOrEqual(shape.viewportWidth);
    });
  });

  test.describe(`${line.screen} · ordem do foco`, () => {
    test.use({ hasTouch: false, viewport: VIEWPORTS["1280"] });

    test("título, o (i) dele, a ação, e só então o conteúdo", async ({
      page,
    }) => {
      await screenOf(line.screen).open(page, page.context());
      await page
        .getByRole("heading", { exact: true, level: 1, name: line.heading })
        .click();
      const about = page.getByRole("button", {
        exact: true,
        name: `Sobre ${line.heading}`,
      });
      if (line.hasAbout) {
        await page.keyboard.press("Tab");
        await expect(about, "o (i) do título").toBeFocused();
      } else {
        await expect(about, "sem (i) no título").toHaveCount(0);
      }
      await page.keyboard.press("Tab");
      await expect(
        page.locator(":focus"),
        `a ação "${line.actionLabel}"`
      ).toHaveAccessibleName(line.action);
      expect(
        await page.evaluate(
          () => document.activeElement?.closest("[data-title-actions]") !== null
        ),
        "a ação está na linha do título"
      ).toBe(true);
    });
  });
}

const TAB_JUMP_CONTEXTS = [CONTEXTS[0], CONTEXTS[1]] as const;

for (const context of TAB_JUMP_CONTEXTS) {
  test.describe(`Resultado e Metas · as abas não pulam · ${context.name}`, () => {
    test.use({
      hasTouch: context.touch,
      isMobile: context.touch,
      viewport: context.viewport,
    });

    test("a linha do título existe nas duas abas, com as ações de cada uma, e as abas ficam no mesmo lugar", async ({
      page,
    }) => {
      await screenOf("resultado mês incompleto e gráfico de vendas").open(
        page,
        page.context()
      );
      const actions = page.locator("[data-title-actions]");
      const tabs = page.getByRole("tab", { exact: true, name: "Resultado" });
      const tabTop = async () =>
        tabs.evaluate(
          (tab) => tab.getBoundingClientRect().top + window.scrollY
        );
      await expect(
        actions.getByRole("button", { name: PERIOD_BUTTON })
      ).toBeVisible();
      const onResultado = await tabTop();
      await page.getByRole("tab", { name: METAS_TAB }).click();
      await expect(page.getByRole("tab", { name: METAS_TAB })).toHaveAttribute(
        "aria-selected",
        "true"
      );
      await expect(
        actions.getByRole("button", { name: GOALS_REFRESH })
      ).toBeVisible();
      await expect(
        actions.getByRole("button", { name: NEW_GOAL })
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: PERIOD_BUTTON })
      ).toHaveCount(0);
      expect(
        Math.abs((await tabTop()) - onResultado),
        "as abas não pulam ao ir para as Metas"
      ).toBeLessThanOrEqual(TABS_SAME_PLACE);
      await page.getByRole("tab", { exact: true, name: "Resultado" }).click();
      await expect(
        actions.getByRole("button", { name: PERIOD_BUTTON })
      ).toBeVisible();
      expect(
        Math.abs((await tabTop()) - onResultado),
        "as abas não pulam ao voltar para o Resultado"
      ).toBeLessThanOrEqual(TABS_SAME_PLACE);
    });
  });
}

for (const context of CONTEXTS.slice(0, 2)) {
  for (const entry of [...ON_THE_LINE, ...REFERENCES]) {
    test.describe(`distância do título ao conteúdo · ${entry.screen} · ${context.name}`, () => {
      test.use({
        hasTouch: context.touch,
        isMobile: context.touch,
        viewport: context.viewport,
      });

      test("é a mesma de todas as telas com a linha do título", async ({
        page,
      }) => {
        await screenOf(entry.screen).open(page, page.context());
        const gap = await page.evaluate((headingText) => {
          const title = [...document.querySelectorAll("h1")].find(
            (candidate) => candidate.textContent?.trim() === headingText
          ) as HTMLElement;
          const line = title.closest("[data-title-line]") as HTMLElement;
          const block =
            line.parentElement?.tagName === "HEADER"
              ? line.parentElement
              : line;
          return (
            (block.nextElementSibling as HTMLElement).getBoundingClientRect()
              .top - block.getBoundingClientRect().bottom
          );
        }, entry.heading);
        expect(gap).toBeCloseTo(HEADER_GAP, 0);
      });
    });
  }
}
