/// <reference lib="dom" />

import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

/**
 * The sweep every reflow test uses: a screen read at 320 px of window with the browser font at 20 px, and proof that
 * nothing is cut, ellipsized or pushed sideways.
 *
 * ```ts
 * skipOutsideChromium();                      // once, at the top level of the spec
 * await openReflowViewport(page);             // BEFORE page.goto: 320 px wide, browser font 20 px
 * await page.goto("/stock");
 * await expectReflowFont(page);               // the font really is 20 px (a test that reads 16 px proves nothing)
 * const root = page.locator("main");
 * await assertNothingClipped(root, { allowScroll: ['[role="tablist"]'] });
 * await assertNoEllipsis(root.locator("[data-stock-action]"));
 * await assertNoPageScroll(page);
 * ```
 *
 * The font is `Page.setFontSizes` (what the user changes in the browser settings), not `font-size` on `<html>`: only
 * the former moves the `rem` of a media query, which is what makes the shell change layout (`breakpoints-rem.e2e.ts`).
 * It is a Chrome DevTools command, so every spec that uses this file skips the other browsers.
 *
 * What each check calls a defect:
 * - `assertNothingClipped`: an element that holds text of its own and has `scrollWidth` above `clientWidth` by more
 *   than 1 px. `allowScroll` lists the selectors of elements that scroll on purpose (a data table, the tab strip):
 *   those elements themselves are not measured, what is inside them still is.
 * - `assertNoEllipsis`: an element (or a descendant) whose `text-overflow: ellipsis` is hiding text (the text is wider
 *   than the box), or whose `line-clamp` hides lines. An ellipsis that has nothing to hide is not a defect.
 * - `assertNoPageScroll`: the page scrolls on the horizontal by even 1 px.
 */
const REFLOW_WIDTH = 320;
const REFLOW_HEIGHT = 740;
const REFLOW_FONT_PIXELS = 20;

const SLACK_PIXELS = 1;
const REPORTED = 8;

/** Call once at the top level of the spec: `Page.setFontSizes` exists only in Chromium. */
export function skipOutsideChromium() {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "`Page.setFontSizes` is a Chrome DevTools command"
  );
}

/** Sets the window and the browser font; must run before the page loads, because `rem` is read at layout. */
export async function openReflowViewport(
  page: Page,
  {
    fontPixels = REFLOW_FONT_PIXELS,
    height = REFLOW_HEIGHT,
    width = REFLOW_WIDTH,
  }: { fontPixels?: number; height?: number; width?: number } = {}
) {
  await page.setViewportSize({ height, width });
  const session = await page.context().newCDPSession(page);
  await session.send("Page.setFontSizes", {
    fontSizes: { fixed: fontPixels, standard: fontPixels },
  });
}

/** The font the page computed for `<html>`: the proof that the sweep ran at the size it says. */
export async function expectReflowFont(
  page: Page,
  fontPixels = REFLOW_FONT_PIXELS
) {
  expect(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).fontSize
    )
  ).toBe(`${fontPixels}px`);
}

interface ClippedOptions {
  /** Selectors of elements that scroll on purpose: they are not measured themselves. */
  allowScroll?: readonly string[];
}

interface Offender {
  clientWidth: number;
  scrollWidth: number;
  tag: string;
  text: string;
}

const describeOffenders = (offenders: readonly Offender[]) =>
  offenders
    .slice(0, REPORTED)
    .map(
      ({ clientWidth, scrollWidth, tag, text }) =>
        `${tag} "${text}": ${scrollWidth} px of content in ${clientWidth} px`
    );

/** Nothing under `root` that holds text has more content than box, apart from what scrolls on purpose. */
export async function assertNothingClipped(
  root: Locator,
  { allowScroll = [] }: ClippedOptions = {}
) {
  await expect(root, "the root of the sweep is not on the page").toHaveCount(1);
  const { measured, offenders } = await root.evaluate(
    (element, { allowed, slack }) => {
      const holdsText = (item: Element) =>
        [...item.childNodes].some(
          (node) =>
            node.nodeType === Node.TEXT_NODE &&
            (node.textContent ?? "").trim() !== ""
        );
      const found: Offender[] = [];
      let count = 0;
      for (const item of [element, ...element.querySelectorAll("*")]) {
        if (
          !holdsText(item) ||
          item.clientWidth === 0 ||
          allowed.some((selector) => item.matches(selector))
        ) {
          continue;
        }
        count += 1;
        if (item.scrollWidth > item.clientWidth + slack) {
          found.push({
            clientWidth: item.clientWidth,
            scrollWidth: item.scrollWidth,
            tag: item.tagName.toLowerCase(),
            text: (item.textContent ?? "").trim().slice(0, 40),
          });
        }
      }
      return { measured: count, offenders: found };
    },
    { allowed: [...allowScroll], slack: SLACK_PIXELS }
  );
  // a sweep that measured nothing proves nothing
  expect(measured, "no element with text was measured").toBeGreaterThan(0);
  expect(describeOffenders(offenders)).toEqual([]);
}

/** None of the elements of `data` (or inside them) has an ellipsis or a line clamp hiding text. */
export async function assertNoEllipsis(data: Locator) {
  const count = await data.count();
  expect(count, "the locator of the data found no element").toBeGreaterThan(0);
  const offenders = (await data.evaluateAll((elements, slack) => {
    const found: Offender[] = [];
    for (const root of elements) {
      for (const item of [root, ...root.querySelectorAll("*")]) {
        const style = getComputedStyle(item);
        const ellipsis =
          style.textOverflow === "ellipsis" &&
          item.scrollWidth > item.clientWidth + slack;
        const clamped =
          style.webkitLineClamp !== "none" &&
          item.scrollHeight > item.clientHeight + slack;
        if (ellipsis || clamped) {
          found.push({
            clientWidth: item.clientWidth,
            scrollWidth: item.scrollWidth,
            tag: item.tagName.toLowerCase(),
            text: (item.textContent ?? "").trim().slice(0, 40),
          });
        }
      }
    }
    return found;
  }, SLACK_PIXELS)) satisfies Offender[];
  expect(describeOffenders(offenders)).toEqual([]);
}

/** The page does not scroll on the horizontal, not even by 1 px. */
export async function assertNoPageScroll(page: Page) {
  const scroll = await page.evaluate(() => {
    const scroller = document.scrollingElement ?? document.documentElement;
    return {
      client: scroller.clientWidth,
      scroll: scroller.scrollWidth,
    };
  });
  expect(
    scroll.scroll,
    `the page is ${scroll.scroll} px wide in a window of ${scroll.client} px`
  ).toBeLessThanOrEqual(scroll.client);
}
