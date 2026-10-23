import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
// `&#8212;` (an entity) and `href="#add-item"` (an anchor) are not colors: a hex needs to stand alone
const NOT_OKLCH =
  /(?<![&\w])#[0-9a-fA-F]{3,8}(?![-\w])|\b(?:rgba?|hsla?|hwb|lab|lch|color)\(/;
// `oklch(from currentColor …)` derives from a token: it is not a literal
const OKLCH_LITERAL = /\boklch\((?!from\b)/;
// the alpha mask of the scroll fade (a vendored sheet) is black by definition, the `#000` of the original: not a color on screen
const MASK_SHEET = "src/styles/shadcn-tailwind.css";
const MASK = /\boklch\(0 0 0\)/g;
// every CSS color name, whole word (`--white` and `white-space` are not colors)
const KEYWORD_COLORS =
  "aliceblue|antiquewhite|aqua|aquamarine|azure|beige|bisque|black|blanchedalmond|blue|blueviolet|brown|burlywood|cadetblue|chartreuse|chocolate|coral|cornflowerblue|cornsilk|crimson|cyan|darkblue|darkcyan|darkgoldenrod|darkgray|darkgreen|darkgrey|darkkhaki|darkmagenta|darkolivegreen|darkorange|darkorchid|darkred|darksalmon|darkseagreen|darkslateblue|darkslategray|darkslategrey|darkturquoise|darkviolet|deeppink|deepskyblue|dimgray|dimgrey|dodgerblue|firebrick|floralwhite|forestgreen|fuchsia|gainsboro|ghostwhite|gold|goldenrod|gray|green|greenyellow|grey|honeydew|hotpink|indianred|indigo|ivory|khaki|lavender|lavenderblush|lawngreen|lemonchiffon|lightblue|lightcoral|lightcyan|lightgoldenrodyellow|lightgray|lightgreen|lightgrey|lightpink|lightsalmon|lightseagreen|lightskyblue|lightslategray|lightslategrey|lightsteelblue|lightyellow|lime|limegreen|linen|magenta|maroon|mediumaquamarine|mediumblue|mediumorchid|mediumpurple|mediumseagreen|mediumslateblue|mediumspringgreen|mediumturquoise|mediumvioletred|midnightblue|mintcream|mistyrose|moccasin|navajowhite|navy|oldlace|olive|olivedrab|orange|orangered|orchid|palegoldenrod|palegreen|paleturquoise|palevioletred|papayawhip|peachpuff|peru|pink|plum|powderblue|purple|rebeccapurple|red|rosybrown|royalblue|saddlebrown|salmon|sandybrown|seagreen|seashell|sienna|silver|skyblue|slateblue|slategray|slategrey|snow|springgreen|steelblue|tan|teal|thistle|tomato|turquoise|violet|wheat|white|whitesmoke|yellow|yellowgreen";
const COLOR_KEYWORD = new RegExp(
  `(?:^|[;{\\s"'])(?:color|background(?:-color)?|border(?:-[a-z]+)?(?:-color)?|outline(?:-color)?|box-shadow|text-shadow|fill|stroke|caret-color|accent-color|text-decoration(?:-color)?)\\s*[:=]\\s*["']?[^;{}"']*(?<![-\\w])(?:${KEYWORD_COLORS})(?![-\\w])`,
  "m"
);
const PALETTE_PREFIX =
  "bg|text|border(?:-[trblxyse])?|ring(?:-offset)?|outline|fill|stroke|from|to|via|divide|shadow|accent|caret|decoration|placeholder|inset-ring|inset-shadow";
const PALETTE_HUE =
  "white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\\d{2,3}";
// `bg-white`, `!bg-white`, `bg-white!`, `hover:bg-white/50`, `bg-white/[0.5]`
const PALETTE = new RegExp(
  `(?:^|[\\s"'\`:!])(?:${PALETTE_PREFIX})-(?:${PALETTE_HUE})(?:/(?:\\d+|\\[[^\\]]*\\]))?!?(?=[\\s"'\`]|$)`,
  "m"
);
const SOURCE_FILE = /\.(?:css|tsx?)$/;
const TEST_FILE = /\.test\.tsx?$/;
const TOKEN_SPLIT = /[\s"'`]+/;
const MOVING = /^(?:.*:)?(?:zoom-(?:in|out)|slide-(?:in|out)-from)-/;
const ENTRY_OR_EXIT_VARIANT =
  /(?:^|:)(?:data-(?:\[(?:open|closed|starting-style|ending-style)\]|open|closed|starting-style|ending-style)|starting|in|out)(?=:)/;
const MOVES_A_BOX = /(?:^|:)-?(?:translate|scale|rotate)(?:-|$)/;
// the one slide that stays: the toast leaving in the direction of the gesture that dismissed it
const TOAST_SWIPE =
  /^data-\[ending-style\]:data-\[swipe-direction=(?:up|down|left|right)\]:-?translate-[xy]-\d+$/;
const ANIMATE_UTILITY = /^(?:.*:)?animate-([a-z-]+)$/;
// the fades the base allows: tw-animate-css's `in` and `out` (with `fade-in-0`, never with zoom or slide), none, `rise`
// and `pulse` (the skeleton of a page that loads; Tailwind's keyframes of it move only the opacity, which a test reads)
const FADES = new Set(["in", "out", "none", "pulse", "rise"]);
const SHIMMER = /(?:^|[\s"'`:])shimmer(?:-[a-z]+)?(?=[\s"'`]|$)/;
// the sheets that may define animations: the tokens and the vendored shadcn sheet; the others only use the fades
const ANIMATION_SHEETS = [TOKEN_SHEET, MASK_SHEET];
const OWN_ANIMATION = /@keyframes\b|\banimation(?:-name)?\s*:/;
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
  const withoutMask = path === MASK_SHEET ? code.replace(MASK, "") : code;
  if (path !== TOKEN_SHEET && OKLCH_LITERAL.test(withoutMask)) {
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
      !TOAST_SWIPE.test(token)
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
  if (
    path.endsWith(".css") &&
    !ANIMATION_SHEETS.includes(path) &&
    OWN_ANIMATION.test(code)
  ) {
    faults.push(
      "animação própria em CSS novo (@keyframes ou animation): use as utilidades de desvanecer"
    );
  }
  return faults;
}

const sourcesUnder = (dir: string): string[] => {
  const root = join(web, dir);
  if (!existsSync(root)) {
    return [];
  }
  if (statSync(root).isFile()) {
    return [dir];
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

  it("o `pulse` do esqueleto, do Tailwind, mexe só na opacidade", () => {
    const sheet = readFileSync(
      join(web, "node_modules/tailwindcss/theme.css"),
      "utf8"
    );
    const pulse = [...sheet.matchAll(KEYFRAMES)].find(
      (frames) => frames[1] === "pulse"
    );
    expect(pulse).toBeDefined();
    const properties = new Set(
      [...(pulse?.[2] ?? "").matchAll(DECLARED_PROPERTY)].map(
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
    ["border: 1px solid red;", "cor por nome"],
    ["box-shadow: 0 0 0 3px lightgray;", "cor por nome"],
    ['style={{ color: "white" }}', "cor por nome"],
    ['<path fill="rebeccapurple" />', "cor por nome"],
    ['className="bg-white!"', "classe da paleta"],
    ['className="!bg-white"', "classe da paleta"],
    ['className="border-t-red-500 p-2"', "classe da paleta"],
    ['className="hover:bg-white/[0.5]"', "classe da paleta"],
    ['className="ring-offset-white"', "classe da paleta"],
    ["color: color(srgb 1 0 0);", "cor fora do OKLCH"],
    ["background: oklch(0 0 0);", "literal oklch"],
    [
      'className="data-[swipe-direction=left]:data-open:scale-95"',
      "translate, scale ou rotate",
    ],
  ])("%s", (text, fault) => {
    expect(faultsOf(text).join("\n")).toContain(fault);
  });

  it.each([
    "@keyframes pulso { to { opacity: 0.5 } }",
    ".x { animation: pulso 1s infinite }",
    ".x { animation-name: pulso }",
  ])("%s num CSS novo é reprovado", (text) => {
    expect(faultsOf(text, "src/ui/x.css").join("\n")).toContain(
      "animação própria"
    );
    expect(faultsOf(text, "src/styles/theme.css")).toEqual([]);
  });

  it.each([
    ["color: oklch(0.2 0.01 85);", "src/styles/theme.css"],
    [
      "mask-image: linear-gradient(oklch(0 0 0), transparent);",
      "src/styles/shadcn-tailwind.css",
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
    ['className="animate-pulse rounded-md bg-muted"', "src/ui/x.tsx"],
    [
      'className="data-[ending-style]:data-[swipe-direction=right]:translate-x-6"',
      "src/ui/x.tsx",
    ],
    [
      "/* #fff and rgb(0 0 0) in a comment */ color: var(--ink);",
      "src/ui/x.css",
    ],
    ["background: oklch(from currentColor l c h / 20%);", "src/styles/x.css"],
    ["<p>Pre&#8212;ço</p>", "src/ui/x.tsx"],
    ['<a href="#add-item">Adicionar</a>', "src/ui/x.tsx"],
    ["white-space: nowrap; --white: 1; color: var(--white);", "src/ui/x.css"],
    ['className="bg-white-glove text-red-hot"', "src/ui/x.tsx"],
    ["@keyframes rise { to { opacity: 1 } }", "src/styles/theme.css"],
  ])("%s passa", (text, path) => {
    expect(faultsOf(text, path)).toEqual([]);
  });
});
