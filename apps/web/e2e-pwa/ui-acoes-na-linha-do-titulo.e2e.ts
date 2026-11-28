/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { SCREENS, VIEWPORTS } from "./ui-screens";

/**
 * Estoque, Resultado and Histórico put their action on the line of the title (`TitleLine`): at the right of it from
 * 760 px, on the same line; under it and as wide as the screen on a phone, with no sideways scroll even with the
 * letter at 20 px. The title, the (i) of it and the action come in this order in the tab order, there is one `h1`, and
 * the first thing after the heading block is at the same distance from it as on the screens that already followed the
 * pattern. The Resultado draws the period and "Atualizar" only on the Resultado tab; on the Metas tab the same line
 * holds "Atualizar metas" and "Nova meta".
 */
const SAME_LINE = 2;
const PHONE_MARGIN = 48;
const BIG_LETTER = 20;
/** The space between the heading block and what comes after it: the gap of the page grid of a screen (`gap-4`). */
const HEADER_GAP = 16;
/** The gap of a header between its title line and the line of text under it (`gap-1`). */
const INTRO_GAP = 4;
/** The height of the title line from 760 px: one control of the medium size (`min-h-ctl-md`). */
const TITLE_LINE_MIN = 32;
/** `sr-only` leaves the heading 1 px wide and high: more than that is a title that is drawn. */
const SR_ONLY_SIDE = 1;
const PERIOD_BUTTON = /^Período/;
const METAS_TAB = /^Metas/;
const GOALS_REFRESH = /^Atualizar metas/;
const NEW_GOAL = /^Nova meta$/;
const TABS_SAME_PLACE = 1;

const ON_THE_LINE: readonly {
  action: RegExp;
  actionLabel: string;
  hasAbout: boolean;
  heading: string;
  screen: string;
  thenAction?: RegExp;
}[] = [
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
    thenAction: NEW_GOAL,
  },
];

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
      if (line.thenAction) {
        await page.keyboard.press("Tab");
        await expect(
          page.locator(":focus"),
          `a segunda ação "${line.thenAction}"`
        ).toHaveAccessibleName(line.thenAction);
        expect(
          await page.evaluate(
            () =>
              document.activeElement?.closest("[data-title-actions]") !== null
          ),
          "a segunda ação está na linha do título"
        ).toBe(true);
        await page.keyboard.press("Tab");
        const content = page.locator(":focus");
        await expect(
          content,
          "o conteúdo: a aba aberta, Metas"
        ).toHaveAttribute("role", "tab");
        await expect(content).toHaveAccessibleName(METAS_TAB);
        expect(
          await page.evaluate(
            () =>
              document.activeElement?.closest("[data-title-actions]") ?? null
          ),
          "o conteúdo vem depois da linha do título"
        ).toBeNull();
      }
    });
  });
}

const FORM_CLOSERS = [
  { close: "o botão Fechar", name: "Fechar" },
  { close: "o Esc", name: null },
] as const;

for (const closer of FORM_CLOSERS) {
  test.describe(`resultado metas · o foco volta a "Nova meta" ao fechar o formulário com ${closer.close} · ${CONTEXTS[1].name}`, () => {
    test.use({
      hasTouch: CONTEXTS[1].touch,
      isMobile: CONTEXTS[1].touch,
      viewport: CONTEXTS[1].viewport,
    });

    test("o foco não cai no body", async ({ page }) => {
      await screenOf("resultado metas").open(page, page.context());
      const newGoal = page
        .locator("[data-title-actions]")
        .getByRole("button", { name: NEW_GOAL });
      await newGoal.tap();
      const dialog = page.getByRole("dialog", { name: "Nova meta" });
      await expect(dialog).toBeVisible();
      if (closer.name) {
        await dialog.getByRole("button", { name: closer.name }).tap();
      } else {
        await page.keyboard.press("Escape");
      }
      await expect(dialog).toBeHidden();
      await expect(newGoal, "o botão que abriu o formulário").toBeFocused();
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

/**
 * Categorias, Aparelhos, Seus dados, Assinatura and Ajuda have no action, but draw their title in `TitleLine` too: the line
 * is as tall as the one of the screens that have an action, and what follows it is at the distance of its header. A title
 * a tab already names stays for a screen reader only and its line holds no height.
 */
const WITHOUT_ACTION: readonly {
  afterHeader?: number;
  afterTitle: number;
  heading: string;
  hiddenFrom1280: boolean;
  screen: string;
}[] = [
  {
    afterTitle: INTRO_GAP,
    heading: "Categorias",
    hiddenFrom1280: false,
    screen: "categorias lista",
  },
  {
    afterHeader: HEADER_GAP,
    afterTitle: HEADER_GAP,
    heading: "Aparelhos",
    hiddenFrom1280: false,
    screen: "aparelhos lista",
  },
  {
    afterTitle: HEADER_GAP,
    heading: "Seus dados",
    hiddenFrom1280: true,
    screen: "seus dados com cópias",
  },
  {
    afterTitle: HEADER_GAP,
    heading: "Assinatura",
    hiddenFrom1280: true,
    screen: "assinatura oferta com Pix",
  },
  {
    afterHeader: HEADER_GAP,
    afterTitle: INTRO_GAP,
    heading: "Ajuda e contato",
    hiddenFrom1280: false,
    screen: "ajuda",
  },
];

interface LineShape {
  afterHeader: number | null;
  afterLine: number;
  headingBox: Box;
  headingVisible: boolean;
  headings: number;
  line: Box;
  lineDisplay: string;
  scrollWidth: number;
  titleRight: number;
  viewportWidth: number;
}

function lineOf(page: Page, heading: string): Promise<LineShape> {
  return page.evaluate(
    ([headingText, srOnlySide]) => {
      const box = (element: Element): Box => {
        const { bottom, height, left, right, top, width } =
          element.getBoundingClientRect();
        return { bottom, height, left, right, top, width };
      };
      const title = [...document.querySelectorAll<HTMLElement>("h1, h2")].find(
        (candidate) => candidate.textContent?.trim() === headingText
      ) as HTMLElement;
      const line = title.closest("[data-title-line]") as HTMLElement;
      const header = line.parentElement;
      const afterHeader =
        header?.tagName === "HEADER" && header.nextElementSibling
          ? header.nextElementSibling.getBoundingClientRect().top -
            header.getBoundingClientRect().bottom
          : null;
      return {
        afterHeader,
        afterLine:
          (
            (line.nextElementSibling ??
              header?.nextElementSibling) as HTMLElement
          ).getBoundingClientRect().top - line.getBoundingClientRect().bottom,
        headingBox: box(title),
        headingVisible:
          title.getBoundingClientRect().width > srOnlySide &&
          title.getBoundingClientRect().height > srOnlySide,
        headings: [...document.querySelectorAll("h1")].filter((shown) =>
          shown.checkVisibility()
        ).length,
        line: box(line),
        lineDisplay: getComputedStyle(line).display,
        scrollWidth: document.documentElement.scrollWidth,
        titleRight: title.getBoundingClientRect().right,
        viewportWidth: innerWidth,
      };
    },
    [heading, SR_ONLY_SIDE] as const
  );
}

for (const entry of WITHOUT_ACTION) {
  for (const context of CONTEXTS) {
    test.describe(`sem ação · ${entry.screen} · ${context.name}`, () => {
      test.use({
        hasTouch: context.touch,
        isMobile: context.touch,
        viewport: context.viewport,
      });

      test("o título está na linha do título, a uma distância do que vem depois, sem rolagem lateral", async ({
        page,
      }) => {
        await screenOf(entry.screen).open(page, page.context());
        const shape = await lineOf(page, entry.heading);
        expect(shape.headings, "um h1 por página").toBe(1);
        expect(shape.scrollWidth, "rolagem lateral").toBeLessThanOrEqual(
          shape.viewportWidth
        );
        const hidden = entry.hiddenFrom1280 && !context.touch;
        expect(shape.headingVisible, "título à vista").toBe(!hidden);
        if (hidden) {
          expect(
            shape.lineDisplay,
            "a linha não ocupa lugar na grade da página"
          ).toBe("contents");
        } else {
          expect(shape.lineDisplay).not.toBe("contents");
          expect(shape.line.height, "altura da linha do título").toBeCloseTo(
            context.touch ? shape.headingBox.height : TITLE_LINE_MIN,
            0
          );
          expect(shape.afterLine, "depois do título").toBeCloseTo(
            entry.afterTitle,
            0
          );
          if (entry.afterHeader !== undefined) {
            expect(
              shape.afterHeader,
              "do cabeçalho ao primeiro bloco"
            ).toBeCloseTo(entry.afterHeader, 0);
          }
        }
      });
    });
  }

  test.describe(`sem ação · ${entry.screen} · 320 com letra de ${BIG_LETTER} px`, () => {
    test.use({ hasTouch: true, isMobile: true, viewport: VIEWPORTS["320"] });

    test("nada é cortado nem passa da borda", async ({ page }) => {
      await screenOf(entry.screen).open(page, page.context());
      await page.evaluate((pixels) => {
        document.documentElement.style.fontSize = `${pixels}px`;
      }, BIG_LETTER);
      const shape = await lineOf(page, entry.heading);
      expect(shape.scrollWidth).toBeLessThanOrEqual(shape.viewportWidth);
      expect(shape.titleRight).toBeLessThanOrEqual(shape.viewportWidth);
      expect(shape.headingBox.left).toBeGreaterThanOrEqual(0);
    });
  });
}
