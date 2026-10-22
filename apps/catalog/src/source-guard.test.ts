import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The public catalog stays outside Tailwind and Base UI (ADR 0103, condition 7): one static stylesheet, one
 * local font, no inline style, no external link. These read the source of the app. Each rule is a function of
 * a text, and the control cases prove it fails on a planted violation, so a rule that stopped matching would
 * not pass silently.
 */
const root = new URL("../", import.meta.url).pathname;

function listFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

const FONT_URL = /^\.\/fonts\/[a-z0-9-]+\.woff2$/;
const AT_IMPORT = /@import/i;
const DARK_CLASS = /:root\.dark|\.dark\b/;
const HEX_COLOR = /#[0-9a-f]{3,8}\b/i;
const FUNCTION_COLOR = /\b(?:rgba?|hsla?)\(/i;
const ABSOLUTE_ADDRESS = /https?:|\/\/|data:/i;
const COMMENT = /\/\*[\s\S]*?\*\//g;
const URL_CALL = /url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi;
const LOCAL_FONT = /url\("\.\/fonts\/geist-latin-wght\.woff2"\)/;
const STYLESHEET_FILE = /\.(?:css|scss|less)$/;
const SOURCE_FILE = /\.(?:ts|tsx)$/;
const TEST_OR_TYPES = /\.(?:test|d)\.(?:ts|tsx)$/;
const FOOTER_CALL = /<Footer href=\{footerHref\} \/>/g;
const FOOTER_WITHOUT_HREF = /<Footer\b(?![^>]*\bhref=\{footerHref\})/;
const FOOTER_FROM_PROFILE = /footerHref=\{[^}]*profile/;
const PROFILE_TYPE = /export interface PublicCatalogProfile \{([^}]*)\}/;
const FIELD = /^\s*(\w+)\??:/gm;
const LINE_COMMENT = /^\s*\/\/.*$/gm;
const TRAILING_COMMA = /,(\s*[}\]])/g;

/** The problems of a stylesheet, as sentences. */
function stylesheetProblems(css: string): string[] {
  const problems: string[] = [];
  if (AT_IMPORT.test(css)) {
    problems.push("@import");
  }
  if (DARK_CLASS.test(css)) {
    problems.push("a .dark class (the app only follows prefers-color-scheme)");
  }
  if (HEX_COLOR.test(css) || FUNCTION_COLOR.test(css)) {
    problems.push("a color that is not OKLCH");
  }
  if (ABSOLUTE_ADDRESS.test(css.replace(COMMENT, ""))) {
    problems.push("an absolute, protocol-relative or data: address");
  }
  for (const match of css.matchAll(URL_CALL)) {
    if (!FONT_URL.test(match[2] ?? "")) {
      problems.push(`url(${match[2]}) is not the local font`);
    }
  }
  return problems;
}

const MARKUP_RULES: [string, RegExp][] = [
  ["a style attribute", /\bstyle\s*=/],
  ["dangerouslySetInnerHTML", /dangerouslySetInnerHTML/],
  ["innerHTML", /innerHTML/],
  ["a <style> element", /<style\b/i],
  [
    "an external <link>",
    /<link\b[^>]*\bhref\s*=\s*["'{`][^"'`}]*(?:https?:)?\/\//i,
  ],
  [
    "an external <script>",
    /<script\b[^>]*\bsrc\s*=\s*["'`]\s*(?:https?:)?\/\//i,
  ],
  ["an SVG <use>", /<use\b/],
  ["an SVG <image>", /<image\b/],
  ["an external import of CSS", /from\s+["']https?:/],
];

function markupProblems(source: string): string[] {
  return MARKUP_RULES.filter(([, rule]) => rule.test(source)).map(
    ([name]) => name
  );
}

const FORBIDDEN_PACKAGES = [
  /^tailwindcss$/,
  /^@tailwindcss\//,
  /^@base-ui(?:\/|-components\/)/,
  /^@base-ui$/,
  /^lucide-react$/,
  /^@fontsource(?:-variable)?\//,
  /^geist$/,
  /^@radix-ui\//,
];

function packageProblems(manifest: { [section: string]: unknown }): string[] {
  const names = [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ].flatMap((section) =>
    Object.keys((manifest[section] as Record<string, string> | undefined) ?? {})
  );
  return names.filter((name) =>
    FORBIDDEN_PACKAGES.some((rule) => rule.test(name))
  );
}

describe("the stylesheet of the catalog", () => {
  const css = readFileSync(join(root, "src/styles.css"), "utf8");

  it("is static: no @import, no .dark, only OKLCH, only the local font by url()", () => {
    expect(stylesheetProblems(css)).toEqual([]);
    // the font is there, so the url() rule had something to look at
    expect(css).toMatch(LOCAL_FONT);
  });

  it("is the one stylesheet: nothing else under src is CSS", () => {
    const sheets = listFiles(join(root, "src")).filter((path) =>
      STYLESHEET_FILE.test(path)
    );
    expect(sheets.map((path) => relative(root, path))).toEqual([
      "src/styles.css",
    ]);
  });

  it("keeps the font and its license together, outside public/", () => {
    const fonts = readdirSync(join(root, "src/fonts")).sort();
    expect(fonts).toEqual(["LICENSE", "geist-latin-wght.woff2"]);
    expect(readFileSync(join(root, "src/fonts/LICENSE"), "utf8")).toContain(
      "SIL Open Font License, Version 1.1"
    );
    expect(existsSync(join(root, "public/fonts"))).toBe(false);
  });

  it("control: a planted violation of each rule is caught", () => {
    expect(
      stylesheetProblems('@import url("https://x.example/a.css");')
    ).toContain("@import");
    expect(stylesheetProblems(":root.dark { color: red }").join()).toContain(
      ".dark"
    );
    expect(stylesheetProblems("a { color: #fff }").join()).toContain("OKLCH");
    expect(stylesheetProblems("a { color: rgb(0 0 0) }").join()).toContain(
      "OKLCH"
    );
    expect(stylesheetProblems("a { color: hsl(0 0% 0%) }").join()).toContain(
      "OKLCH"
    );
    expect(
      stylesheetProblems(
        'a { background: url("https://x.example/a.png") }'
      ).join()
    ).toContain("absolute");
    expect(
      stylesheetProblems('a { background: url("//x.example/a.png") }').join()
    ).toContain("absolute");
    expect(
      stylesheetProblems(
        'a { background: url("data:image/png;base64,AA") }'
      ).join()
    ).toContain("absolute");
    expect(
      stylesheetProblems('a { background: url("./img/a.png") }').join()
    ).toContain("not the local font");
    expect(
      stylesheetProblems("a { background: url(/fonts/a.woff2) }").join()
    ).toContain("not the local font");
    expect(
      stylesheetProblems('@font-face { src: url("./fonts/a.woff2") }')
    ).toEqual([]);
  });
});

describe("the components and routes of the catalog", () => {
  const files = listFiles(join(root, "src")).filter(
    (path) =>
      SOURCE_FILE.test(path) &&
      !TEST_OR_TYPES.test(path) &&
      !path.endsWith("routeTree.gen.ts")
  );

  it("has files to look at", () => {
    expect(files.some((path) => path.endsWith("views.tsx"))).toBe(true);
    expect(files.some((path) => path.endsWith("routes/__root.tsx"))).toBe(true);
  });

  it("has no inline style, injected HTML, <style> or external <link>", () => {
    const found = files.flatMap((path) =>
      markupProblems(readFileSync(path, "utf8")).map(
        (problem) => `${relative(root, path)}: ${problem}`
      )
    );
    expect(found).toEqual([]);
  });

  it("imports no Tailwind, Base UI, icon library or font package", () => {
    const found = files.flatMap((path) =>
      [...readFileSync(path, "utf8").matchAll(/from\s+["']([^"']+)["']/g)]
        .map((match) => match[1] ?? "")
        .filter((name) => FORBIDDEN_PACKAGES.some((rule) => rule.test(name)))
        .map((name) => `${relative(root, path)}: ${name}`)
    );
    expect(found).toEqual([]);
  });

  it("control: a planted violation of each rule is caught", () => {
    const planted: [string, string][] = [
      ['<p style={{ color: "red" }} />', "a style attribute"],
      [
        "<p dangerouslySetInnerHTML={{ __html: x }} />",
        "dangerouslySetInnerHTML",
      ],
      ["el.innerHTML = x", "innerHTML"],
      ["<style>{css}</style>", "a <style> element"],
      [
        '<link rel="stylesheet" href="https://x.example/a.css" />',
        "an external <link>",
      ],
      [
        '<link rel="stylesheet" href="//x.example/a.css" />',
        "an external <link>",
      ],
      ['<script src="https://x.example/a.js" />', "an external <script>"],
      ['<svg><use href="/sprite.svg#a" /></svg>', "an SVG <use>"],
      ['<svg><image href="/a.png" /></svg>', "an SVG <image>"],
    ];
    for (const [source, expected] of planted) {
      expect(markupProblems(source), source).toContain(expected);
    }
    expect(markupProblems('<a href="/x" className="btn">ok</a>')).toEqual([]);
  });
});

describe("the manifest of the catalog", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

  it("has no Tailwind, Base UI, lucide-react or font package", () => {
    expect(packageProblems(manifest)).toEqual([]);
  });

  it("control: a planted dependency of each kind is caught", () => {
    for (const name of [
      "tailwindcss",
      "@tailwindcss/vite",
      "@base-ui/react",
      "lucide-react",
      "@fontsource-variable/geist",
      "@fontsource/geist",
    ]) {
      expect(packageProblems({ devDependencies: { [name]: "1.0.0" } })).toEqual(
        [name]
      );
    }
  });
});

describe("the footer cannot be switched off (AC-10)", () => {
  const views = readFileSync(join(root, "src/views.tsx"), "utf8");

  it("is rendered by each of the four pages, with only the address as input", () => {
    for (const view of [
      "StoreView",
      "ProductView",
      "HomeView",
      "NotFoundView",
    ]) {
      expect(views, view).toContain(`export function ${view}`);
    }
    // the store and the product page render it themselves; home, not found and the error go through Notice
    expect(views.match(FOOTER_CALL)).toHaveLength(3);
    expect(views).not.toMatch(FOOTER_WITHOUT_HREF);
    expect(views).not.toMatch(FOOTER_FROM_PROFILE);
  });

  it("has no field of the public profile that could switch it off", () => {
    const reader = readFileSync(
      join(root, "../../packages/db/src/public-catalog-reader.ts"),
      "utf8"
    );
    const body = PROFILE_TYPE.exec(reader)?.[1] ?? "";
    const fields = [...body.matchAll(FIELD)].map((match) => match[1]);
    expect(fields.sort()).toEqual([
      "description",
      "instagram",
      "name",
      "slug",
      "whatsapp",
    ]);
  });
});

describe("POLARIS_SITE_URL by environment (AC-11)", () => {
  it("is declared empty at the top level, in staging and in production", () => {
    const raw = readFileSync(join(root, "wrangler.jsonc"), "utf8");
    const config = JSON.parse(
      raw.replace(LINE_COMMENT, "").replace(TRAILING_COMMA, "$1")
    ) as {
      env: Record<string, { vars: Record<string, string> }>;
      vars: Record<string, string>;
    };
    expect(config.vars.POLARIS_SITE_URL).toBe("");
    expect(config.env.staging.vars.POLARIS_SITE_URL).toBe("");
    expect(config.env.production.vars.POLARIS_SITE_URL).toBe("");
  });
});
