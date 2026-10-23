/// <reference lib="dom" />
import type { Page } from "@playwright/test";

/**
 * Since batch 6 (t256) there is no old CSS: every style rule on the page is in a layer of Tailwind (`properties`,
 * `theme`, `base`, `components`, `utilities`). A rule outside them (no layer, or a layer of its own such as the old
 * `legacy`) beats or escapes the order the components count on, and reaches the screen without the review of the
 * base seeing it (ADR 0103, section 3). The check walks every sheet of the page, the adopted ones too, into `@media`,
 * `@supports`, nesting and `@import`, and lists each style rule whose outermost layer is not one of those.
 * `@font-face`, `@keyframes` and `@property` style no element, so they may stand outside, and so may a rule that only
 * sets tokens: the custom properties of `:root`, `.dark` and the touch block of theme.css (with the `color-scheme` of
 * the theme), which the components read through their utilities.
 *
 * Everything below `page.evaluate` is serialized and runs in the browser: it may use nothing of this module.
 */

/** The layers of the build, the order of `@import "tailwindcss"` (`properties` is Tailwind's fallback for @property). */
const TAILWIND_LAYERS = [
  "properties",
  "theme",
  "base",
  "components",
  "utilities",
] as const;

export interface PageRules {
  /** Each style rule outside the layers of Tailwind: `sem camada: button` or `@layer legacy: .x input`. */
  outside: string[];
  /** How many style rules were read, so a check that read nothing does not pass. */
  styleRules: number;
}

export async function rulesOutsideTailwindLayers(
  page: Page
): Promise<PageRules> {
  return await page.evaluate((layers) => {
    const allowed = new Set<string>(layers);
    const outside: string[] = [];
    let styleRules = 0;
    // what a rule holds and the outermost layer of it (null: none); a nested layer does not change where it sits
    const inner = (
      rule: CSSRule,
      layer: string | null
    ): [CSSRuleList, string | null] | null => {
      if (rule instanceof CSSLayerBlockRule) {
        return [rule.cssRules, layer ?? rule.name];
      }
      if (rule instanceof CSSImportRule) {
        return rule.styleSheet
          ? [rule.styleSheet.cssRules, layer ?? rule.layerName]
          : null;
      }
      // CSS nesting: the rules inside a style rule are in the same layer, like those of `@media` and `@supports`
      return rule instanceof CSSStyleRule || rule instanceof CSSGroupingRule
        ? [rule.cssRules, layer]
        : null;
    };
    const onlyTokens = (rule: CSSStyleRule) =>
      rule.style.length > 0 &&
      [...rule.style].every(
        (property) => property.startsWith("--") || property === "color-scheme"
      );
    const note = (rule: CSSStyleRule, layer: string | null) => {
      styleRules += 1;
      if ((layer === null || !allowed.has(layer)) && !onlyTokens(rule)) {
        const where =
          layer === null ? "sem camada" : `@layer ${layer || "anônima"}`;
        outside.push(`${where}: ${rule.selectorText}`);
      }
    };
    const pending: [CSSRuleList, string | null][] = [
      ...document.styleSheets,
      ...document.adoptedStyleSheets,
    ].map((sheet) => [sheet.cssRules, null]);
    for (let next = pending.pop(); next; next = pending.pop()) {
      const [rules, layer] = next;
      for (const rule of rules) {
        if (rule instanceof CSSStyleRule) {
          note(rule, layer);
        }
        const held = inner(rule, layer);
        if (held) {
          pending.push(held);
        }
      }
    }
    return { outside, styleRules };
  }, TAILWIND_LAYERS);
}

/** A sheet put on the page as the control cases need it (adopted: the CSP of the app refuses a `<style>`). */
export async function addSheet(page: Page, css: string) {
  await page.evaluate((text) => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(text);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  }, css);
}
