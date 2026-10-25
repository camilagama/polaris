import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SCREENS } from "../e2e-pwa/ui-screens";

/**
 * Source rules of the interface guardrails (t180, items 4 and 5): what the review of the CSS and the classes finds
 * by reading, a test reads. They run on `src/ui`, on `src/styles` and on the source folders of every
 * screen (`sourceDirs` in e2e-pwa/ui-screens.ts); the measured checks (overflow, touch, axe, motion, focus) are in
 * e2e-pwa/ui-guardrails.e2e.ts. Each rule has a control case: `sourceFaults` runs on a text that has the fault.
 *
 * 4. only OKLCH and only tokens: no `#hex`, `rgb(`, `hsl(` and the like; no color keyword nor Tailwind palette
 *    class; an `oklch(…)` literal lives only in the token sheet (`src/styles/theme.css`).
 * 5. motion: the components use the animation they bring (shadcn, Bklit UI); the CSS of an animation lives only in
 *    the sheets of the base; and the sheet of the base zeroes every animation under `prefers-reduced-motion: reduce`.
 *    On the phone (t386, ADR 0103 "Níveis de movimento") only the essential motion runs: every `animate-*`,
 *    `transition*` and `duration-*` class is under the `motion-full:` variant or in `ESSENTIAL_MOTION`, with its reason.
 */
const web = fileURLToPath(new URL("..", import.meta.url));

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
// the sheets that may define animations: the tokens and the vendored shadcn sheet; the others use the utilities of tw-animate-css
const ANIMATION_SHEETS = [TOKEN_SHEET, MASK_SHEET];
const OWN_ANIMATION = /@keyframes\b|\banimation(?:-name)?\s*:/;

const withoutComments = (text: string) => text.replace(COMMENT, "");

/**
 * The motion that stays on the phone (`data-motion="essential"`), from the inventory of the Petković (25/10): the
 * file, the class and why. Anything else that animates is written `motion-full:…` and runs only at the `full` level. A
 * new animation fails here until someone decides whether it is essential. Two essentials have no class of ours: the
 * toast follows the finger by the inline transform of the Base UI while it is dragged, and the tooltip of a chart
 * follows it by the pointer events of the Bklit (with `damping: 0` off `full`: it jumps from point to point); the row
 * of pills scrolls to a pill with `scrollIntoView` and no smoothing (`behavior: "auto"`).
 */
export const ESSENTIAL_MOTION: readonly {
  file: string;
  token: string;
  why: string;
}[] = [
  {
    file: "src/ui/button.tsx",
    token: "transition-[transform]",
    why: "o estado pressionado (escala 0,98) é o único retorno do toque antes da resposta",
  },
  {
    file: "src/ui/skeleton.tsx",
    token: "animate-pulse",
    why: "nas listas carregando o texto é sr-only: o pulso é o único sinal visível de que a tela espera",
  },
  {
    file: "src/ui/bklit/charts/tooltip/tooltip-content.tsx",
    token: "transition-opacity",
    why: "não é movimento: a opacidade do bloco de baixo do tooltip do Bklit nunca muda (código do registry, sem mudança)",
  },
  {
    file: "src/ui/bklit/charts/tooltip/tooltip-content.tsx",
    token: "duration-200",
    why: "a duração da transição de cima, que não move nada",
  },
];

/** An `animate-*`, `transition*` or `duration-*` utility that moves something (`animate-none`, `transition-none` stop it). */
const MOTION_UTILITY =
  /^(?:animate-(?!none$)|transition(?:$|-(?!none$))|duration-)/;
/** A string of a source, where the classes are: between double quotes, single quotes or backticks. */
const STRING = /"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g;
const SPACES = /\s+/;

/** The words of the strings of a source: the classes, among other words. */
const classTokens = (text: string) =>
  [...withoutComments(text).matchAll(STRING)].flatMap((match) =>
    (match[1] ?? match[2] ?? match[3] ?? "").split(SPACES).filter(Boolean)
  );

/** The motion classes of a source that run on the phone without being listed as essential (t386). */
export function phoneMotionFaults(path: string, text: string): string[] {
  if (!path.endsWith(".tsx")) {
    return [];
  }
  const faults = new Set<string>();
  for (const token of classTokens(text)) {
    // the utility is what follows the last variant (`data-open:animate-in` → `animate-in`); a `:` inside brackets is
    // part of an arbitrary value, not a variant
    const variants = token.replace(/\[[^\]]*\]/g, (part) =>
      part.replaceAll(":", "_")
    );
    const utility = variants.slice(variants.lastIndexOf(":") + 1);
    if (!MOTION_UTILITY.test(utility.replace(/^!|!$/g, ""))) {
      continue;
    }
    if (variants.split(":").includes("motion-full")) {
      continue;
    }
    if (
      ESSENTIAL_MOTION.some(
        (entry) => entry.file === path && entry.token === token
      )
    ) {
      continue;
    }
    faults.add(
      `movimento no celular sem motion-full: nem ESSENTIAL_MOTION: ${token}`
    );
  }
  return [...faults];
}

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
  if (
    path.endsWith(".css") &&
    !ANIMATION_SHEETS.includes(path) &&
    OWN_ANIMATION.test(code)
  ) {
    faults.push(
      "animação própria em CSS novo (@keyframes ou animation): use as utilidades do tw-animate-css"
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

const SCOPE = [
  ...new Set([
    ...sourcesUnder("src/ui"),
    ...sourcesUnder("src/styles"),
    ...SCREENS.flatMap((screen) => screen.sourceDirs.flatMap(sourcesUnder)),
  ]),
];

const read = (path: string) => readFileSync(join(web, path), "utf8");

/** The motion of the phone is read in every component of the app, not only in the folders of the measured screens. */
const MOTION_SCOPE = sourcesUnder("src").filter((path) =>
  path.endsWith(".tsx")
);

describe("regras de fonte da interface (t180, itens 4 e 5)", () => {
  it("cobre a base, os estilos e as pastas das telas", () => {
    expect(SCOPE).toEqual(
      expect.arrayContaining([
        "src/ui/button.tsx",
        "src/ui/dialog.tsx",
        "src/styles/theme.css",
        "src/ui-gallery/ui-gallery.tsx",
      ])
    );
    for (const screen of SCREENS) {
      expect(screen.sourceDirs.length, screen.name).toBeGreaterThan(0);
      for (const dir of screen.sourceDirs) {
        expect(existsSync(join(web, dir)), dir).toBe(true);
      }
    }
  });

  it.each(SCOPE)("%s: só OKLCH, só tokens", (path) => {
    expect(sourceFaults(path, read(path))).toEqual([]);
  });

  it.each(MOTION_SCOPE)(
    "%s: no celular só anima o essencial (motion-full: ou ESSENTIAL_MOTION)",
    (path) => {
      expect(phoneMotionFaults(path, read(path))).toEqual([]);
    }
  );

  it("cada entrada de ESSENTIAL_MOTION ainda está no arquivo dela (uma lista velha deixaria passar outra coisa)", () => {
    for (const entry of ESSENTIAL_MOTION) {
      expect(MOTION_SCOPE, entry.file).toContain(entry.file);
      expect(
        classTokens(read(entry.file)),
        `${entry.file}: ${entry.token}`
      ).toContain(entry.token);
    }
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
  ])("%s", (text, fault) => {
    expect(faultsOf(text).join("\n")).toContain(fault);
  });

  it.each([
    [
      'className="data-open:animate-in data-closed:animate-out"',
      "src/ui/x.tsx",
    ],
    [
      'cn("grid", open && "transition-[grid-template-rows,opacity]")',
      "src/ui/x.tsx",
    ],
    ['className="transition duration-200"', "src/ui/x.tsx"],
    ['className="has-[>[data-slot=x]]:transition-colors"', "src/ui/x.tsx"],
    // essential only where the inventory put it
    ['className="animate-pulse"', "src/ui/x.tsx"],
  ])("%s em %s anima no celular e é reprovado", (text, path) => {
    expect(phoneMotionFaults(path, text).join("\n")).toContain(
      "movimento no celular"
    );
  });

  it.each([
    [
      'className="motion-full:data-open:animate-in motion-full:duration-100"',
      "src/ui/x.tsx",
    ],
    [
      'className="animate-none transition-none motion-reduce:transition-none"',
      "src/ui/x.tsx",
    ],
    ['className="animate-pulse rounded-md"', "src/ui/skeleton.tsx"],
    ["<Area animate={false} transition={transition} />", "src/ui/x.tsx"],
    ["/* data-open:animate-in in a comment */", "src/ui/x.tsx"],
    ['className="data-open:animate-in"', "src/ui/x.css"],
  ])("%s em %s passa", (text, path) => {
    expect(phoneMotionFaults(path, text)).toEqual([]);
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
      'className="data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-[side=top]:slide-in-from-bottom-2 animate-bounce"',
      "src/ui/x.tsx",
    ],
    ['className="animate-pulse rounded-md bg-muted"', "src/ui/x.tsx"],
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
