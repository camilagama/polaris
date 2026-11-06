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

/** What the sale shows at the narrowest windows: the page must not scroll sideways. */
function saleSideScroll(page: Page) {
  return page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth
  );
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

for (const pixels of [REM, 20]) {
  test.describe(`a Venda a 320 px, fonte padrão ${pixels} px`, () => {
    test("não rola de lado", async ({ page }) => {
      await openSale(page, 320, pixels);
      expect(await saleSideScroll(page)).toBe(false);
    });
  });
}

/**
 * What the page reserves under a focused control of the sale against what the sticky total bar covers: the
 * `scroll-padding` of the document plus the `scroll-margin` of the control, which is where the sale's own container
 * (in one column) puts its part.
 */
function submitBarReserve(page: Page) {
  return page.evaluate(() => {
    const bar = document.querySelector("[data-submit-bar]");
    const control = document.querySelector("[data-sale-form] button");
    const px = (value: string | undefined) => {
      const parsed = Number.parseFloat(value ?? "");
      return Number.isNaN(parsed) ? 0 : parsed;
    };
    return {
      barHeight: bar?.getBoundingClientRect().height ?? 0,
      barShown: bar ? getComputedStyle(bar).display !== "none" : false,
      padding:
        px(getComputedStyle(document.documentElement).scrollPaddingBottom) +
        px(control ? getComputedStyle(control).scrollMarginBottom : undefined),
    };
  });
}

for (const [width, pixels] of [
  [360, REM],
  [320, REM],
  [360, 20],
  [320, 20],
] as const) {
  test.describe(`a Venda a ${width} px, fonte padrão ${pixels} px`, () => {
    test("a reserva de rolagem de baixo cobre a barra de total e a barra inferior", async ({
      page,
    }) => {
      await openSale(page, width, pixels);
      const reserve = await submitBarReserve(page);
      const bottomBar = await page.evaluate(
        () =>
          document.querySelector("[data-bottom-bar]")?.getBoundingClientRect()
            .height ?? 0
      );
      expect(reserve.barShown).toBe(true);
      expect(reserve.barHeight).toBeGreaterThan(0);
      expect(bottomBar).toBeGreaterThan(0);
      expect(reserve.padding).toBeGreaterThanOrEqual(
        reserve.barHeight + bottomBar
      );
    });
  });
}

test.describe("a Venda a 1280 px: a reserva de rolagem da barra de total não se aplica", () => {
  test("a reserva de rolagem de baixo fica em 0 e a barra de total não aparece", async ({
    page,
  }) => {
    await openSale(page, 1280, REM);
    const reserve = await submitBarReserve(page);
    expect(reserve.barShown).toBe(false);
    expect(reserve.padding).toBe(0);
  });
});
