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

/** What an old rule would change on a control or on text: box, type, color, focus. Used values (width, margin) stay out. */
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
  "min-height",
  "min-width",
  "opacity",
  "outline-color",
  "outline-offset",
  "outline-style",
  "outline-width",
  "padding-bottom",
  "padding-left",
  "padding-right",
  "padding-top",
  "text-align",
  "text-decoration-line",
  "text-transform",
  "white-space",
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

/**
 * Takes the snapshot of the screen under `[data-ui]` (the page is in the state to measure), then takes the layer
 * `legacy` out of the page and takes it again. Tab first: the focus is programmatic and only matches
 * `:focus-visible` when the last input was the keyboard.
 */
export async function legacyLayerOnAndOff(
  page: Page
): Promise<{ off: UiLayerState; on: UiLayerState }> {
  await page.keyboard.press("Tab");
  return await page.evaluate((properties) => {
    function nameOf(element: Element, index: number) {
      const text = (
        element.getAttribute("aria-label") ??
        (element as HTMLInputElement).labels?.[0]?.textContent ??
        element.textContent ??
        ""
      )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 24);
      return `${index} ${element.tagName.toLowerCase()}${text ? ` "${text}"` : ""}`;
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
      elements.forEach((element, index) => {
        const name = nameOf(element, index);
        result[name] = read(element);
        if (element instanceof HTMLInputElement) {
          result[`${name} ::placeholder`] = read(element, "::placeholder");
        }
      });
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
          result[
            `${nameOf(element, elements.indexOf(element))} :focus-visible`
          ] = read(element);
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
  for (const [name, withLayer] of Object.entries(on.snapshot)) {
    const without = off.snapshot[name];
    if (!without) {
      found.push(`${name}: sumiu sem a camada legacy`);
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
