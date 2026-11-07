/// <reference lib="dom" />

import { basename } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { KNOWN_COARSE_FINDINGS, type KnownCoarseFinding } from "./reflow-known";

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
 * The pointer: a spec declares each case with `reflowTest` instead of `test`, and the case runs twice, with a mouse
 * (`fine`, the project's own pointer) and with a finger (`coarse`: `hasTouch` and `isMobile` on the desktop project, the
 * same two options `reflow-rotas.e2e.ts` uses). A phone has both the `touch` variant by width and a `(pointer: coarse)`
 * query of its own, and the fields and targets change size with them. What cuts with `coarse` and not with `fine` goes
 * in `KNOWN_COARSE_FINDINGS` (screen, selector, measure, reason); `assertNothingClipped` and `assertNoPageScroll` fail
 * only for a finding that is not in it, and only when the page really has a coarse pointer. The Pixel 5 project is a
 * coarse pointer already, so there the `fine` cases measure a finger too and the `coarse` ones are skipped.
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

export type ReflowPointer = "fine" | "coarse";

const COARSE_QUERY = "(pointer: coarse)";
const DESKTOP_PROJECT = "chromium-desktop";

const readCoarse = (page: Page) =>
  page.evaluate((query) => matchMedia(query).matches, COARSE_QUERY);

async function expectPointer(page: Page, pointer: ReflowPointer) {
  expect(
    await readCoarse(page),
    `the case asks for a ${pointer} pointer and the browser reports the other`
  ).toBe(pointer === "coarse");
}

/**
 * One reflow case, run with a mouse and with a finger. The mouse case is the plain `test` it always was (same title,
 * same project); the finger case sits in a group "com toque" with `hasTouch` and `isMobile`, only in the desktop project
 * (the Pixel 5 project is a finger already), and proves the browser reports `(pointer: coarse)` before the body runs.
 * The body gets `pointer` to tell the two apart. `coarse: false` leaves the finger case out, and each use of it has its
 * reason in `verify-reflow-pointers.test.ts` (a window of 1280 px is not a phone; the font of 24 px is a best effort, not a promise).
 */
export function reflowTest(
  title: string,
  body: (args: { page: Page; pointer: ReflowPointer }) => Promise<void>,
  { coarse = true }: { coarse?: boolean } = {}
) {
  test(title, ({ page }) => body({ page, pointer: "fine" }));
  if (!coarse) {
    return;
  }
  test.describe("com toque", () => {
    test.use({ hasTouch: true, isMobile: true });
    test(title, async ({ page }, testInfo) => {
      test.skip(
        testInfo.project.name !== DESKTOP_PROJECT,
        "the Pixel 5 project is a finger already: its cases above measure it"
      );
      await expectPointer(page, "coarse");
      await body({ page, pointer: "coarse" });
    });
  });
}

interface Finding {
  clientWidth: number;
  scrollWidth: number;
  selector: string;
}

async function stillUnknown<T extends Finding>(
  page: Page,
  found: readonly T[],
  known: readonly KnownCoarseFinding[]
): Promise<T[]> {
  if (!(await readCoarse(page))) {
    return [...found];
  }
  const { title, titlePath } = test.info();
  const spec = basename(titlePath[0] ?? "");
  return found.filter(
    (item) =>
      !known.some(
        (line) =>
          line.spec === spec &&
          line.cases.includes(title) &&
          line.selector === item.selector &&
          line.clientWidth === item.clientWidth &&
          line.scrollWidth === item.scrollWidth
      )
  );
}

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
    pointer,
    width = REFLOW_WIDTH,
  }: {
    fontPixels?: number;
    height?: number;
    /** When given, the browser has to report that pointer: a case that says `coarse` with a mouse proves nothing. */
    pointer?: ReflowPointer;
    width?: number;
  } = {}
) {
  await page.setViewportSize({ height, width });
  if (pointer !== undefined) {
    await expectPointer(page, pointer);
  }
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
  /** Selector of the subtrees below the root that are left out (they are measured as roots of their own). */
  skip?: string | undefined;
  /** The list of cuts excused with a coarse pointer; `KNOWN_COARSE_FINDINGS` unless a test of the helper passes its own. */
  known?: readonly KnownCoarseFinding[];
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
 * tag and the attributes that survive a change of style (`id`, `data-slot`, `role`), with up to two ancestors that have
 * one of them (or are a landmark): the `div`s with nothing to say are left out, so a wrapper added or removed does not
 * rename the finding. `measured` is how many elements with text were looked at.
 */
export async function findClipped(
  root: Locator,
  { allowScroll = [], skip }: ClippedOptions = {}
): Promise<{ measured: number; offenders: ClippedElement[] }> {
  await expect(root, "the root of the sweep is not on the page").toHaveCount(1);
  return await root.evaluate(
    (element, { allowed, skipped, slack }) => {
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
      const LANDMARKS = ["main", "section", "form", "table"];
      const identified = (item: Element) =>
        label(item).length > item.tagName.length ||
        LANDMARKS.includes(item.tagName.toLowerCase());
      // the element, and up to two ancestors that say what they are: a bare `div` in between is no part of the name
      const selectorOf = (item: Element) => {
        const names = [label(item)];
        let current = item.parentElement;
        while (
          current !== null &&
          names.length < 3 &&
          current !== element.parentElement
        ) {
          if (identified(current)) {
            names.unshift(label(current));
          }
          current = current.parentElement;
        }
        return names.join(" > ");
      };
      const isBelowRoot = (item: Element, selector: string) => {
        const hit = item.closest(selector);
        return hit !== null && hit !== element && element.contains(hit);
      };
      const found: ClippedElement[] = [];
      let count = 0;
      for (const item of [element, ...element.querySelectorAll("*")]) {
        if (
          !mayCut(item) ||
          item.clientWidth === 0 ||
          (skipped !== undefined && isBelowRoot(item, skipped)) ||
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
    { allowed: [...allowScroll], skipped: skip, slack: SLACK_PIXELS }
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
  const unknown = await stillUnknown(
    root.page(),
    offenders,
    options.known ?? KNOWN_COARSE_FINDINGS
  );
  expect(describeOffenders(unknown)).toEqual([]);
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
export async function assertNoPageScroll(
  page: Page,
  { known = KNOWN_COARSE_FINDINGS }: Pick<ClippedOptions, "known"> = {}
) {
  const scroll = await page.evaluate(() => {
    const scroller = document.scrollingElement ?? document.documentElement;
    return {
      client: scroller.clientWidth,
      scroll: scroller.scrollWidth,
    };
  });
  if (scroll.scroll > scroll.client) {
    const unknown = await stillUnknown(
      page,
      [
        {
          clientWidth: scroll.client,
          scrollWidth: scroll.scroll,
          selector: "html",
        },
      ],
      known
    );
    if (unknown.length === 0) {
      return;
    }
  }
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
