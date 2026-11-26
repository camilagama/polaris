/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import axe from "axe-core";

/**
 * The mechanical checks of the interface review: what the UX reviewer finds by measuring, a browser
 * measures. Each check runs inside the page and returns the list of what failed, so a test says
 * `toEqual([])` and a control case proves the check catches the fault. The screens they run on are in
 * `ui-screens.ts`; how to add one is in docs/runbooks/testes-de-tela.md.
 *
 * The functions marked "in page" are serialized and run in the browser: they may use only each other
 * (the helpers listed in `HELPERS`, which `inPage` ships with them), never a constant of this module.
 */

declare global {
  interface Window {
    __keyCount?: number;
    __keys?: WeakMap<Element, number>;
    __motion?: MotionRecord[];
    axe: typeof axe;
  }
}

export interface MotionRecord {
  duration: number;
  /** Names the animated element within the page, so two targets with the same animation are two records. */
  id: number;
  iterations: number;
  name: string;
  target: string;
}

// The WCAG 2.2 A and AA rules, the bar of DESIGN.md; best practices stay out (they are advice, not criteria).
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** The pointer controls of a screen: what a finger can tap (not the hidden inputs Base UI keeps for forms). */
const POINTER_CONTROLS = [
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "summary",
  "[role=button]",
  "[role=link]",
  "[role=checkbox]",
  "[role=radio]",
  "[role=switch]",
  "[role=tab]",
  "[role=menuitem]",
  "[role=menuitemcheckbox]",
  "[role=menuitemradio]",
  "[role=option]",
  "[role=combobox]",
].join(",");

/** The most stops of Tab one screen may have before the check gives up and says so. */
const MAX_TAB_STOPS = 150;

// ---- helpers in page -------------------------------------------------------------------------------------

/** How a failure names an element: its tag and the first words of its name (label, text or placeholder). */
function labelOf(element: Element) {
  const labelled = (element as HTMLInputElement).labels?.[0]?.textContent;
  const name = (
    element.getAttribute("aria-label") ??
    labelled ??
    (element.textContent || element.getAttribute("placeholder")) ??
    element.getAttribute("name") ??
    ""
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 30);
  return `${element.tagName.toLowerCase()}${name ? ` "${name}"` : ""}`;
}

/** Rendered, not hidden from the eye nor from assistive technology. */
function isShown(element: Element) {
  return (
    element.checkVisibility({ visibilityProperty: true }) &&
    !element.closest("[aria-hidden=true], [inert]")
  );
}

/**
 * In page: hidden the way `sr-only` hides (absolute, 1 × 1 px, overflow hidden), as the skip link "Ir para o
 * conteúdo" until it has the focus: not a target. A control that merely collapsed to 1 px is still measured.
 */
function isVisuallyHidden(element: Element) {
  const box = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return (
    box.width <= 1 &&
    box.height <= 1 &&
    style.position === "absolute" &&
    style.overflow === "hidden"
  );
}

/**
 * In page: the ancestors that cut what can be touched of a control (they scroll or clip), up to the first fixed
 * layer (a fixed element escapes the clip of what is above it), each with its box.
 */
function clippingOwners(element: Element) {
  const owners: Array<{ box: DOMRect; owner: Element }> = [];
  for (
    let node: Element | null = element;
    node && node !== document.body;
    node = node.parentElement
  ) {
    if (node !== element) {
      const style = getComputedStyle(node);
      if (`${style.overflowX} ${style.overflowY}` !== "visible visible") {
        owners.push({ box: node.getBoundingClientRect(), owner: node });
      }
    }
    if (getComputedStyle(node).position === "fixed") {
      break;
    }
  }
  return owners;
}

/** In page: the closest ancestor (or the element) with `position: fixed`, or null for what scrolls with the page. */
function fixedLayerOf(element: Element) {
  for (
    let node: Element | null = element;
    node && node !== document.body;
    node = node.parentElement
  ) {
    if (getComputedStyle(node).position === "fixed") {
      return node;
    }
  }
  return null;
}

/** In page: a number that names an element for the life of the page (a tooltip or a toast coming in does not shift it). */
function keyOf(element: Element) {
  const keys = window.__keys ?? new WeakMap<Element, number>();
  window.__keys = keys;
  const known = keys.get(element);
  if (known !== undefined) {
    return known;
  }
  window.__keyCount = (window.__keyCount ?? 0) + 1;
  keys.set(element, window.__keyCount);
  return window.__keyCount;
}

const HELPERS = [
  labelOf,
  isShown,
  isVisuallyHidden,
  clippingOwners,
  fixedLayerOf,
  touchAreaOf,
  grownInGroup,
  isInlineLink,
  ownsOverflow,
  insideOwner,
  spillsSideways,
  keyOf,
  spoken,
  targetsOf,
  readableText,
  isScreenReaderOnly,
  nameOf,
  repeatedByAttribute,
  repeatedBySrOnly,
]
  .map((helper) => helper.toString())
  .join("\n");

/** Runs a self-contained function in the page together with the helpers above. */
function inPage<Result>(
  page: Page,
  check: (...args: never[]) => Result,
  ...args: unknown[]
): Promise<Awaited<Result>> {
  const call = args.map((arg) => JSON.stringify(arg)).join(", ");
  return page.evaluate(
    `(() => {\n${HELPERS}\nreturn (${check})(${call});\n})()`
  );
}

// ---- 3. contrast ----------------------------------------------------------------------------------------

/**
 * What axe finds on the page, by rule and node, for the WCAG 2.2 A and AA rules. `within` narrows it to the elements
 * that match a selector (an open popover, whose box covers the controls under it on purpose).
 */
export async function axeViolations(page: Page, within?: string) {
  await page.evaluate(axe.source);
  return page.evaluate(
    async ([tags, selector]) => {
      const result = await window.axe.run(selector ?? document, {
        resultTypes: ["violations"],
        runOnly: { type: "tag", values: tags },
      });
      return result.violations.map((violation) => ({
        id: violation.id,
        nodes: violation.nodes.map((node) => node.target.join(" ")),
      }));
    },
    [WCAG_TAGS, within] as const
  );
}

/** The same, one line per rule and node: `rule: selector`. */
export async function axeFaults(page: Page, within?: string) {
  return (await axeViolations(page, within)).flatMap((violation) =>
    violation.nodes.map((node) => `${violation.id}: ${node}`)
  );
}

/** A square inside a hidden tab stays in the DOM and is not counted; where the drawing of the screen takes the place of the squares (from 760 px), none is expected. */
export function emptyIconFaults(page: Page, squares: number) {
  return page.evaluate((expected) => {
    const found = [
      ...document.querySelectorAll(
        "[data-empty-state] [data-slot='empty-icon']"
      ),
    ].filter((square) => square.getClientRects().length > 0);
    const arts = [
      ...document.querySelectorAll("[data-empty-state] [data-skeleton-art]"),
    ].filter((art) => art.getClientRects().length > 0);
    const wanted = arts.length > 0 ? 0 : expected;
    const faults = found.flatMap((square, index) => {
      const box = square.getBoundingClientRect();
      const svg = square.querySelector("svg.lucide");
      const icon = svg?.getBoundingClientRect();
      return [
        box.width === 36 && box.height === 36
          ? ""
          : `quadro ${index}: ${box.width} x ${box.height} px`,
        square.getAttribute("aria-hidden") === "true"
          ? ""
          : `quadro ${index}: sem aria-hidden`,
        icon && icon.width === 16 && icon.height === 16
          ? ""
          : `ícone ${index}: ${icon?.width} px`,
        svg && Number.parseFloat(getComputedStyle(svg).strokeWidth) === 2
          ? ""
          : `ícone ${index}: traço fora de 2`,
      ].filter(Boolean);
    });
    const tops = new Set(
      found.map((square) => Math.round(square.getBoundingClientRect().top))
    );
    if (tops.size > 1) {
      faults.push("os quadros não ficam numa linha só");
    }
    for (const [index, art] of arts.entries()) {
      if (art.getAttribute("aria-hidden") !== "true") {
        faults.push(`ilustração ${index}: sem aria-hidden`);
      }
    }
    return found.length === wanted
      ? faults
      : [`${found.length} quadros, esperava ${wanted}`, ...faults];
  }, squares);
}

// ---- 1. nothing leaves its container --------------------------------------------------------------------

/** In page: a horizontal scrollbar on the page itself. */
function pageScrollsSideways(tolerance: number) {
  const root = document.documentElement;
  return root.scrollWidth > root.clientWidth + tolerance
    ? [
        `a página rola de lado: ${root.scrollWidth} px de conteúdo em ${root.clientWidth} px`,
      ]
    : [];
}

/**
 * In page: a container that scrolls (`overflow-x: auto|scroll`: a scroll area, a table wrapper) or that cuts
 * on purpose (`text-overflow: ellipsis`) owns what is inside it. `overflow: hidden` does not: it only hides
 * the fault, so what it cuts is still a fault.
 */
function ownsOverflow(container: Element) {
  const style = getComputedStyle(container);
  return (
    style.overflowX === "auto" ||
    style.overflowX === "scroll" ||
    style.textOverflow === "ellipsis"
  );
}

/** In page: some ancestor below `<body>` owns the overflow of the element. */
function insideOwner(element: Element) {
  for (
    let up = element.parentElement;
    up && up !== document.body && up !== document.documentElement;
    up = up.parentElement
  ) {
    if (ownsOverflow(up)) {
      return true;
    }
  }
  return false;
}

/**
 * In page: the box goes past the sides of its parent's. A label centered on a point (the dates of the chart's x axis,
 * Bklit UI) sits in an anchor box with no width: the text is centered on it by construction and is held by the chart's
 * own box, which the check above reads, so a parent of no width inside the chart is not a box to leave.
 */
function spillsSideways(
  box: DOMRect,
  outer: DOMRect,
  tolerance: number,
  parent: Element
) {
  const anchor = parent.closest("[data-chart-area]") !== null;
  return (
    (!anchor || outer.width > 1) &&
    (box.right > outer.right + tolerance || box.left < outer.left - tolerance)
  );
}

/** In page: an element past the viewport, or past the box of its parent, even when `overflow: hidden` hides it. */
function elementsOutside(tolerance: number) {
  const viewport = document.documentElement.clientWidth;
  const found: string[] = [];
  for (const element of document.body.querySelectorAll("*")) {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const inFlow = style.position !== "absolute" && style.position !== "fixed";
    if (
      (box.width <= 1 && box.height <= 1) ||
      style.display === "contents" ||
      !element.checkVisibility({ visibilityProperty: true }) ||
      (element.closest("svg") && element.tagName.toLowerCase() !== "svg") ||
      insideOwner(element)
    ) {
      continue;
    }
    let parent = element.parentElement;
    while (parent && getComputedStyle(parent).display === "contents") {
      parent = parent.parentElement;
    }
    if (box.right > viewport + tolerance || box.left < -tolerance) {
      found.push(
        `${labelOf(element)} sai da tela: de ${Math.round(box.left)} a ${Math.round(box.right)} px numa tela de ${viewport} px`
      );
    } else if (parent && parent !== document.body && inFlow) {
      const outer = parent.getBoundingClientRect();
      if (spillsSideways(box, outer, tolerance, parent)) {
        found.push(
          `${labelOf(element)} sai de ${labelOf(parent)}: ${Math.round(box.right - outer.right)} px à direita, ${Math.round(outer.left - box.left)} px à esquerda`
        );
      }
    }
  }
  return found;
}

/** In page: a line of text past the edge of its block (a long word that does not break spills without widening the box). */
function textOutside(tolerance: number) {
  const found: string[] = [];
  const texts = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = texts.nextNode(); node; node = texts.nextNode()) {
    const owner = node.parentElement;
    if (
      !(
        owner &&
        node.textContent?.trim() &&
        owner.checkVisibility({ visibilityProperty: true })
      ) ||
      owner.closest("svg, script, style") ||
      ownsOverflow(owner) ||
      insideOwner(owner)
    ) {
      continue;
    }
    let block: Element | null = owner;
    while (
      block &&
      ["inline", "contents"].includes(getComputedStyle(block).display)
    ) {
      block = block.parentElement;
    }
    if (!block || block === document.body) {
      continue;
    }
    const outer = block.getBoundingClientRect();
    // text for the screen reader only (a 1 px box that clips) is not on the screen
    if (outer.width <= 1 && outer.height <= 1) {
      continue;
    }
    const range = document.createRange();
    range.selectNodeContents(node);
    const spills = [...range.getClientRects()].some(
      (line) =>
        line.width > 0 &&
        (line.right > outer.right + tolerance ||
          line.left < outer.left - tolerance)
    );
    if (spills) {
      found.push(`o texto de ${labelOf(block)} passa da borda do bloco`);
    }
  }
  return found;
}

/** 1. Nothing leaves its container nor the viewport: no element, no line of text, no horizontal scroll. */
export async function overflowFaults(page: Page, tolerance = 1) {
  const found = [
    ...(await inPage(page, pageScrollsSideways, tolerance)),
    ...(await inPage(page, elementsOutside, tolerance)),
    ...(await inPage(page, textOutside, tolerance)),
  ];
  return [...new Set(found)];
}

// ---- 2. touch targets -----------------------------------------------------------------------------------

/**
 * In page: the box of a control grown by the larger of its `::before` and `::after` (the `touch-hit`
 * pseudo-element). The field of an `InputGroup` has the area of the group (`touch-hit-field`), which a pseudo-element
 * cannot give to an `<input>` itself. A button inside the group does not: it is measured by its own box, or by its
 * own `touch-hit`.
 */
function touchAreaOf(element: Element) {
  const box = element.getBoundingClientRect();
  const area = {
    bottom: box.bottom,
    left: box.left,
    right: box.right,
    top: box.top,
  };
  const px = (value: string) => Number.parseFloat(value) || 0;
  const group = element.matches(
    "input, textarea, [data-slot=input-group-control]"
  )
    ? element.closest("[data-slot=input-group]")
    : null;
  for (const owner of group ? [element, group] : [element]) {
    const ownerBox = owner.getBoundingClientRect();
    area.top = Math.min(area.top, ownerBox.top);
    area.left = Math.min(area.left, ownerBox.left);
    area.bottom = Math.max(area.bottom, ownerBox.bottom);
    area.right = Math.max(area.right, ownerBox.right);
    for (const pseudo of ["::before", "::after"] as const) {
      const style = getComputedStyle(owner, pseudo);
      if (style.content !== '""' || style.position !== "absolute") {
        continue;
      }
      // `top` and the others are measured from the padding box, inside the border
      const border = getComputedStyle(owner);
      area.top = Math.min(
        area.top,
        ownerBox.top + px(border.borderTopWidth) + px(style.top)
      );
      area.left = Math.min(
        area.left,
        ownerBox.left + px(border.borderLeftWidth) + px(style.left)
      );
      area.bottom = Math.max(
        area.bottom,
        ownerBox.bottom - px(border.borderBottomWidth) - px(style.bottom)
      );
      area.right = Math.max(
        area.right,
        ownerBox.right - px(border.borderRightWidth) - px(style.right)
      );
    }
  }
  return area;
}

/**
 * In page: the area of a control of a `[data-target-group]` grown by 4 px on each side, so two of them closer than 8 px
 * overlap (WCAG 2.2, 2.5.8); any other control keeps its area.
 */
function grownInGroup(
  element: Element,
  area: { bottom: number; left: number; right: number; top: number }
) {
  if (!element.closest("[data-target-group]")) {
    return area;
  }
  return {
    bottom: area.bottom + 4,
    left: area.left - 4,
    right: area.right + 4,
    top: area.top - 4,
  };
}

/** In page: a link inside a line of running text, which WCAG 2.5.8 exempts from the size. */
function isInlineLink(element: Element) {
  const parent = element.parentElement;
  if (
    element.tagName !== "A" ||
    getComputedStyle(element).display !== "inline" ||
    !parent ||
    ["flex", "inline-flex", "grid", "inline-grid"].includes(
      getComputedStyle(parent).display
    )
  ) {
    return false;
  }
  // words of its own parent beside it: the link sits in a line of text, not in a row of controls
  return [...parent.childNodes].some(
    (node) =>
      node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== ""
  );
}

/** In page: a control whose touch area is under `minimum` px on a side. */
function touchTooSmall(
  selector: string,
  minimum: number,
  exemptInlineLinks: boolean
) {
  const found: string[] = [];
  for (const element of document.querySelectorAll(selector)) {
    if (
      !isShown(element) ||
      isVisuallyHidden(element) ||
      (exemptInlineLinks && isInlineLink(element))
    ) {
      continue;
    }
    const area = touchAreaOf(element);
    const width = area.right - area.left;
    const height = area.bottom - area.top;
    // the controls of a group and the days of a month grid answer to WCAG 2.2 (2.5.8): 24 px, not the page minimum
    const floor =
      element.closest("[data-target-group]") ||
      element.matches("[data-slot=calendar] button[data-day]")
        ? Math.min(minimum, 24)
        : minimum;
    if (width < floor - 0.5 || height < floor - 0.5) {
      found.push(
        `${labelOf(element)} tem área de toque de ${Math.round(width)} × ${Math.round(height)} px (mínimo ${floor})`
      );
    }
  }
  return found;
}

/**
 * In page: two controls whose touch areas overlap (a tap between them is a guess). The controls of one
 * `[data-slot=button-group]` are one fused unit, and so are the ones of one `[data-slot=input-group]` (the field and
 * the button at its end, "Mostrar" of a password: the field has the area of the group, the button its own, drawn
 * over it); a control inside another (a link in a clickable card) is nested. The cells of a month grid touch each
 * other without overlapping (the day has no `touch-hit`), so they need no exception. A control of a
 * `[data-target-group]` has no area beyond its box and keeps 8 px from the next one (WCAG 2.2, 2.5.8): the check grows
 * each by 4 px.
 */
function touchOverlaps(selector: string) {
  const controls = [...document.querySelectorAll(selector)]
    .filter((element) => isShown(element) && !isVisuallyHidden(element))
    .map((element) => ({
      area: grownInGroup(element, touchAreaOf(element)),
      element,
      layer: fixedLayerOf(element),
      owners: clippingOwners(element),
    }));
  type Control = (typeof controls)[number];
  type Area = Control["area"];
  /**
   * The area of a control a tap can reach beside the other one: cut by the ancestors that scroll or clip it and do
   * not hold the other (two items of one list that scrolls are compared whole, scrolled away or not; an item of the
   * sidebar's list scrolled under its foot is only what shows above the foot). Null when nothing is left.
   */
  const reachable = (control: Control, other: Control): Area | null => {
    const cut = { ...control.area };
    for (const { box, owner } of control.owners) {
      if (owner.contains(other.element)) {
        break;
      }
      cut.top = Math.max(cut.top, box.top);
      cut.left = Math.max(cut.left, box.left);
      cut.bottom = Math.min(cut.bottom, box.bottom);
      cut.right = Math.min(cut.right, box.right);
    }
    return cut.right - cut.left > 1 && cut.bottom - cut.top > 1 ? cut : null;
  };
  const overlap = (one: Area, other: Area, shift: number) => ({
    across: Math.min(one.right, other.right) - Math.max(one.left, other.left),
    down:
      Math.min(one.bottom + shift, other.bottom) -
      Math.max(one.top + shift, other.top),
  });
  // how far the page can scroll from where it is: up to its end, back to its top
  const scrolling = document.scrollingElement ?? document.documentElement;
  const toEnd = Math.max(
    0,
    scrolling.scrollHeight - window.innerHeight - window.scrollY
  );
  const toTop = window.scrollY;
  /** One control fused with the other (a button group, an input group) or inside it (a link in a clickable card). */
  const joined = (first: Control, second: Control) =>
    first.element.contains(second.element) ||
    second.element.contains(first.element) ||
    ["button-group", "input-group"].some((slot) => {
      const group = first.element.closest(`[data-slot=${slot}]`);
      return group && group === second.element.closest(`[data-slot=${slot}]`);
    });
  /** How much the two areas overlap, across and down; zero or less is apart. */
  const pairOverlap = (first: Control, second: Control) => {
    const one = reachable(first, second);
    const other = reachable(second, first);
    if (joined(first, second) || one === null || other === null) {
      return { across: 0, down: 0 };
    }
    if ((first.layer === null) === (second.layer === null)) {
      return overlap(one, other, 0);
    }
    // a fixed bar (the bottom bar of the phone) over a control of the page that scrolls under it: a fault only when
    // no scrolling takes them apart (a short page whose last control stays under the bar)
    const [page, bar] = first.layer === null ? [one, other] : [other, one];
    const atEnd = overlap(page, bar, -toEnd);
    const atTop = overlap(page, bar, toTop);
    return {
      across: Math.min(atEnd.across, atTop.across),
      down: Math.min(atEnd.down, atTop.down),
    };
  };
  const found: string[] = [];
  for (const [index, first] of controls.entries()) {
    for (const second of controls.slice(index + 1)) {
      const { across, down } = pairOverlap(first, second);
      if (across > 1 && down > 1) {
        found.push(
          `a área de toque de ${labelOf(first.element)} se sobrepõe à de ${labelOf(second.element)} (${Math.round(across)} × ${Math.round(down)} px)`
        );
      }
    }
  }
  return found;
}

/**
 * 2. Touch targets: every pointer control has a touch area of at least `minimum` px on both sides and the
 * touch areas of neighbors do not overlap. Run it in a context with touch (`pointer: coarse`): the 44 px
 * area exists only then.
 */
export async function touchFaults(
  page: Page,
  options: { exemptInlineLinks: boolean; minimum: number }
) {
  return [
    ...(await inPage(
      page,
      touchTooSmall,
      POINTER_CONTROLS,
      options.minimum,
      options.exemptInlineLinks
    )),
    ...(await inPage(page, touchOverlaps, POINTER_CONTROLS)),
  ];
}

// ---- 6. focus -------------------------------------------------------------------------------------------

/** In page: what the keyboard focus draws on the focused element, or on the group that holds it. */
async function describeFocus(within?: string) {
  // the ring fades in (140 ms): measure it after the transitions of the stop have ended
  await Promise.all(
    document
      .getAnimations()
      .filter(
        (animation) =>
          animation.effect?.getComputedTiming().iterations !==
          Number.POSITIVE_INFINITY
      )
      .map((animation) => animation.finished.catch(() => undefined))
  );
  const active = document.activeElement;
  if (!active || active === document.body) {
    return null;
  }
  const transparent = (color: string) =>
    color === "transparent" || color.includes("/ 0)") || color.endsWith(", 0)");
  // the 3 px outline of `focus-ring`, or, in a text field, the 3 px halo of the ring
  const draws = (element: Element) => {
    const style = getComputedStyle(element);
    const outline =
      style.outlineStyle !== "none" &&
      Number.parseFloat(style.outlineWidth) >= 3 &&
      !transparent(style.outlineColor);
    // the ring is a shadow with no offset, no blur and a 3 px spread (a soft drop shadow is not a focus)
    const halo = style.boxShadow.includes("0px 0px 0px 3px");
    return outline || halo;
  };
  // a radio inside a choice card, a field inside an input group: the group draws it
  const holders = [
    active,
    active.closest("label"),
    active.closest("[data-slot=input-group]"),
    active.closest("[data-slot=field]"),
  ].filter((element): element is Element => element !== null);
  return {
    drawn: holders.some(draws),
    // the sentinel Base UI puts at both ends of an open modal: it is no control, it hands the focus on
    guard: active.hasAttribute("data-base-ui-focus-guard"),
    key: keyOf(active),
    label: labelOf(active),
    outside: within ? active.closest(within) === null : false,
  };
}

/** In page: the controls the page keeps in the tab order, inside `within` when it is given. */
function tabbable(selector: string, within?: string) {
  return [...document.querySelectorAll<HTMLElement>(selector)]
    .filter(
      (element) =>
        (!within || element.closest(within) !== null) &&
        element.tabIndex >= 0 &&
        !element.matches(":disabled") &&
        isShown(element)
    )
    .map((element) => ({
      key: keyOf(element),
      label: labelOf(element),
    }));
}

/**
 * 6. Focus: Tab through the whole screen with the real keyboard; each stop draws the 3 px ring, and every
 * control the page keeps in the tab order is reached. `within` is a selector for one element (with no modal open): the
 * walk starts right before it and ends when the focus leaves it, so it costs one Tab per control inside instead of one
 * per control of the screen (each stop waits for the ring to fade in).
 */
export async function focusFaults(page: Page, within?: string) {
  await page.evaluate((scope) => {
    // an open modal has the focus inside it, and Tab goes round its controls: the walk starts at the popup
    const popup = scope
      ? null
      : document.querySelector<HTMLElement>("[role=dialog][data-open]");
    if (popup) {
      popup.focus();
      return;
    }
    (document.activeElement as HTMLElement | null)?.blur();
    // Tab starts where the last click or focus was: a screen the test has filled in would skip what is above
    // that point. An element focused at the top of the page and then removed leaves the starting point there,
    // as for a person who just arrived.
    const root = scope ? document.querySelector(scope) : null;
    if (scope && !root) {
      throw new Error(`focusFaults: nothing matches "${scope}"`);
    }
    if (!scope) {
      window.scrollTo(0, 0);
    }
    const anchor = document.createElement("span");
    anchor.tabIndex = -1;
    (root ?? document.body).prepend(anchor);
    anchor.focus();
    anchor.remove();
  }, within);
  const reached = new Set<number>();
  const faults: string[] = [];
  let ended = false;
  let previous: number | undefined;
  for (let step = 0; step < MAX_TAB_STOPS && !ended; step += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: the real keyboard moves one stop at a time
    await page.keyboard.press("Tab");
    const stop = await inPage(page, describeFocus, within);
    if (stop?.guard) {
      continue;
    }
    if (stop?.outside) {
      ended = true;
      break;
    }
    // the same element twice in a row is a control of several parts (the fields of a `datetime-local`): the
    // browser has not left it yet; the same element after others is the loop closing
    const insideSameControl = stop !== null && stop.key === previous;
    ended = !stop || (reached.has(stop.key) && !insideSameControl);
    previous = stop?.key;
    if (stop && !ended && !insideSameControl) {
      reached.add(stop.key);
      if (!stop.drawn) {
        faults.push(`${stop.label} não mostra o contorno de foco de 3 px`);
      }
    }
  }
  if (!ended) {
    faults.push(
      `a tela tem mais de ${MAX_TAB_STOPS} paradas de Tab: suba MAX_TAB_STOPS ou divida a tela`
    );
  }
  for (const { key, label } of await inPage(
    page,
    tabbable,
    POINTER_CONTROLS,
    within
  )) {
    if (!reached.has(key)) {
      faults.push(`${label} está na ordem de Tab e o teclado não chega nele`);
    }
  }
  return faults;
}

// ---- 10. one name, read once -----------------------------------------------------------------------------

/** In page: a text as a person compares it by ear: whitespace collapsed, case ignored. */
function spoken(text: string | null | undefined) {
  return (text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** In page: the elements an `aria-labelledby` or `aria-describedby` value points to. */
function targetsOf(element: Element, attribute: string) {
  return (element.getAttribute(attribute) ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((id) => (id ? document.getElementById(id) : null))
    .filter((target): target is HTMLElement => target !== null);
}

/**
 * In page: the text of an element as a screen reader walks it: what is aria-hidden or not rendered is skipped, an
 * `aria-label` stands for its subtree, an image says its `alt`. An SVG says nothing (its `<title>` is not read here).
 * `except` leaves one descendant out.
 */
function readableText(element: Element, except?: Element): string {
  let text = "";
  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? "";
      continue;
    }
    if (!(node instanceof Element) || node === except) {
      continue;
    }
    const tag = node.tagName.toLowerCase();
    const silent =
      tag === "svg" ||
      node.getAttribute("aria-hidden") === "true" ||
      !node.checkVisibility({ visibilityProperty: true });
    if (!silent) {
      const alt = tag === "img" ? node.getAttribute("alt") : null;
      text += ` ${node.getAttribute("aria-label") ?? alt ?? readableText(node, except)} `;
    }
  }
  return text;
}

/** In page: hidden from the eye and read by the ear (`sr-only`), and not a live region, which is read on purpose. */
function isScreenReaderOnly(element: Element) {
  return (
    isVisuallyHidden(element) &&
    isShown(element) &&
    !element.closest("[aria-live], [role=status], [role=alert]")
  );
}

/**
 * In page: the accessible name a reader takes before the `title`: `aria-labelledby`, `aria-label`, the label of a
 * field, the `alt`, the content. Empty when only the `title` names the element (that is no repetition). `labelNodes`
 * are the elements the name came from, which a neighbor in `sr-only` may be without repeating anything.
 */
function nameOf(element: Element) {
  const tag = element.tagName.toLowerCase();
  const targets = targetsOf(element, "aria-labelledby");
  const labels = [...((element as HTMLInputElement).labels ?? [])];
  const isField = tag === "input" || tag === "select" || tag === "textarea";
  const text =
    (targets.length > 0
      ? targets.map((target) => target.textContent).join(" ")
      : null) ||
    element.getAttribute("aria-label") ||
    labels.map((label) => label.textContent).join(" ") ||
    (tag === "img" ? element.getAttribute("alt") : null) ||
    (isField ? "" : readableText(element));
  return { labelNodes: [...targets, ...labels], name: spoken(text) };
}

/** In page: what the markup says again about an element whose name is `name`, through attributes. */
function repeatedByAttribute(element: Element, name: string) {
  const described = spoken(
    targetsOf(element, "aria-describedby")
      .map((target) => target.textContent)
      .join(" ")
  );
  const repeats = [
    ["title", spoken(element.getAttribute("title"))],
    ["aria-description", spoken(element.getAttribute("aria-description"))],
    ["aria-describedby", described],
  ] as const;
  return repeats
    .filter(([, text]) => text === name)
    .map(([via]) => ({
      text: `o ${via} repete "${name}"`,
      via: via as string,
    }));
}

/** In page: what the markup says again about an element whose name is `name`, through `sr-only` text next to it. */
function repeatedBySrOnly(element: Element, labelNodes: Element[]) {
  const said = spoken(
    element.getAttribute("aria-label") || readableText(element)
  );
  if (!said || isScreenReaderOnly(element)) {
    return [];
  }
  const found: Array<{ text: string; via: string }> = [];
  for (const neighbor of [
    element.previousElementSibling,
    element.nextElementSibling,
  ]) {
    if (
      neighbor &&
      !labelNodes.includes(neighbor) &&
      isScreenReaderOnly(neighbor) &&
      spoken(readableText(neighbor)) === said
    ) {
      found.push({
        text: `o vizinho em sr-only repete "${said}"`,
        via: "sr-only",
      });
    }
  }
  if (!element.hasAttribute("aria-label")) {
    for (const child of element.children) {
      const inside = spoken(readableText(child));
      if (
        inside &&
        isScreenReaderOnly(child) &&
        spoken(readableText(element, child)) === inside
      ) {
        found.push({
          text: `o texto visível e o sr-only de dentro repetem "${inside}"`,
          via: "sr-only",
        });
      }
    }
  }
  return found;
}

/**
 * In page: the elements whose accessible name is said twice by the markup: by a `title`, by an `aria-description` or
 * `aria-describedby` that repeat it, or by `sr-only` text with the same words next to it or inside it. A neighbor that
 * is the source of the name (the label of a field, a `labelledby` target) is not a repetition. It reads the markup, not
 * what a reader says: `ui-guardrails/controle-medidas.e2e.ts` says so in the control cases.
 */
function repeatedNames(known: KnownRepeatedName[]) {
  const faults: string[] = [];
  for (const element of document.body.querySelectorAll("*")) {
    if (
      ["script", "style", "option"].includes(element.tagName.toLowerCase()) ||
      element.closest("svg") ||
      !isShown(element)
    ) {
      continue;
    }
    const { labelNodes, name } = nameOf(element);
    if (!name) {
      continue;
    }
    for (const { text, via } of [
      ...repeatedByAttribute(element, name),
      ...repeatedBySrOnly(element, labelNodes),
    ]) {
      const excused = known.some(
        (entry) => entry.via === via && element.matches(entry.selector)
      );
      if (!excused) {
        faults.push(`${labelOf(element)} diz o nome duas vezes: ${text}`);
      }
    }
  }
  return faults;
}

/** A repetition the check accepts until its cause is gone: where it is and by which attribute it repeats. */
export interface KnownRepeatedName {
  reason: string;
  selector: string;
  via: "title" | "aria-description" | "aria-describedby" | "sr-only";
}

/**
 * The repetitions the screens of `ui-screens.ts` have, each with its cause. The list is exact (`ui-guardrails/controle-medidas.e2e.ts` compares it entry by entry and proves each one still happens, so a fix has to take
 * its entry out), and what it excuses is a selector and an attribute, never a screen.
 */
export const KNOWN_REPEATED_NAMES: readonly KnownRepeatedName[] = [
  {
    reason:
      "SelectValue (src/ui/select.tsx) writes the chosen text into the title of its span, and the span already says it as content",
    selector: "[data-slot=select-value]",
    via: "title",
  },
];

/** 10. One name, read once: no `title`, description or `sr-only` neighbor that repeats the accessible name. */
export function repeatedNameFaults(
  page: Page,
  known: readonly KnownRepeatedName[] = KNOWN_REPEATED_NAMES
) {
  return inPage(page, repeatedNames, known);
}

// ---- 5. motion ------------------------------------------------------------------------------------------

/**
 * In page, an init script (installed before the page's own scripts): notes every animation and transition the
 * browser runs (its length and its repeats), to prove that nothing runs under `prefers-reduced-motion: reduce`.
 */
export function startMotionRecorder() {
  const records: MotionRecord[] = [];
  const ids = new Map<Element, number>();
  window.__motion = records;
  const tick = () => {
    for (const animation of document.getAnimations()) {
      const effect = animation.effect as KeyframeEffect | null;
      const timing = effect?.getComputedTiming();
      const target = effect?.target;
      if (!(effect && timing && target)) {
        continue;
      }
      const name =
        animation instanceof CSSAnimation
          ? animation.animationName
          : ((animation as CSSTransition).transitionProperty ?? "animation");
      const duration = Number(timing.duration);
      const id = ids.get(target) ?? ids.size + 1;
      ids.set(target, id);
      const known = records.some(
        (record) =>
          record.id === id &&
          record.name === name &&
          record.duration === duration
      );
      if (!known) {
        records.push({
          duration,
          id,
          iterations: timing.iterations ?? 1,
          name,
          target: `${target.tagName.toLowerCase()} "${(target.textContent ?? "").trim().slice(0, 20)}"`,
        });
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

export const readMotion = (page: Page) =>
  page.evaluate(() => window.__motion ?? []);

/** What counts as "something animates": longer than a blink, or repeating. */
export function runningMotion(records: MotionRecord[]) {
  return records.filter(
    (record) => record.duration > 1 || record.iterations > 1
  );
}
