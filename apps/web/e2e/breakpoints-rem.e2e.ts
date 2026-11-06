/// <reference lib="dom" />

import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { serve } from "./shell-server";

/**
 * The lines where the shell changes layout are in `rem` in the CSS and in the JavaScript (`src/lib/breakpoints.ts`).
 * `rem` in a media query is the default font size of the browser, not the `font-size` of `<html>`, so these tests set
 * the former (`Page.setFontSizes`) and look at one viewport on both sides of each line: the bottom bar, the height of
 * the header and the touch tokens are CSS; the desktop column and the button that folds it exist only when
 * `useIsMobile` and `useMediaQuery` say so.
 */

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "`Page.setFontSizes` is a Chrome DevTools command"
);
test.skip(
  ({ isMobile }) => isMobile,
  "a coarse pointer is `touch` at any width: the lines are measured with a mouse"
);

const REM = 16;
const PHONE_REM = 47.5;
const COLLAPSIBLE_REM = 64;
const SALE_REM = 56.25;

async function setBrowserFont(page: Page, pixels: number) {
  const session = await page.context().newCDPSession(page);
  await session.send("Page.setFontSizes", {
    fontSizes: { fixed: pixels, standard: pixels },
  });
}

async function open(page: Page, width: number, pixels: number) {
  await page.setViewportSize({ height: 800, width });
  await setBrowserFont(page, pixels);
  await serve(page);
  await page.goto("/products");
  await expect(page.locator("main h1")).toBeVisible();
  await expect(page.locator(".sync-status")).toBeVisible({ timeout: 20_000 });
  expect(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).fontSize
    )
  ).toBe(`${pixels}px`);
}

/** What the CSS says (bottom bar, header, touch token) and what the JavaScript says (column, fold button). */
function layout(page: Page) {
  return page.evaluate(() => {
    const bar = document.querySelector("[data-bottom-bar]");
    const header = document.querySelector("[data-app-header]");
    return {
      cssBottomBar: bar ? getComputedStyle(bar).display !== "none" : false,
      cssHeaderRem:
        (header?.getBoundingClientRect().height ?? 0) /
        Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
      cssTouchToken: getComputedStyle(document.documentElement)
        .getPropertyValue("--h-md")
        .trim(),
      jsColumn:
        document.querySelector('[data-slot="sidebar-container"]') !== null,
      jsFold: document.querySelector('[data-slot="sidebar-trigger"]') !== null,
    };
  });
}

const edges = (rem: number, pixels: number) => ({
  above: Math.round(rem * pixels) + 10,
  below: Math.round(rem * pixels) - 10,
});

for (const pixels of [REM, 20]) {
  const label = pixels === REM ? "fonte padrão 16 px" : "fonte padrão 20 px";
  test.describe(`pontos de quebra em rem, ${label}`, () => {
    test(`a ${Math.round(PHONE_REM * pixels)} px o celular vira computador no CSS e no JavaScript ao mesmo tempo`, async ({
      page,
    }) => {
      const { below, above } = edges(PHONE_REM, pixels);
      await open(page, below, pixels);
      expect(await layout(page)).toEqual({
        cssBottomBar: true,
        cssHeaderRem: 3,
        cssTouchToken: "2.25rem",
        jsColumn: false,
        jsFold: false,
      });
      await page.setViewportSize({ height: 800, width: above });
      await expect.poll(async () => (await layout(page)).jsColumn).toBe(true);
      expect(await layout(page)).toMatchObject({
        cssBottomBar: false,
        cssHeaderRem: 3.5,
        cssTouchToken: "2rem",
        jsColumn: true,
      });
    });

    test(`a ${Math.round(COLLAPSIBLE_REM * pixels)} px a lateral passa a poder recolher`, async ({
      page,
    }) => {
      const { below, above } = edges(COLLAPSIBLE_REM, pixels);
      await open(page, below, pixels);
      expect(await layout(page)).toMatchObject({
        jsColumn: true,
        jsFold: false,
      });
      await page.setViewportSize({ height: 800, width: above });
      await expect.poll(async () => (await layout(page)).jsFold).toBe(true);
    });
  });
}

test.describe("fonte padrão 20 px: a 760 px de largura o app está no layout estreito nos dois", () => {
  test("com 20 px, 760 px ainda é celular no CSS e no JavaScript", async ({
    page,
  }) => {
    await open(page, 760, 20);
    expect(await layout(page)).toMatchObject({
      cssBottomBar: true,
      cssHeaderRem: 3,
      jsColumn: false,
    });
  });
});

/** The places that must not scroll sideways: the page, the header and the column or the sheet of "Mais". */
function sideScroll(page: Page) {
  return page.evaluate(() => {
    const found: string[] = [];
    for (const [selector, name] of [
      ["html", "documento"],
      ["[data-app-header] > div", "cabeçalho"],
      ['[data-slot="sidebar-inner"]', "lateral"],
      ["dialog[data-mobile] > div", "Mais"],
    ] as const) {
      const element = document.querySelector(selector);
      if (
        element &&
        element.getClientRects().length > 0 &&
        element.scrollWidth > element.clientWidth
      ) {
        found.push(`${name}: ${element.scrollWidth} > ${element.clientWidth}`);
      }
    }
    return found;
  });
}

test.describe("fonte padrão 20 px: nada rola de lado a 320 px", () => {
  test("a página, o cabeçalho e a folha de Mais", async ({ page }) => {
    await open(page, 320, 20);
    expect(await sideScroll(page)).toEqual([]);
    await page.getByRole("button", { exact: true, name: "Mais" }).click();
    await expect(page.locator("dialog[data-mobile]")).toBeVisible();
    expect(await sideScroll(page)).toEqual([]);
  });
});

/** The two-column sale form, the bar with the total at the bottom (below the line) and the confirm button of the summary. */
function saleLayout(page: Page) {
  return page.evaluate(() => {
    const form = document.querySelector("[data-sale-form]");
    const bar = document.querySelector("[data-submit-bar]");
    const aside = form?.querySelector("aside");
    const confirm = aside?.querySelector('button[type="submit"]');
    const shown = (element: Element | null | undefined) =>
      element ? getComputedStyle(element).display !== "none" : false;
    return {
      barShown: shown(bar),
      columns: form
        ? getComputedStyle(form).gridTemplateColumns.split(" ").length
        : 0,
      confirmShown: shown(confirm),
      display: form ? getComputedStyle(form).display : "",
      sideScroll:
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
      summarySticky: aside ? getComputedStyle(aside).position : "",
    };
  });
}

async function openSale(page: Page, width: number, pixels: number) {
  await page.setViewportSize({ height: 800, width });
  await setBrowserFont(page, pixels);
  await serve(page);
  await page.goto("/sales");
  await expect(page.locator("[data-sale-form]")).toBeVisible({
    timeout: 20_000,
  });
}

const ONE_COLUMN = {
  barShown: true,
  columns: 1,
  confirmShown: false,
  display: "flex",
  summarySticky: "static",
};
const TWO_COLUMNS = {
  barShown: false,
  columns: 2,
  confirmShown: true,
  display: "grid",
  summarySticky: "sticky",
};

for (const pixels of [REM, 20]) {
  test.describe(`a Venda em rem, fonte padrão ${pixels} px`, () => {
    test(`a ${SALE_REM * pixels - 1} px é uma coluna e a ${SALE_REM * pixels} px são duas, com a barra de total e o botão do resumo na mesma linha`, async ({
      page,
    }) => {
      const line = SALE_REM * pixels;
      await openSale(page, line - 1, pixels);
      expect(await saleLayout(page)).toMatchObject(ONE_COLUMN);
      await page.setViewportSize({ height: 800, width: line });
      await expect
        .poll(async () => (await saleLayout(page)).columns)
        .toBe(TWO_COLUMNS.columns);
      expect(await saleLayout(page)).toMatchObject(TWO_COLUMNS);
    });
  });
}

test.describe("fonte padrão 20 px: a Venda não vai a duas colunas a 950 px", () => {
  test("a 950 px continua em uma coluna, com a barra de total", async ({
    page,
  }) => {
    await openSale(page, 950, 20);
    expect(await saleLayout(page)).toMatchObject(ONE_COLUMN);
  });
});

for (const pixels of [REM, 20]) {
  test.describe(`a Venda a 320 px, fonte padrão ${pixels} px`, () => {
    test("não rola de lado", async ({ page }) => {
      await openSale(page, 320, pixels);
      expect(await saleLayout(page)).toMatchObject({
        ...ONE_COLUMN,
        sideScroll: false,
      });
    });
  });
}
