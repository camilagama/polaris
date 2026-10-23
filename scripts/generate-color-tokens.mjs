// The color tokens of Polaris have ONE source that someone edits: apps/web/src/styles/theme.css (OKLCH, ADR 0103,
// decision 3, DESIGN.md). Two places cannot read it at run time, so this script writes what they need:
//   - the public catalog (plain CSS, no Tailwind): apps/catalog/src/tokens.generated.css, the same variables, light and
//     dark;
//   - the e-mails (most clients read neither OKLCH nor CSS variables): apps/web/src/server/email-colors.generated.ts,
//     the light theme as sRGB hex;
//   - the web app manifest (apps/web/public/manifest.webmanifest): only `background_color` and `theme_color`, the light
//     --background as hex (a manifest holds one value, so the dark theme stays with the metas of index.html).
// Run `bun run tokens:generate` after changing a color in theme.css. `scripts/generate-color-tokens.test.mjs` fails
// when a generated file differs from what this script would write now.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repo = new URL("../", import.meta.url);
const THEME = "apps/web/src/styles/theme.css";
export const CATALOG_OUTPUT = "apps/catalog/src/tokens.generated.css";
export const EMAIL_OUTPUT = "apps/web/src/server/email-colors.generated.ts";
export const MANIFEST_OUTPUT = "apps/web/public/manifest.webmanifest";
const COMMAND = "bun run tokens:generate";

// What the catalog stylesheet reads. `--shadow-xs` is the one that does not live in `:root`: it is in `@theme` of
// theme.css, written over `--shadow-l`, `--shadow-c` and `--shadow-a`, which change with the theme.
const CATALOG_TOKENS = [
  "background",
  "foreground",
  "card",
  "muted",
  "muted-foreground",
  "accent",
  "border",
  "input",
  "ring",
  "mark",
  "card-ring",
  "card-glow",
  "shadow-l",
  "shadow-c",
  "shadow-a",
];
const CATALOG_THEME_VARIABLES = ["shadow-xs"];

// Token of theme.css (light theme) -> name of the constant in the e-mail module.
const EMAIL_TOKENS = {
  background: "card",
  foreground: "foreground",
  mutedForeground: "muted-foreground",
  primary: "primary",
  primaryForeground: "primary-foreground",
};

const DECLARATION = /^\s*--([\w-]+)\s*:\s*([\s\S]+?)\s*$/;
const PLAIN_OKLCH = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/;

function withoutComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The top-level blocks of a stylesheet: [{ selector, body }]. Nested blocks stay inside the body of their parent. */
function topLevelBlocks(css) {
  const blocks = [];
  let depth = 0;
  let selectorStart = 0;
  let bodyStart = 0;
  let selector = "";
  for (let index = 0; index < css.length; index += 1) {
    const char = css[index];
    if (char === "{") {
      if (depth === 0) {
        selector = css.slice(selectorStart, index).trim();
        bodyStart = index + 1;
      }
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        blocks.push({ body: css.slice(bodyStart, index), selector });
        selectorStart = index + 1;
      }
    } else if (char === ";" && depth === 0) {
      selectorStart = index + 1;
    }
  }
  return blocks;
}

/** The custom properties declared directly in a block body, in order: { name: value } (no leading dashes). */
function declarations(body) {
  const found = {};
  let depth = 0;
  let start = 0;
  for (let index = 0; index <= body.length; index += 1) {
    const char = body[index];
    if (char === "(" || char === "{") {
      depth += 1;
    } else if (char === ")" || char === "}") {
      depth -= 1;
    } else if ((char === ";" || index === body.length) && depth === 0) {
      const match = DECLARATION.exec(body.slice(start, index));
      if (match) {
        found[match[1]] = match[2].replace(/\s+/g, " ");
      }
      start = index + 1;
    }
  }
  return found;
}

/** The tokens of theme.css: `light` (`:root`), `dark` (`.dark`) and `theme` (the `@theme inline`-less `@theme` block). */
export function readTheme(css) {
  const blocks = topLevelBlocks(withoutComments(css));
  const one = (selector) => {
    const found = blocks.filter((candidate) => candidate.selector === selector);
    if (found.length !== 1) {
      throw new Error(`theme.css: expected one "${selector}" block`);
    }
    return declarations(found[0].body);
  };
  return { dark: one(".dark"), light: one(":root"), theme: one("@theme") };
}

function pick(source, names, where) {
  return Object.fromEntries(
    names.map((name) => {
      if (!(name in source)) {
        throw new Error(`theme.css: --${name} is missing in ${where}`);
      }
      return [name, source[name]];
    })
  );
}

function indented(indent, entries) {
  return entries
    .map(([name, value]) => `${indent}--${name}: ${value};`)
    .join("\n");
}

export function renderCatalogTokens(css) {
  const { dark, light, theme } = readTheme(css);
  const lightEntries = [
    ...Object.entries(pick(light, CATALOG_TOKENS, ":root")),
    ...Object.entries(pick(theme, CATALOG_THEME_VARIABLES, "@theme")),
  ];
  // Only what the dark theme overrides; the rest stays as in the light block.
  const darkEntries = CATALOG_TOKENS.filter((name) => name in dark).map(
    (name) => [name, dark[name]]
  );
  return `/*
 * Generated from ${THEME}. Do not edit.
 * To generate again: ${COMMAND}
 * The catalog follows prefers-color-scheme, so the dark values are in a media query, not in .dark.
 */

:root {
${indented("  ", lightEntries)}
}

@media (prefers-color-scheme: dark) {
  :root {
${indented("    ", darkEntries)}
  }
}
`;
}

/** OKLCH (L 0..1, C, h in degrees) to sRGB hex, clipped to the gamut. Björn Ottosson's matrices. */
export function oklchToHex(lightness, chroma, hue) {
  const radians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);
  const l = (lightness + 0.396_337_777_4 * a + 0.215_803_757_3 * b) ** 3;
  const m = (lightness - 0.105_561_345_8 * a - 0.063_854_172_8 * b) ** 3;
  const s = (lightness - 0.089_484_177_5 * a - 1.291_485_548 * b) ** 3;
  const linear = [
    4.076_741_662_1 * l - 3.307_711_591_3 * m + 0.230_969_929_2 * s,
    -1.268_438_004_6 * l + 2.609_757_401_1 * m - 0.341_319_396_5 * s,
    -0.004_196_086_3 * l - 0.703_418_614_7 * m + 1.707_614_701 * s,
  ];
  return `#${linear
    .map((value) => {
      const clipped = Math.min(1, Math.max(0, value));
      const encoded =
        clipped <= 0.003_130_8
          ? 12.92 * clipped
          : 1.055 * clipped ** (1 / 2.4) - 0.055;
      return Math.round(encoded * 255)
        .toString(16)
        .padStart(2, "0");
    })
    .join("")}`;
}

function hexOf(token, value) {
  const match = PLAIN_OKLCH.exec(value);
  if (!match) {
    throw new Error(
      `theme.css: --${token} is "${value}", not a plain oklch(L C h) (an e-mail needs an opaque color)`
    );
  }
  return oklchToHex(Number(match[1]), Number(match[2]), Number(match[3]));
}

export function renderEmailColors(css) {
  const { light } = readTheme(css);
  const lines = Object.entries(EMAIL_TOKENS).map(
    ([constant, token]) =>
      `  ${constant}: "${hexOf(token, pick(light, [token], ":root")[token])}", // --${token}`
  );
  return `// Generated from ${THEME}. Do not edit.
// To generate again: ${COMMAND}
// The light theme as sRGB hex: most e-mail clients read neither OKLCH nor CSS variables.

export const emailColors = {
${lines.join("\n")}
} as const;
`;
}

/** The manifest with its two colors set to the light --background; every other field stays as it is. */
export function renderManifest(css, manifestJson) {
  const { light } = readTheme(css);
  const hex = hexOf(
    "background",
    pick(light, ["background"], ":root").background
  );
  const manifest = JSON.parse(manifestJson);
  manifest.background_color = hex;
  manifest.theme_color = hex;
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function expectedFiles() {
  const css = readFileSync(new URL(THEME, repo), "utf8");
  return {
    [MANIFEST_OUTPUT]: renderManifest(
      css,
      readFileSync(new URL(MANIFEST_OUTPUT, repo), "utf8")
    ),
    [CATALOG_OUTPUT]: renderCatalogTokens(css),
    [EMAIL_OUTPUT]: renderEmailColors(css),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [path, content] of Object.entries(expectedFiles())) {
    writeFileSync(new URL(path, repo), content);
    console.log(`wrote ${path}`);
  }
}
