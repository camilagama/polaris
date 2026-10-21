/// <reference lib="dom" />
import type { Page } from "@playwright/test";

/**
 * A migrated screen lives inside the old shell (`.ui-root`, `body:has(.ui-root)`), so the sheets of `@layer legacy`
 * are on the page and any rule of them that names an element (`button`, `.ui-root input`, `:focus-visible`) reaches the
 * new components. The check: the computed style of every element under `[data-ui]` with the layer on the page,
 * and again with the layer taken out of the CSSOM. Whatever the layer contributes is a leak (ADR 0103, section 3).
 * The lab of the screens is not the reference because it has no `.ui-root`: the screen itself, without the layer, is.
 *
 * Everything below `page.evaluate` is serialized and runs in the browser: it may use nothing of this module.
 */

/**
 * What an old rule would change on a control or on text: box, border, padding, type, color, focus, position. The used
 * values (`width`, `height`, `margin`) stay out: they follow the container, which the old sheets do change.
 */
const PROPERTIES = [
  "accent-color",
  "appearance",
  "background-color",
  "background-image",
  "border-bottom-color",
  "border-bottom-left-radius",
  "border-bottom-right-radius",
  "border-bottom-style",
  "border-bottom-width",
  "border-left-color",
  "border-left-style",
  "border-left-width",
  "border-right-color",
  "border-right-style",
  "border-right-width",
  "border-top-color",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-top-style",
  "border-top-width",
  "box-shadow",
  "box-sizing",
  "caret-color",
  "color",
  "cursor",
  "display",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "letter-spacing",
  "line-height",
  "column-gap",
  "max-height",
  "max-width",
  "min-height",
  "min-width",
  "opacity",
  "outline-color",
  "outline-offset",
  "outline-style",
  "outline-width",
  "overflow-x",
  "overflow-y",
  "padding-bottom",
  "padding-left",
  "padding-right",
  "padding-top",
  "pointer-events",
  "position",
  "row-gap",
  "text-align",
  "text-decoration-line",
  "text-transform",
  "transform",
  "visibility",
  "white-space",
  "z-index",
] as const;

/** The style of an element, by the name of the element (`button "Mostrar"`, its place in the tree), property by property. */
type UiSnapshot = Record<string, Record<string, string>>;

/** One side of the comparison: the legacy layer, still on the page or not. */
export interface UiLayerState {
  /** How many rules of the layer `legacy` were taken out of the CSSOM (zero while it is on the page). */
  removed: number;
  snapshot: UiSnapshot;
}

/** An old rule that leaks, as the control cases inject it: in the layer, with the selector of the real fault. */
export async function addLegacyRule(page: Page, css: string) {
  await page.evaluate((rule) => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`@layer legacy { ${rule} }`);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  }, css);
}

/** A rule outside every layer (it beats the layers), for the control that needs a transition the check must see through. */
export async function addPageRule(page: Page, css: string) {
  await page.evaluate((rule) => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(rule);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  }, css);
}

/**
 * Puts under the shell a block of the new interface with what the screens opened by the checks do not show: a
 * field in error, one with a placeholder, a native select and a textarea. The old sheets name each of them.
 */
export async function addProbe(page: Page) {
  await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.dataset.ui = "";
    probe.innerHTML =
      '<input aria-label="sonda com erro" aria-invalid="true" />' +
      '<input aria-label="sonda com texto de apoio" placeholder="apoio" />' +
      '<select aria-label="sonda de lista"><option>a</option></select>' +
      '<textarea aria-label="sonda de texto"></textarea>';
    (document.querySelector(".ui-root") ?? document.body).append(probe);
  });
}

/**
 * Takes the snapshot of the screen under `[data-ui]` (the page is in the state to measure), then takes the layer
 * `legacy` out of the page and takes it again. Tab first: the focus is programmatic and only matches
 * `:focus-visible` when the last input was the keyboard.
 */
export async function legacyLayerOnAndOff(
  page: Page
): Promise<{ off: UiLayerState; on: UiLayerState }> {
  await page.keyboard.press("Tab");
  // a computed style read in the middle of a transition is the start of it, not the value the rule gives
  await addPageRule(
    page,
    "*, *::before, *::after { transition: none !important; }"
  );
  return await page.evaluate((properties) => {
    const seen = new Map<string, number>();
    function nameOf(element: Element) {
      const text = (
        element.getAttribute("aria-label") ??
        (element as HTMLInputElement).labels?.[0]?.textContent ??
        element.textContent ??
        ""
      )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 24);
      const slot = element.getAttribute("data-slot");
      const base = `${element.tagName.toLowerCase()}${slot ? `[${slot}]` : ""}${text ? ` "${text}"` : ""}`;
      // two elements with the same name are told apart by the order they come in, not by their place in the page
      const count = (seen.get(base) ?? 0) + 1;
      seen.set(base, count);
      return count > 1 ? `${base} #${count}` : base;
    }
    function read(element: Element, pseudo?: string) {
      const style = getComputedStyle(element, pseudo);
      return Object.fromEntries(
        properties.map((property) => [
          property,
          style.getPropertyValue(property),
        ])
      );
    }
    function snapshot() {
      const elements = [...document.querySelectorAll("[data-ui], [data-ui] *")];
      const result: Record<string, Record<string, string>> = {};
      const names = new Map<Element, string>();
      seen.clear();
      for (const element of elements) {
        const name = nameOf(element);
        names.set(element, name);
        result[name] = read(element);
        if (
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement
        ) {
          result[`${name} ::placeholder`] = read(element, "::placeholder");
        }
      }
      // the focus ring of each control that can have it
      const focusable = elements.filter(
        (element): element is HTMLElement =>
          element instanceof HTMLElement &&
          element.matches(
            "a[href], button:not(:disabled), input:not(:disabled):not([type=hidden]), select, textarea, [tabindex]"
          )
      );
      const before = document.activeElement;
      for (const element of focusable) {
        element.focus();
        if (element.matches(":focus-visible")) {
          result[`${names.get(element)} :focus-visible`] = read(element);
        }
      }
      (document.activeElement as HTMLElement | null)?.blur();
      (before as HTMLElement | null)?.focus?.();
      return result;
    }
    function removeLegacy() {
      let removed = 0;
      const clear = (rules: CSSRuleList, remove: (index: number) => void) => {
        for (let index = rules.length - 1; index >= 0; index -= 1) {
          const rule = rules[index] as CSSLayerBlockRule;
          if (rule instanceof CSSLayerBlockRule && rule.name === "legacy") {
            removed += rule.cssRules.length;
            remove(index);
          } else if (rule instanceof CSSGroupingRule) {
            clear(rule.cssRules, (at) => rule.deleteRule(at));
          }
        }
      };
      for (const sheet of [
        ...document.styleSheets,
        ...document.adoptedStyleSheets,
      ]) {
        clear(sheet.cssRules, (at) => sheet.deleteRule(at));
      }
      return removed;
    }
    const on = { removed: 0, snapshot: snapshot() };
    const removed = removeLegacy();
    return { off: { removed, snapshot: snapshot() }, on };
  }, PROPERTIES);
}

/** What the layer changed under `[data-ui]`: element, property, the value with the layer and the one without. */
export function leaks({ off, on }: { off: UiLayerState; on: UiLayerState }) {
  const found: string[] = [];
  for (const name of new Set([
    ...Object.keys(on.snapshot),
    ...Object.keys(off.snapshot),
  ])) {
    const withLayer = on.snapshot[name];
    const without = off.snapshot[name];
    if (!(withLayer && without)) {
      found.push(
        `${name}: só existe ${withLayer ? "com" : "sem"} a camada legacy`
      );
      continue;
    }
    for (const property of Object.keys(withLayer)) {
      if (withLayer[property] !== without[property]) {
        found.push(
          `${name}: ${property} ${withLayer[property]} (com legacy) ≠ ${without[property]} (sem)`
        );
      }
    }
  }
  return found;
}
