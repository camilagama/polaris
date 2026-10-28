/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { COLOR_SCHEME, SCREENS, VIEWPORTS } from "./ui-screens";

/**
 * The item of the side menu: the current one is a gray step above the column (`--sidebar-accent`), the one under the
 * pointer is a step below it (`--sidebar-hover`), and "where you are" is still told by the `aria-current`, the weight
 * and the emerald dot, never by the fill. The colors are read computed, from the browser, and compared with the token
 * painted on a probe, so the test follows theme.css instead of repeating its numbers.
 */
const home = SCREENS.find((screen) => screen.name === "início com vendas");
if (!home) {
  throw new Error("ui-screens.ts must list the Início with sales");
}

const CURRENT = '[data-slot="sidebar-menu-button"][aria-current="page"]';
const OTHER = '[data-slot="sidebar-menu-button"]:not([aria-current])';

/** What the browser computes for `background-color: var(--token)`, in the same notation it uses for the items. */
const paintOf = (page: Page, token: string) =>
  page.evaluate((name) => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = `var(${name})`;
    document.body.append(probe);
    const { backgroundColor } = getComputedStyle(probe);
    probe.remove();
    return backgroundColor;
  }, token);

const fillOf = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((node) => getComputedStyle(node).backgroundColor);

for (const theme of ["claro", "escuro"] as const) {
  test(`o item atual e o item em hover do menu têm cada um o seu cinza · tema ${theme}`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      colorScheme: COLOR_SCHEME[theme],
      reducedMotion: "reduce",
      viewport: VIEWPORTS["1280"],
    });
    const page = await context.newPage();
    await home.open(page, context);

    const current = page.locator(CURRENT).first();
    await expect(current).toBeVisible();
    await expect(page.locator(CURRENT)).toHaveCount(1);
    await expect(current).toHaveAttribute("data-active", "");
    await expect(current).toHaveCSS("font-weight", "500");

    const accent = await paintOf(page, "--sidebar-accent");
    const hover = await paintOf(page, "--sidebar-hover");
    const column = await paintOf(page, "--sidebar");
    expect(accent).not.toBe(hover);
    expect(hover).not.toBe(column);
    expect(await fillOf(page, CURRENT)).toBe(accent);

    const other = page.locator(OTHER).first();
    await expect(other).toBeVisible();
    expect(await fillOf(page, OTHER)).not.toBe(accent);
    await other.hover();
    await expect.poll(() => fillOf(page, OTHER)).toBe(hover);
    // the current item keeps its own fill while the pointer is on another one
    expect(await fillOf(page, CURRENT)).toBe(accent);
    await context.close();
  });
}
