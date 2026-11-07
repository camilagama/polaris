/// <reference lib="dom" />

import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

/**
 * The sweep every reflow test uses: a screen read at 320 px of window with the browser font at 20 px, and proof that
 * nothing is cut sideways, ellipsized or pushed out of the window.
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
 * - `assertNothingClipped`: an element that holds text of its own, or that hides what overflows it (`overflow-x` other than
 *   `visible`) and has text inside, and has `scrollWidth` above `clientWidth` by more than 1 px. `allowScroll` lists the selectors of elements that scroll on purpose (a data table, the tab strip):
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

/** An element that holds text and has more content than box, with where it is in the page. */
export interface ClippedElement extends Offender {
  selector: string;
}

/**
 * Every element under `root` that `assertNothingClipped` calls a defect, each with a `selector` that names it by its
 * tag and the attributes that survive a change of style (`id`, `data-slot`, `role`), from the nearest ancestor that has
 * one of them. `measured` is how many elements with text were looked at.
 */
export async function findClipped(
  root: Locator,
  { allowScroll = [] }: ClippedOptions = {}
): Promise<{ measured: number; offenders: ClippedElement[] }> {
  await expect(root, "the root of the sweep is not on the page").toHaveCount(1);
  return await root.evaluate(
    (element, { allowed, slack }) => {
      const hiddenOnPurpose = (item: Element) => {
        const style = getComputedStyle(item);
        return style.clipPath !== "none" || style.clip !== "auto";
      };
      const mayCut = (item: Element) =>
        (item.textContent ?? "").trim() !== "" &&
        !hiddenOnPurpose(item) &&
        (holdsText(item) || getComputedStyle(item).overflowX !== "visible");
      const holdsText = (item: Element) =>
        [...item.childNodes].some(
          (node) =>
            node.nodeType === Node.TEXT_NODE &&
            (node.textContent ?? "").trim() !== ""
        );
      const label = (item: Element) => {
        const tag = item.tagName.toLowerCase();
        // the ids React and Base UI make (`_r_5_`, `base-ui-_r_5_`) change from one run to the next
        const named =
          item.id !== "" &&
          !item.id.startsWith("_r_") &&
          !item.id.startsWith("base-ui-");
        if (named) {
          return `${tag}#${item.id}`;
        }
        const slot = item.getAttribute("data-slot");
        if (slot !== null) {
          return `${tag}[data-slot="${slot}"]`;
        }
        const role = item.getAttribute("role");
        return role === null ? tag : `${tag}[role="${role}"]`;
      };
      const selectorOf = (item: Element) => {
        const names: string[] = [];
        let current: Element | null = item;
        while (current !== null && current !== element.parentElement) {
          names.unshift(label(current));
          const outer = names[0] ?? "";
          if (
            names.length > 1 &&
            (outer.includes("#") || outer.includes("["))
          ) {
            break;
          }
          current = current.parentElement;
        }
        return names.join(" > ");
      };
      const found: ClippedElement[] = [];
      let count = 0;
      for (const item of [element, ...element.querySelectorAll("*")]) {
        if (
          !mayCut(item) ||
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
            selector: selectorOf(item),
            tag: item.tagName.toLowerCase(),
            text: (item.textContent ?? "").trim().slice(0, 40),
          });
        }
      }
      return { measured: count, offenders: found };
    },
    { allowed: [...allowScroll], slack: SLACK_PIXELS }
  );
}

/** Nothing under `root` that holds text has more content than box, apart from what scrolls on purpose. */
export async function assertNothingClipped(
  root: Locator,
  options: ClippedOptions = {}
) {
  const { measured, offenders } = await findClipped(root, options);
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

/**
 * Every amount ("R$ 1.757,10", with its sign) written as one text ("R$" and the number in the same text node; a `Money`
 * box, which sets them in two elements, is not measured here) under `scope` has its "R$" and its number on the same line:
 * the two boxes overlap vertically, so a line break between them fails. Returns how many amounts it measured, and the
 * check fails when there is none, because a sweep that found no amount proves nothing.
 */
export async function assertAmountsOnOneLine(scope: Locator) {
  const amounts = await scope.evaluateAll((roots) => {
    const AMOUNT = /[-+−]?R\$ [\d.]+,\d{2}/g;
    const found: Array<{
      currency: { bottom: number; top: number };
      number: { bottom: number; top: number };
      text: string;
    }> = [];
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const content = node.textContent ?? "";
        for (const match of content.matchAll(AMOUNT)) {
          const start = match.index ?? 0;
          const range = document.createRange();
          const sign = match[0].startsWith("R") ? 0 : 1;
          range.setStart(node, start + sign);
          range.setEnd(node, start + sign + 2);
          const currency = range.getBoundingClientRect();
          range.setStart(node, start + sign + 3);
          range.setEnd(node, start + match[0].length);
          const number = range.getBoundingClientRect();
          found.push({
            currency: { bottom: currency.bottom, top: currency.top },
            number: { bottom: number.bottom, top: number.top },
            text: match[0],
          });
        }
      }
    }
    return found;
  });
  expect(amounts.length, "no amount was found to measure").toBeGreaterThan(0);
  const apart = amounts
    .filter(
      ({ currency, number }) =>
        number.top >= currency.bottom - SLACK_PIXELS ||
        currency.top >= number.bottom - SLACK_PIXELS
    )
    .map(({ text }) => text);
  expect(apart, "amounts with the R$ and the number on two lines").toEqual([]);
  return amounts.length;
}

/**
 * The text of each element under `scope` matched by `selector` (all of what it paints, even what overflows its box)
 * does not touch the text of another: a value that overflows its cell and lands on the neighbour fails. Returns how many
 * it measured and fails below `atLeast`, because a sweep that measured nothing proves nothing.
 */
export async function assertTextsApart(
  scope: Locator,
  selector: string,
  atLeast: number
) {
  const boxes = await scope.locator(selector).evaluateAll((elements) =>
    elements.map((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const { bottom, left, right, top } = range.getBoundingClientRect();
      return { bottom, left, right, text: element.textContent ?? "", top };
    })
  );
  expect(
    boxes.length,
    "fewer boxes than expected to compare"
  ).toBeGreaterThanOrEqual(atLeast);
  const touching: string[] = [];
  for (const [index, first] of boxes.entries()) {
    for (const second of boxes.slice(index + 1)) {
      const sideways =
        first.left < second.right - SLACK_PIXELS &&
        second.left < first.right - SLACK_PIXELS;
      const vertical =
        first.top < second.bottom - SLACK_PIXELS &&
        second.top < first.bottom - SLACK_PIXELS;
      if (sideways && vertical) {
        touching.push(`${first.text} | ${second.text}`);
      }
    }
  }
  expect(touching, "texts that overlap each other").toEqual([]);
  return boxes.length;
}
