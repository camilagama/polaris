/// <reference lib="dom" />
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  assertNoPageScroll,
  expectReflowFont,
  openReflowViewport,
  reflowTest,
  skipOutsideChromium,
} from "../e2e/reflow";
import { expectScreenTabsKeyboard } from "../e2e/tabs-keyboard";
import { SCREENS, VIEWPORTS } from "./ui-screens";

/**
 * A tab of a screen is drawn by one piece (`ScreenTabList` and `ScreenTabTrigger`), and the state filter of a list by
 * another (`SegmentedFilter`): the strip, the tab and the open tab read the same height, font and colors on Despesas,
 * Resultado, Configurações, the dialog of the product and the preview of the import; the arrows, Home, End and Enter do
 * the same on all of them; and at 320 px with the browser font at 20 px no tab is cut (the strip scrolls inside its box).
 */
skipOutsideChromium();

test.beforeEach(({ browserName }, testInfo) => {
  test.skip(
    browserName !== "chromium" || testInfo.project.name !== "chromium-desktop",
    "each test sets its own viewport"
  );
});

interface TabCase {
  list: string;
  name: string;
  screen: string;
}

const TABS: readonly TabCase[] = [
  {
    list: "Lançamentos, recorrentes e categorias",
    name: "Despesas",
    screen: "despesas lista",
  },
  {
    list: "Resultado e metas",
    name: "Resultado",
    screen: "resultado mês incompleto e gráfico de vendas",
  },
  {
    list: "Partes do produto",
    name: "diálogo do produto",
    screen: "produtos edição com erro no nome",
  },
  {
    list: "Linhas do arquivo",
    name: "prévia da importação",
    screen: "importar planilha prévia com erro, já existe e sem categoria",
  },
];

const SETTINGS: TabCase = {
  list: "Configurações",
  name: "Configurações",
  screen: "assinatura oferta com Pix",
};

const FILTERS: readonly TabCase[] = [
  {
    list: "Estado dos produtos",
    name: "filtro de Produtos",
    screen: "produtos lista",
  },
  {
    list: "Estado dos clientes",
    name: "filtro de Clientes",
    screen: "clientes lista",
  },
  {
    list: "Estado das categorias",
    name: "filtro de Categorias",
    screen: "categorias lista",
  },
];

const openScreen = async (page: Page, name: string) => {
  const screen = SCREENS.find((candidate) => candidate.name === name);
  expect(screen, `a tela "${name}" não está em SCREENS`).toBeDefined();
  await screen?.open(page, page.context());
};

interface TabLook {
  active: Record<string, string>;
  height: number;
  inactive: Record<string, string>;
  list: Record<string, string>;
  tab: Record<string, string>;
}

/** The strip is the parent of the tab: the tablist itself, or the row of its group in Configurações (the list there is only the column of rows). */
const LIST_PROPERTIES = ["backgroundColor", "borderRadius", "paddingTop"];
const TAB_PROPERTIES = [
  "borderRadius",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "paddingLeft",
  "paddingRight",
];
const ACTIVE_PROPERTIES = ["backgroundColor", "boxShadow", "color"];

function lookOf(list: Locator): Promise<TabLook> {
  return list.evaluate(
    (element, [listProps, tabProps, activeProps]) => {
      const pick = (target: Element, names: string[]) => {
        const style = getComputedStyle(target);
        return Object.fromEntries(
          names.map((name) => [
            name,
            String(style[name as keyof CSSStyleDeclaration]),
          ])
        );
      };
      const tabs = [...element.querySelectorAll('[role="tab"]')];
      const active = tabs.find(
        (tab) => tab.getAttribute("aria-selected") === "true"
      ) as Element;
      const inactive = tabs.find(
        (tab) => tab.getAttribute("aria-selected") === "false"
      ) as Element;
      return {
        active: pick(active, activeProps as string[]),
        height: Math.round(active.getBoundingClientRect().height * 100) / 100,
        inactive: { color: String(getComputedStyle(inactive).color) },
        list: pick(active.parentElement as Element, listProps as string[]),
        tab: pick(active, tabProps as string[]),
      };
    },
    [LIST_PROPERTIES, TAB_PROPERTIES, ACTIVE_PROPERTIES]
  );
}

async function lookAt(page: Page, { list, screen }: TabCase) {
  await openScreen(page, screen);
  const tablist = page.getByRole("tablist", { name: list });
  await expect(tablist).toBeVisible();
  return lookOf(tablist);
}

test.describe("o mesmo desenho a 1280 px com mouse", () => {
  test.use({ hasTouch: false, viewport: VIEWPORTS["1280"] });

  for (const item of [...TABS.slice(1), SETTINGS]) {
    test(`a aba de ${item.name} lê o mesmo que a de Despesas: altura, fonte, estado ativo e faixa`, async ({
      page,
    }) => {
      const reference = await lookAt(page, TABS[0] as TabCase);
      expect(
        reference.height,
        "a aba tem a altura do controle"
      ).toBeGreaterThan(20);
      expect(await lookAt(page, item)).toEqual(reference);
    });
  }

  for (const item of FILTERS.slice(1)) {
    test(`o filtro de estado de ${item.name} lê o mesmo que o de Produtos`, async ({
      page,
    }) => {
      const reference = await lookAt(page, FILTERS[0] as TabCase);
      expect(await lookAt(page, item)).toEqual(reference);
    });
  }

  test("a aba de tela e o filtro de lista têm a mesma altura, fonte e faixa", async ({
    page,
  }) => {
    const tab = await lookAt(page, TABS[0] as TabCase);
    const filter = await lookAt(page, FILTERS[0] as TabCase);
    expect(filter.height).toBe(tab.height);
    expect(filter.list).toEqual(tab.list);
    expect(filter.active).toEqual(tab.active);
    expect(filter.tab.fontSize).toBe(tab.tab.fontSize);
    expect(filter.tab.fontWeight).toBe(tab.tab.fontWeight);
    expect(filter.tab.fontFamily).toBe(tab.tab.fontFamily);
  });

  for (const item of [...TABS, SETTINGS]) {
    test(`teclado em ${item.name}: setas movem o foco, Home e End vão às pontas, Enter e Espaço abrem`, async ({
      page,
    }) => {
      await openScreen(page, item.screen);
      const tablist = page.getByRole("tablist", { name: item.list });
      await expect(tablist).toBeVisible();
      const names = await tablist.getByRole("tab").allInnerTexts();
      await tablist.getByRole("tab").first().click();
      await expectScreenTabsKeyboard(
        page,
        item.list,
        names.map((text) => text.replace(/\s+/g, " ").trim())
      );
    });
  }
});

for (const item of TABS) {
  test.describe(`${item.name} a 320 px com a letra do navegador em 20 px`, () => {
    reflowTest(`nenhuma aba de ${item.name} é cortada`, async ({ page }) => {
      await openReflowViewport(page);
      await openScreen(page, item.screen);
      await expectReflowFont(page);
      const tablist = page.getByRole("tablist", { name: item.list });
      await expect(tablist).toBeVisible();
      const cut = await tablist
        .getByRole("tab")
        .evaluateAll((tabs) =>
          tabs
            .filter((tab) => tab.scrollWidth > tab.clientWidth + 1)
            .map((tab) => tab.textContent)
        );
      expect(cut, "abas com o texto cortado").toEqual([]);
      await assertNoPageScroll(page);
    });
  });
}
