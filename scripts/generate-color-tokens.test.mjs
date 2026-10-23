import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CATALOG_OUTPUT,
  EMAIL_OUTPUT,
  expectedFiles,
  MANIFEST_OUTPUT,
  oklchToHex,
  readTheme,
  renderCatalogTokens,
  renderEmailColors,
  renderManifest,
} from "./generate-color-tokens.mjs";

// One source of color: apps/web/src/styles/theme.css (DESIGN.md, "Changing a color"). The catalog and the e-mails
// read files generated from it; these tests fail when one of them is stale, and when a color is written by hand
// anywhere else under apps/web/src or apps/catalog/src.
const FOREGROUND_VALUE = /--foreground: oklch\([^)]*\);/;
const DARK_RING_VALUE = /(\.dark \{[\s\S]*?)--ring: oklch\([^)]*\);/;
const LIGHT_BACKGROUND_VALUE =
  /(:root \{[\s\S]*?--background: )oklch\([^)]*\);/;
const PLAIN_OKLCH = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/;
const HEX = /^#[0-9a-f]{6}$/;
const root = new URL("../", import.meta.url).pathname;

describe("the files generated from theme.css", () => {
  const expected = expectedFiles();

  it.each([CATALOG_OUTPUT, EMAIL_OUTPUT, MANIFEST_OUTPUT])(
    "%s is what the script writes now (bun run tokens:generate)",
    (path) => {
      expect(readFileSync(join(root, path), "utf8")).toBe(expected[path]);
    }
  );

  it("carries the generated header with the command", () => {
    // the manifest is JSON: it has no comment to carry a header
    for (const path of [CATALOG_OUTPUT, EMAIL_OUTPUT]) {
      const content = expected[path];
      expect(content).toContain("Generated from apps/web/src/styles/theme.css");
      expect(content).toContain("Do not edit.");
      expect(content).toContain("bun run tokens:generate");
    }
  });

  it("a changed value in theme.css changes both files (control)", () => {
    const css = readFileSync(
      join(root, "apps/web/src/styles/theme.css"),
      "utf8"
    );
    // whatever the current values are: the first --foreground (light) and the --ring of .dark (the last one)
    const changed = css
      .replace(FOREGROUND_VALUE, "--foreground: oklch(0.3 0.04 250);")
      .replace(DARK_RING_VALUE, "$1--ring: oklch(0.7 0.1 200);");
    expect(changed).not.toBe(css);
    expect(changed).toContain("--foreground: oklch(0.3 0.04 250);");
    expect(changed).toContain("--ring: oklch(0.7 0.1 200);");
    const catalog = renderCatalogTokens(changed);
    expect(catalog).toContain("--foreground: oklch(0.3 0.04 250);");
    expect(catalog).toContain("--ring: oklch(0.7 0.1 200);");
    expect(catalog).not.toBe(expected[CATALOG_OUTPUT]);
    expect(renderEmailColors(changed)).not.toBe(expected[EMAIL_OUTPUT]);
  });

  it("a changed --background changes the colors of the manifest and nothing else (control)", () => {
    const css = readFileSync(
      join(root, "apps/web/src/styles/theme.css"),
      "utf8"
    );
    const current = readFileSync(join(root, MANIFEST_OUTPUT), "utf8");
    const changed = css.replace(LIGHT_BACKGROUND_VALUE, "$1oklch(0.5 0 0);");
    expect(changed).not.toBe(css);
    const before = JSON.parse(current);
    const after = JSON.parse(renderManifest(changed, current));
    expect(after.background_color).toBe("#636363");
    expect(after.theme_color).toBe("#636363");
    expect(after.background_color).not.toBe(before.background_color);
    expect({ ...after, background_color: 0, theme_color: 0 }).toEqual({
      ...before,
      background_color: 0,
      theme_color: 0,
    });
  });

  it("the catalog has the light block and the dark block, and every token it reads", () => {
    const tokens = expected[CATALOG_OUTPUT];
    const sheet = readFileSync(
      join(root, "apps/catalog/src/styles.css"),
      "utf8"
    );
    const own = new Set(
      [...sheet.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1])
    );
    const defined = new Set(
      [...tokens.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1])
    );
    const used = new Set(
      [...sheet.matchAll(/var\((--[\w-]+)/g)].map((match) => match[1])
    );
    const missing = [...used].filter(
      (name) => !(defined.has(name) || own.has(name))
    );
    expect(missing).toEqual([]);
    expect(tokens).toContain("@media (prefers-color-scheme: dark)");
    const { dark, light } = readTheme(
      readFileSync(join(root, "apps/web/src/styles/theme.css"), "utf8")
    );
    expect(tokens).toContain(`--background: ${light.background};`);
    expect(tokens).toContain(`--background: ${dark.background};`);
  });
});

describe("the theme-color metas of index.html", () => {
  it("are the --background of each theme in theme.css", () => {
    const { dark, light } = readTheme(
      readFileSync(join(root, "apps/web/src/styles/theme.css"), "utf8")
    );
    const html = readFileSync(join(root, "apps/web/index.html"), "utf8");
    const content = (theme) =>
      new RegExp(`content="([^"]+)"\\s+data-tema="${theme}"`).exec(html)?.[1];
    expect(content("claro")).toBe(light.background);
    expect(content("escuro")).toBe(dark.background);
  });
});

describe("the colors of the manifest", () => {
  it("are the light --background of theme.css, as hex", () => {
    const { light } = readTheme(
      readFileSync(join(root, "apps/web/src/styles/theme.css"), "utf8")
    );
    const manifest = JSON.parse(
      readFileSync(join(root, MANIFEST_OUTPUT), "utf8")
    );
    const [, lightness, chroma, hue] = PLAIN_OKLCH.exec(light.background);
    const hex = oklchToHex(Number(lightness), Number(chroma), Number(hue));
    expect(manifest.background_color).toBe(hex);
    expect(manifest.theme_color).toBe(hex);
  });
});

describe("OKLCH to sRGB hex", () => {
  it.each([
    [[1, 0, 0], "#ffffff"],
    [[0, 0, 0], "#000000"],
    [[0.5, 0, 0], "#636363"],
    [[0.627_96, 0.257_68, 29.234], "#ff0000"],
    [[0.866_44, 0.294_827, 142.495], "#00ff00"],
    [[0.452_014, 0.313_214, 264.052], "#0000ff"],
  ])("%j is %s", ([lightness, chroma, hue], hex) => {
    expect(oklchToHex(lightness, chroma, hue)).toBe(hex);
  });

  it("a real token: --foreground, oklch(0.2 0.005 85), is #171613", () => {
    expect(oklchToHex(0.2, 0.005, 85)).toBe("#171613");
  });

  it("clips what is out of the sRGB gamut instead of wrapping", () => {
    expect(oklchToHex(0.9, 0.4, 150)).toMatch(HEX);
  });
});

// ---- the guard: no color written by hand outside the source and the generated files ----

const SOURCE_DIRECTORIES = ["apps/web/src", "apps/catalog/src"];
const SCANNED = /\.(?:css|ts|tsx)$/;
const TEST_FILE = /\.(?:test|e2e)\.(?:ts|tsx)$/;
const GENERATED = /\.generated\.(?:css|ts)$/;
const THEME = "apps/web/src/styles/theme.css";
// the scroll-fade masks: opaque black as the mask, not a color of the brand
const MASKS = "apps/web/src/styles/shadcn-tailwind.css";
const MASK_COLOR = /oklch\(0 0 0\)/gi;
// a block comment starts after a space or at the line start: the "/**/" of a glob inside a string does not count
const COMMENT = /(^|\s)\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /^\s*\/\/.*$/gm;
// a literal color: #hex, rgb(, hsl(, hwb(, lab(, lch(, oklab(, oklch(, color(srgb …). `oklch(from …)` derives from
// another color, it is not a literal.
const LITERAL_COLOR =
  /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab)\(|\boklch\((?!\s*from\b)|\bcolor\(\s*(?:srgb|display-p3|a98-rgb|prophoto-rgb|rec2020|xyz)/gi;

function filesUnder(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (name === "node_modules") {
      return [];
    }
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

/** The literal colors of a source text, comments left out. */
export function literalColors(text, path) {
  const code = text.replace(COMMENT, "$1").replace(LINE_COMMENT, "");
  return (
    (path === MASKS ? code.replace(MASK_COLOR, "") : code).match(
      LITERAL_COLOR
    ) ?? []
  );
}

describe("no color written by hand", () => {
  const files = SOURCE_DIRECTORIES.flatMap((directory) =>
    filesUnder(join(root, directory))
  )
    .map((path) => relative(root, path))
    .filter(
      (path) =>
        SCANNED.test(path) &&
        !TEST_FILE.test(path) &&
        !GENERATED.test(path) &&
        path !== THEME
    );

  it("has files to look at, among them the catalog sheet, the labs and both e-mails", () => {
    for (const expectedFile of [
      "apps/catalog/src/styles.css",
      "apps/web/src/offline-poc/offline-poc.css",
      "apps/web/src/server/auth/emails.tsx",
      "apps/web/src/server/privacy/closure-notice-email.tsx",
      MASKS,
    ]) {
      expect(files).toContain(expectedFile);
    }
  });

  it("finds no #hex, rgb(, hsl( or oklch( outside theme.css, the generated files and the masks", () => {
    const found = files.flatMap((path) =>
      literalColors(readFileSync(join(root, path), "utf8"), path).map(
        (color) => `${path}: ${color}`
      )
    );
    expect(found).toEqual([]);
  });

  it("control: each kind of literal is caught, and the exceptions are narrow", () => {
    expect(literalColors("a { color: #fff }", "x.css")).toHaveLength(1);
    expect(literalColors('c = "#1e5c9a"', "x.ts")).toHaveLength(1);
    expect(literalColors("a { color: rgb(0 0 0) }", "x.css")).toHaveLength(1);
    expect(literalColors("a { color: hsl(0 0% 0%) }", "x.css")).toHaveLength(1);
    expect(literalColors("a { color: oklch(0.2 0 0) }", "x.css")).toHaveLength(
      1
    );
    // a derived color and a variable are not literals
    expect(
      literalColors("a { color: oklch(from var(--x) l c h) }", "x.css")
    ).toEqual([]);
    expect(literalColors("a { color: var(--foreground) }", "x.css")).toEqual(
      []
    );
    // the mask color only in the file of the masks
    expect(literalColors("m { mask: oklch(0 0 0) }", MASKS)).toEqual([]);
    expect(literalColors("m { mask: oklch(0 0 0) }", "x.css")).toHaveLength(1);
    expect(literalColors("m { color: oklch(0.2 0 0) }", MASKS)).toHaveLength(1);
    expect(literalColors("a { color: RGB(0 0 0) }", "x.css")).toHaveLength(1);
    expect(literalColors("a { color: lab(50 0 0) }", "x.css")).toHaveLength(1);
    expect(
      literalColors("a { color: color(srgb 1 0 0) }", "x.css")
    ).toHaveLength(1);
    // a glob in a string is not a comment, so a color after it is still seen
    expect(
      literalColors('g = "src/**/*.ts"; c = "#fff";', "x.ts")
    ).toHaveLength(1);
    // a comment is not a color
    expect(literalColors("/* was #fff */ a { top: 0 }", "x.css")).toEqual([]);
  });
});
