import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The old CSS is gone (ADR 0103, section 3; t256): no file of apps/web/src is in `@layer legacy`. CSS outside a layer
 * wins over every layer, the utilities included, so one unwrapped sheet would beat the components on a screen: only
 * the files of Tailwind and the theme listed here may have rules outside a layer, and the entry imports Tailwind
 * first, which declares the order of its layers (theme, base, components, utilities) before anything else.
 */
const src = fileURLToPath(new URL("..", import.meta.url));
const ENTRY = "styles/index.css";
const BASE = new Set([
  ENTRY,
  // the shadcn tokens and the Tailwind theme of the v5.1
  "styles/theme.css",
  // copy of shadcn/tailwind.css (variants, keyframes, utilities)
  "styles/shadcn-tailwind.css",
]);
// the labs are no screens of the shop: their sheets are wholly inside `@layer components`, under the utilities
const LEGACY_LAYER = /@layer\s+[^;{]*\blegacy\b/;
const LAB_SHEETS = ["offline-poc/lab-page.css", "offline-poc/offline-poc.css"];
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

describe("no old CSS (ADR 0103, section 3)", () => {
  const files = cssFiles(src);

  it("finds the files of the base and of the labs", () => {
    for (const file of [...BASE, ...LAB_SHEETS]) {
      expect(files).toContain(file);
    }
  });

  it("no file is in @layer legacy: every sheet is of the base or of a lab", () => {
    expect(
      files.filter(
        (file) =>
          LEGACY_LAYER.test(
            readFileSync(join(src, file), "utf8").replace(COMMENT, "")
          ) || !(BASE.has(file) || LAB_SHEETS.includes(file))
      )
    ).toEqual([]);
  });

  it.each(LAB_SHEETS)("%s is wholly inside @layer components", (file) => {
    expect(
      outsideLayer(readFileSync(join(src, file), "utf8"), "components")
    ).toEqual([]);
  });

  it("the entry imports Tailwind before anything else, so the order of its layers comes first", () => {
    const entry = readFileSync(join(src, ENTRY), "utf8").replace(COMMENT, "");
    expect(entry.trim().split("\n")[0]).toBe(
      '@import "tailwindcss" source(none);'
    );
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
    const outsideComponents = (css: string) => outsideLayer(css, "components");
    expect(
      outsideComponents("@layer components { .a { color: red; } }")
    ).toEqual([]);
    expect(
      outsideComponents(
        "/* x { } */ @layer components { .a{} @media (x){ .b{} } }"
      )
    ).toEqual([]);
    expect(outsideComponents(".a { color: red; }")).toEqual([".a"]);
    expect(
      outsideComponents("@layer components { .a {} }\n.b { content: '}' }")
    ).toEqual([".b"]);
    expect(outsideComponents("@layer legacy { .a {} }")).toEqual([
      "@layer legacy",
    ]);
    expect(outsideComponents("@media (x) { .a {} }")).toEqual(["@media (x)"]);
    expect(outsideComponents('@import "./x.css";')).toEqual(['@import ""']);
  });
});
