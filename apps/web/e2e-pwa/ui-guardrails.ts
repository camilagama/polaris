/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import axe from "axe-core";

/**
 * The mechanical checks of the interface review (t180): what the UX reviewer finds by measuring, a browser
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
  isInlineLink,
  ownsOverflow,
  insideOwner,
  keyOf,
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
      if (
        box.right > outer.right + tolerance ||
        box.left < outer.left - tolerance
      ) {
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
    if (width < minimum - 0.5 || height < minimum - 0.5) {
      found.push(
        `${labelOf(element)} tem área de toque de ${Math.round(width)} × ${Math.round(height)} px (mínimo ${minimum})`
      );
    }
  }
  return found;
}

/**
 * In page: two controls whose touch areas overlap (a tap between them is a guess). The controls of one
 * `[data-slot=button-group]` are one fused unit, and so are the ones of one `[data-slot=input-group]` (the field and
 * the button at its end, "Mostrar" of a password: the field has the area of the group, the button its own, drawn
 * over it) and the days of one `[data-slot=calendar]` (a grid of 44 px cells that touch each other, t363: the 48 px
 * areas of two neighbouring days meet only on their shared edge); a control inside another (a link in a clickable
 * card) is nested.
 */
function touchOverlaps(selector: string) {
  const controls = [...document.querySelectorAll(selector)]
    .filter((element) => isShown(element) && !isVisuallyHidden(element))
    .map((element) => ({
      area: touchAreaOf(element),
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
  /** Two days of one month grid (not its arrows, which keep their own area). */
  const daysOfOneCalendar = (one: Element, other: Element) => {
    const calendar = one.closest("[data-slot=calendar]");
    return (
      calendar !== null &&
      calendar === other.closest("[data-slot=calendar]") &&
      one.matches("button[data-day]") &&
      other.matches("button[data-day]")
    );
  };
  /** One control fused with the other (a button group, an input group, two days of a calendar) or inside it (a link in a clickable card). */
  const joined = (first: Control, second: Control) =>
    first.element.contains(second.element) ||
    second.element.contains(first.element) ||
    ["button-group", "input-group"].some((slot) => {
      const group = first.element.closest(`[data-slot=${slot}]`);
      return group && group === second.element.closest(`[data-slot=${slot}]`);
    }) ||
    daysOfOneCalendar(first.element, second.element);
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
 * touch areas of neighbors do not overlap. Run it in a context with touch (`pointer: coarse`): the 48 px
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
async function describeFocus() {
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
  };
}

/** In page: the controls the page keeps in the tab order. */
function tabbable(selector: string) {
  return [...document.querySelectorAll<HTMLElement>(selector)]
    .filter(
      (element) =>
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
 * control the page keeps in the tab order is reached.
 */
export async function focusFaults(page: Page) {
  await page.evaluate(() => {
    // an open modal has the focus inside it, and Tab goes round its controls: the walk starts at the popup
    const popup = document.querySelector<HTMLElement>(
      "[role=dialog][data-open]"
    );
    if (popup) {
      popup.focus();
      return;
    }
    (document.activeElement as HTMLElement | null)?.blur();
    // Tab starts where the last click or focus was: a screen the test has filled in would skip what is above
    // that point. An element focused at the top of the page and then removed leaves the starting point there,
    // as for a person who just arrived.
    window.scrollTo(0, 0);
    const anchor = document.createElement("span");
    anchor.tabIndex = -1;
    document.body.prepend(anchor);
    anchor.focus();
    anchor.remove();
  });
  const reached = new Set<number>();
  const faults: string[] = [];
  let ended = false;
  let previous: number | undefined;
  for (let step = 0; step < MAX_TAB_STOPS && !ended; step += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: the real keyboard moves one stop at a time
    await page.keyboard.press("Tab");
    const stop = await inPage(page, describeFocus);
    if (stop?.guard) {
      continue;
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
  for (const { key, label } of await inPage(page, tabbable, POINTER_CONTROLS)) {
    if (!reached.has(key)) {
      faults.push(`${label} está na ordem de Tab e o teclado não chega nele`);
    }
  }
  return faults;
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
