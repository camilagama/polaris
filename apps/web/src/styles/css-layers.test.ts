import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every old sheet of apps/web/src lives in `@layer legacy` (ADR 0103, section 3): CSS outside a layer wins over
 * every layer, the utilities included, so one unwrapped sheet would beat the new components on a screen. Only
 * the files of Tailwind and the theme listed here may have rules outside a layer, and the entry must declare
 * the order of the layers before anything else.
 */
const src = fileURLToPath(new URL("..", import.meta.url));
const ENTRY = "styles/index.css";
const OUTSIDE_LEGACY = new Set([
  ENTRY,
  // the shadcn tokens and the Tailwind theme of the v5.1
  "styles/theme.css",
  // copy of shadcn/tailwind.css (variants, keyframes, utilities)
  "styles/shadcn-tailwind.css",
  // Tailwind's preflight, imported into the base layer by the entry
  "styles/preflight.css",
]);
// the lab of the offline persistence is no screen of the shop: its sheet is wholly inside `@layer components`
const LAB_SHEETS = ["offline-poc/offline-poc.css"];
/**
 * The sheets still in `@layer legacy`, which the end of the migration (t256) empties: the three panels of the sale that
 * the lot 1b takes out (cancel, return and customer) and what they lean on. The list only shrinks; with the lot 1b
 * in, it is empty and this guard says what the task asks: no file in `@layer legacy`.
 */
const STILL_LEGACY = [
  "sales/sale-cancel-panel.css",
  "sales/sale-customer-panel.css",
  "sales/sale-legacy.css",
  "sales/sale-return-panel.css",
  "styles.css",
  "styles/tokens.css",
  "styles/ui.css",
];
const LAYER_ORDER = "@layer theme, base, components, legacy, utilities;";
const THEME_OUTSIDE_LAYER = [
  /^:root$/,
  /^\.dark$/,
  /^@theme( inline)?$/,
  /^@custom-variant [a-z-]+/,
  /^@utility [a-z-]+$/,
  /^@media \(pointer: coarse\), \(max-width: 759\.98px\)$/,
  /^@layer base$/,
];
const COMMENT = /\/\*[\s\S]*?\*\//g;
const STRING = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;

function cssFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return cssFiles(path);
    }
    return entry.name.endsWith(".css")
      ? [relative(src, path).split(sep).join("/")]
      : [];
  });
}

/** The preludes of the top-level statements and blocks of a sheet (`@layer legacy`, `.a`, `@media …`). */
function topLevelStatements(css: string): string[] {
  const text = css.replace(COMMENT, "").replace(STRING, '""');
  const statements: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (depth === 0 && (char === "{" || char === ";")) {
      statements.push(current.trim());
      current = "";
    } else if (depth === 0 && char !== "}") {
      current += char;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
    }
  }
  if (current.trim() !== "") {
    statements.push(current.trim());
  }
  return statements;
}

/** What in a sheet is not inside `@layer <name> { … }`. */
function outsideLayer(css: string, layer: string): string[] {
  return topLevelStatements(css).filter(
    (statement) => statement !== `@layer ${layer}`
  );
}

function outsideLegacy(css: string): string[] {
  return outsideLayer(css, "legacy");
}

describe("old CSS in @layer legacy (ADR 0103, section 3)", () => {
  const files = cssFiles(src);

  it("finds the old sheets and the files of the base", () => {
    expect(
      files.filter((file) => !OUTSIDE_LEGACY.has(file)).length
    ).toBeGreaterThan(0);
    for (const file of OUTSIDE_LEGACY) {
      expect(files).toContain(file);
    }
  });

  it.each(
    files.filter(
      (file) => !(OUTSIDE_LEGACY.has(file) || LAB_SHEETS.includes(file))
    )
  )("%s is wholly inside @layer legacy", (file) => {
    expect(outsideLegacy(readFileSync(join(src, file), "utf8"))).toEqual([]);
  });

  it.each(LAB_SHEETS)("%s is wholly inside @layer components", (file) => {
    expect(files).toContain(file);
    expect(
      outsideLayer(readFileSync(join(src, file), "utf8"), "components")
    ).toEqual([]);
  });

  it("only the sheets of the lot 1b (and what they lean on) are still in @layer legacy", () => {
    const inLegacy = files.filter((file) =>
      topLevelStatements(readFileSync(join(src, file), "utf8")).includes(
        "@layer legacy"
      )
    );
    expect(inLegacy.sort()).toEqual([...STILL_LEGACY].sort());
  });

  it("the entry declares the order of the layers before anything else, legacy under the utilities", () => {
    const statements = topLevelStatements(
      readFileSync(join(src, ENTRY), "utf8")
    );
    expect(`${statements[0]};`).toBe(LAYER_ORDER);
  });

  it("theme.css has outside a layer only the tokens, the theme, the variants, the utilities and the touch block", () => {
    const statements = topLevelStatements(
      readFileSync(join(src, "styles/theme.css"), "utf8")
    );
    expect(
      statements.filter(
        (statement) => !THEME_OUTSIDE_LAYER.some((rule) => rule.test(statement))
      )
    ).toEqual([]);
  });

  it("main.tsx imports the entry before any other module, so its order statement comes first", () => {
    const main = readFileSync(join(src, "main.tsx"), "utf8");
    const firstImport = main
      .split("\n")
      .find((line) => line.startsWith("import "));
    expect(firstImport).toBe('import "./styles/index.css";');
  });

  it("catches a rule outside the layer, a second layer and a stray @media", () => {
    expect(outsideLegacy("@layer legacy { .a { color: red; } }")).toEqual([]);
    expect(
      outsideLegacy("/* x { } */ @layer legacy { .a{} @media (x){ .b{} } }")
    ).toEqual([]);
    expect(outsideLegacy(".a { color: red; }")).toEqual([".a"]);
    expect(
      outsideLegacy("@layer legacy { .a {} }\n.b { content: '}' }")
    ).toEqual([".b"]);
    expect(outsideLegacy("@layer base { .a {} }")).toEqual(["@layer base"]);
    expect(outsideLegacy("@media (x) { .a {} }")).toEqual(["@media (x)"]);
    expect(outsideLegacy('@import "./x.css";')).toEqual(['@import ""']);
  });
});
