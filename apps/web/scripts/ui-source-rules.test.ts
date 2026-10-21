import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SCREENS } from "../e2e-pwa/ui-screens";

/**
 * Source rules of the interface guardrails (t180, items 4 and 5): what the review of the CSS and the classes finds
 * by reading, a test reads. They run on `src/ui`, on `src/styles` and on the source folders of every migrated
 * screen (`sourceDirs` in e2e-pwa/ui-screens.ts); the measured checks (overflow, touch, axe, motion, focus) are in
 * e2e-pwa/ui-guardrails.e2e.ts. Each rule has a control case: `sourceFaults` runs on a text that has the fault.
 *
 * 4. only OKLCH and only tokens: no `#hex`, `rgb(`, `hsl(` and the like; no color keyword nor Tailwind palette
 *    class; an `oklch(…)` literal lives only in the token sheet (`src/styles/theme.css`).
 * 5. motion: no `zoom-*`, `slide-*`, `translate`, `scale` or `rotate` in an entry or exit state, no animation
 *    that is not a fade; and the sheet of the base zeroes every animation under `prefers-reduced-motion: reduce`.
 */
const web = fileURLToPath(new URL("..", import.meta.url));

/** Old sheets, outside the rules until their screens are migrated; the test fails when one of them is clean. */
const LEGACY_SHEETS = ["src/styles/tokens.css", "src/styles/ui.css"];
/** The one sheet that may write an `oklch(…)` literal: the tokens. */
const TOKEN_SHEET = "src/styles/theme.css";

// a `//` comment starts a line or follows a space, so the `//` of a URL inside a string is not one
const COMMENT = /\/\*[\s\S]*?\*\/|(?:^|\s)\/\/[^\n]*/gm;
const NOT_OKLCH = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch)\(/;
// `oklch(from currentColor …)` derives from a token: it is not a literal
const OKLCH_LITERAL = /\boklch\((?!from\b)/;
// the alpha mask of the scroll fade is black by definition (`#000` of the original): not a color on screen
const MASK = /\boklch\(0 0 0\)/g;
const KEYWORD_COLORS =
  "white|black|red|green|blue|yellow|orange|purple|pink|gray|grey|silver|maroon|navy|teal|aqua|lime|olive|fuchsia";
const COLOR_KEYWORD = new RegExp(
  `(?:^|[;{\\s])(?:color|background(?:-color)?|border(?:-[a-z]+)?-color|outline-color|fill|stroke|caret-color|accent-color|text-decoration-color)\\s*:\\s*(?:${KEYWORD_COLORS})\\b`,
  "m"
);
const PALETTE =
  /(?:^|[\s"'`:])(?:bg|text|border|ring|outline|fill|stroke|from|to|via|divide|shadow|accent|caret|decoration|placeholder)-(?:white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3})(?:\/\d+)?(?=[\s"'`]|$)/m;
const SOURCE_FILE = /\.(?:css|tsx?)$/;
const TEST_FILE = /\.test\.tsx?$/;
const TOKEN_SPLIT = /[\s"'`]+/;
const MOVING = /^(?:.*:)?(?:zoom-(?:in|out)|slide-(?:in|out)-from)-/;
const ENTRY_OR_EXIT_VARIANT =
  /(?:^|:)(?:data-(?:\[(?:open|closed|starting-style|ending-style)\]|open|closed|starting-style|ending-style)|starting|in|out)(?=:)/;
const MOVES_A_BOX = /(?:^|:)-?(?:translate|scale|rotate)(?:-|$)/;
const SWIPE = "data-[swipe-direction=";
const ANIMATE_UTILITY = /^(?:.*:)?animate-([a-z-]+)$/;
// the fades the base allows: tw-animate-css's `in` and `out` (with `fade-in-0`, never with zoom or slide), none, and `rise`
const FADES = new Set(["in", "out", "none", "rise"]);
const SHIMMER = /(?:^|[\s"'`:])shimmer(?:-[a-z]+)?(?=[\s"'`]|$)/;
const KEYFRAMES = /@keyframes\s+([\w-]+)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g;
const DECLARED_PROPERTY = /([a-z-]+)\s*:/g;

const withoutComments = (text: string) => text.replace(COMMENT, "");

/** The faults of items 4 and 5 that a file's text has; the path says whether it is the token sheet. */
export function sourceFaults(path: string, text: string) {
  const code = withoutComments(text);
  const faults: string[] = [];
  if (NOT_OKLCH.test(code)) {
    faults.push("cor fora do OKLCH (#hex, rgb(, hsl(…)");
  }
  if (path !== TOKEN_SHEET && OKLCH_LITERAL.test(code.replace(MASK, ""))) {
    faults.push("literal oklch(…) fora do arquivo de tokens");
  }
  if (COLOR_KEYWORD.test(code)) {
    faults.push("cor por nome (white, red…) em vez de token");
  }
  if (PALETTE.test(code)) {
    faults.push(
      "classe da paleta do Tailwind (bg-white, text-red-500…) em vez de token"
    );
  }
  for (const token of code.split(TOKEN_SPLIT)) {
    if (MOVING.test(token)) {
      faults.push(`${token}: a interface só desvanece, sem zoom nem slide`);
    } else if (
      ENTRY_OR_EXIT_VARIANT.test(token) &&
      MOVES_A_BOX.test(token) &&
      !token.includes(SWIPE)
    ) {
      faults.push(
        `${token}: translate, scale ou rotate numa entrada ou saída (só opacidade; o deslize do gesto do aviso é a exceção)`
      );
    }
    const animation = ANIMATE_UTILITY.exec(token)?.[1];
    if (animation && !FADES.has(animation)) {
      faults.push(`animate-${animation}: não é um desvanecer permitido`);
    }
  }
  if (path.endsWith(".tsx") && SHIMMER.test(code)) {
    faults.push("shimmer anima o fundo, não só a opacidade");
  }
  return faults;
}

const sourcesUnder = (dir: string): string[] => {
  const root = join(web, dir);
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      return sourcesUnder(path);
    }
    return SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)
      ? [path]
      : [];
  });
};

const migrated = SCREENS.filter((screen) => screen.status === "migrated");
const SCOPE = [
  ...new Set([
    ...sourcesUnder("src/ui"),
    ...sourcesUnder("src/styles"),
    ...migrated.flatMap((screen) => screen.sourceDirs.flatMap(sourcesUnder)),
  ]),
].filter((path) => !LEGACY_SHEETS.includes(path));

const read = (path: string) => readFileSync(join(web, path), "utf8");

describe("regras de fonte da interface (t180, itens 4 e 5)", () => {
  it("cobre a base, os estilos e as pastas das telas migradas", () => {
    expect(SCOPE).toEqual(
      expect.arrayContaining([
        "src/ui/button.tsx",
        "src/ui/dialog.tsx",
        "src/styles/theme.css",
        "src/ui-gallery/ui-gallery.tsx",
      ])
    );
    for (const screen of migrated) {
      expect(screen.sourceDirs.length, screen.name).toBeGreaterThan(0);
      expect(
        screen.known,
        `${screen.name} migrada não tem falha conhecida`
      ).toBeUndefined();
      for (const dir of screen.sourceDirs) {
        expect(existsSync(join(web, dir)), dir).toBe(true);
      }
    }
  });

  it.each(SCOPE)("%s: só OKLCH, só tokens, só desvanece", (path) => {
    expect(sourceFaults(path, read(path))).toEqual([]);
  });

  it.each(LEGACY_SHEETS)(
    "%s ainda tem o que a regra reprova (ao migrar, saia desta lista)",
    (path) => {
      expect(sourceFaults(path, read(path)).length).toBeGreaterThan(0);
    }
  );

  it("o desvanecer `rise` mexe só na opacidade", () => {
    const sheet = withoutComments(read(TOKEN_SHEET));
    const rise = [...sheet.matchAll(KEYFRAMES)].find(
      (frames) => frames[1] === "rise"
    );
    expect(rise).toBeDefined();
    const properties = new Set(
      [...(rise?.[2] ?? "").matchAll(DECLARED_PROPERTY)].map(
        (property) => property[1]
      )
    );
    expect(properties.has("opacity")).toBe(true);
    expect([...properties].filter((name) => name !== "opacity")).toEqual([]);
  });

  it("com prefers-reduced-motion: reduce a base zera animação e transição (a medida está em e2e-pwa)", () => {
    const sheet = withoutComments(read(TOKEN_SHEET));
    const block = sheet.slice(
      sheet.indexOf("@media (prefers-reduced-motion: reduce)")
    );
    expect(block).toContain("animation-duration: 0.01ms !important");
    expect(block).toContain("animation-iteration-count: 1 !important");
    expect(block).toContain("transition-duration: 0.01ms !important");
    expect(block).toContain("::before");
    expect(block).toContain("::after");
  });
});

describe("controle: as regras de fonte pegam o que existem para pegar", () => {
  const faultsOf = (text: string, path = "src/ui/x.tsx") =>
    sourceFaults(path, text);

  it.each([
    ["color: #fff;", "cor fora do OKLCH"],
    ["background: rgb(0 0 0 / 40%);", "cor fora do OKLCH"],
    ["color: hsl(10 20% 30%);", "cor fora do OKLCH"],
    ['className="bg-[#0f0] p-2"', "cor fora do OKLCH"],
    ["color: oklch(0.2 0.01 85);", "literal oklch"],
    ["border-color: red;", "cor por nome"],
    ['className="text-red-500 p-2"', "classe da paleta"],
    ['className="bg-white"', "classe da paleta"],
    ['className="data-open:zoom-in-95"', "zoom nem slide"],
    ['className="data-[side=top]:slide-in-from-bottom-2"', "zoom nem slide"],
    ['className="data-open:translate-y-2"', "translate, scale ou rotate"],
    ['className="data-[ending-style]:scale-95"', "translate, scale ou rotate"],
    [
      'className="data-starting-style:-translate-x-4"',
      "translate, scale ou rotate",
    ],
    ['className="animate-bounce"', "não é um desvanecer"],
    ['className="shimmer"', "shimmer"],
  ])("%s", (text, fault) => {
    expect(faultsOf(text).join("\n")).toContain(fault);
  });

  it.each([
    ["color: oklch(0.2 0.01 85);", "src/styles/theme.css"],
    [
      "mask-image: linear-gradient(oklch(0 0 0), transparent);",
      "src/styles/x.css",
    ],
    [
      "background: color-mix(in oklch, var(--mark) 24%, transparent);",
      "src/ui/x.tsx",
    ],
    ["color: var(--foreground); background: transparent;", "src/ui/x.tsx"],
    ['className="-translate-x-1/2 translate-y-0.5 size-4"', "src/ui/x.tsx"],
    [
      'className="data-open:fade-in-0 data-closed:fade-out-0 animate-in animate-out"',
      "src/ui/x.tsx",
    ],
    [
      'className="data-[ending-style]:data-[swipe-direction=right]:translate-x-6"',
      "src/ui/x.tsx",
    ],
    [
      "/* #fff and rgb(0 0 0) in a comment */ color: var(--ink);",
      "src/ui/x.css",
    ],
    ["background: oklch(from currentColor l c h / 20%);", "src/styles/x.css"],
  ])("%s passa", (text, path) => {
    expect(faultsOf(text, path)).toEqual([]);
  });
});
