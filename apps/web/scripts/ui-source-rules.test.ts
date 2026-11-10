import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SCREENS } from "../e2e-pwa/ui-screens";

/**
 * Source rules of the interface guardrails (items 4 and 5): what the review of the CSS and the classes finds
 * by reading, a test reads. They run on `src/ui`, on `src/styles` and on the source folders of every
 * screen (`sourceDirs` in e2e-pwa/ui-screens.ts); the measured checks (overflow, touch, axe, motion, focus) are in
 * e2e-pwa/ui-guardrails.e2e.ts. Each rule has a control case: `sourceFaults` runs on a text that has the fault.
 *
 * 4. only OKLCH and only tokens: no `#hex`, `rgb(`, `hsl(` and the like; no color keyword nor Tailwind palette
 *    class; an `oklch(…)` literal lives only in the token sheet (`packages/ui/src/theme.css`).
 * 5. motion: the components use the animation they bring (shadcn, Bklit UI); the CSS of an animation lives only in
 *    the sheets of the base; and the sheet of the base zeroes every animation under `prefers-reduced-motion: reduce`.
 *    On the phone (ADR 0103 "Níveis de movimento") only the essential motion runs: every `animate-*`,
 *    `transition*` and `duration-*` class of the `.ts` and `.tsx` of `src/` is under the `motion-full:` variant or
 *    in `ESSENTIAL_MOTION` (the four of the inventory) or `INERT_MOTION` (moves nothing), with its reason.
 */
const web = fileURLToPath(new URL("..", import.meta.url));

/** The one sheet that may write an `oklch(…)` literal: the tokens. */
const TOKEN_SHEET = "../../packages/ui/src/theme.css";

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
 * The motion that stays on the phone (`data-motion="essential"`), the four essentials of the inventory
 * (the fifth, the row of pills scrolling to the pill, left when the row began to wrap): the file, what in it makes the motion (`source`, a class or a piece of code) and why. A motion class listed
 * here is allowed off `motion-full:`; anything else that animates is written `motion-full:…` and runs only at the
 * `full` level, and a new animation fails here until someone decides whether it is essential.
 */
export const ESSENTIAL_MOTION: readonly {
  file: string;
  source: string;
  why: string;
}[] = [
  {
    file: "src/ui/button.tsx",
    source: "active:not-aria-[haspopup]:scale-[0.98]",
    why: "o estado pressionado (escala 0,98, na hora) é o único retorno do toque antes da resposta",
  },
  {
    file: "src/ui/skeleton.tsx",
    source: "animate-pulse",
    why: "nas listas carregando o texto é sr-only: o pulso é o único sinal visível de que a tela espera",
  },
  {
    file: "src/ui/toast.tsx",
    source: "swipeDirection",
    why: "o arraste para dispensar segue o dedo (transform em linha do Base UI enquanto arrasta); sem ele o toast salta",
  },
  {
    file: "src/ui/charts/area-chart.tsx",
    source: "<ChartTooltip",
    why: "o tooltip acompanha o dedo, que é o uso do gráfico no celular; abaixo do full ele salta de ponto em ponto (damping 0)",
  },
];

/**
 * Motion classes that move nothing, so neither essential nor dispensable: the file, the class and why. Only in code
 * that is not ours (the Bklit registry, kept as distributed).
 */
const INERT_MOTION: readonly { file: string; token: string; why: string }[] = [
  {
    file: "src/ui/bklit/charts/tooltip/tooltip-content.tsx",
    token: "transition-opacity",
    why: "a opacidade do bloco de baixo do tooltip do Bklit nunca muda; e, abaixo do full, theme.css zera as transições dentro do gráfico",
  },
  {
    file: "src/ui/bklit/charts/tooltip/tooltip-content.tsx",
    token: "duration-200",
    why: "a duração da transição de cima",
  },
];

/** Smooth scrolling would animate the essential scroll of the row of pills (and any other): the default `auto` only. */
const SMOOTH_SCROLL = /behavior:\s*["']smooth["']|\bscroll-smooth\b/;

/** An `animate-*`, `transition*` or `duration-*` utility that moves something (`animate-none`, `transition-none` stop it). */
const MOTION_UTILITY =
  /^(?:animate-(?!none$)|transition(?:$|-(?!none$))|duration-)/;
/** A string of a source, where the classes are: between double quotes, single quotes or backticks. */
const STRING = /"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g;
const SPACES = /\s+/;
const TS_OR_TSX = /\.tsx?$/;

/** The words of the strings of a source: the classes, among other words. */
const classTokens = (text: string) =>
  [...withoutComments(text).matchAll(STRING)].flatMap((match) =>
    (match[1] ?? match[2] ?? match[3] ?? "").split(SPACES).filter(Boolean)
  );

/** The motion classes of a source that run on the phone without being listed as essential. */
export function phoneMotionFaults(path: string, text: string): string[] {
  if (!TS_OR_TSX.test(path)) {
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
    const listed = (entry: { file: string; token?: string; source?: string }) =>
      entry.file === path && (entry.token ?? entry.source) === token;
    if (ESSENTIAL_MOTION.some(listed) || INERT_MOTION.some(listed)) {
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
    TOKEN_SHEET,
    ...SCREENS.flatMap((screen) => screen.sourceDirs.flatMap(sourcesUnder)),
  ]),
];

const read = (path: string) => readFileSync(join(web, path), "utf8");

/** The focus ring is read in every source of the app, `.ts` included (the layout of the form dialog is one). */
const FOCUS_SCOPE = sourcesUnder("src").filter((path) => TS_OR_TSX.test(path));

/** The motion of the phone is read in every component of the app, not only in the folders of the measured screens. */
const MOTION_SCOPE = sourcesUnder("src").filter((path) =>
  path.endsWith(".tsx")
);

/**
 * Dinheiro (DESIGN.md "Dinheiro"): every amount in reais is written by `Money`, whose sizes are the four `text-value-*`.
 * The files that write amounts have no size in rem or px (`text-[1.75rem]`), and no class string that sets a free
 * `text-[…]` size beside `tabular-nums`; the "R$" and the cents are a fraction of the number (`text-[0.56em]`,
 * `text-[0.72em]`) and that fraction lives only in `ui/money.tsx`, apart from the strings listed here.
 */
const MONEY_FILES = [
  "src/ui/money.tsx",
  "src/ui/hidden-values.tsx",
  "src/ui/kpi-card.tsx",
  "src/home/home-kpi-cards.tsx",
  "src/dashboard/result-cards.tsx",
] as const;
const MONEY_COMPONENT = "src/ui/money.tsx";
const ABSOLUTE_TEXT_SIZE = /(?:^|:)text-\[[\d.]+(?:rem|px)\]$/;
const FREE_TEXT_SIZE = /(?:^|:)text-\[/;
const MONEY_FRACTION = /(?:^|:)text-\[0\.(?:56|72)em\]$/;

const MONEY_FRACTION_ELSEWHERE: readonly {
  file: string;
  strings: number;
  why: string;
}[] = [
  {
    file: "src/ui/figure-counter.tsx",
    strings: 4,
    why: "o contador escreve o R$, o espaço, os centavos e o % nas partes do NumberFlow com a mesma fração do Money, para o valor que conta não mudar de forma",
  },
  {
    file: "src/ui/kpi-card.tsx",
    strings: 1,
    why: "o sufixo % da Margem (HeroPercent) usa a mesma fração do R$ na caixa do valor do cartão",
  },
];

/**
 * The strings that keep a size in rem for a money value: the four columns of the strip of the Resultado, which from
 * 900 px have a size of their own (24 px, and 20 or 18 px for a long amount in a narrow column). The list is exact.
 */
const MONEY_ABSOLUTE_SIZE_ELSEWHERE: readonly {
  file: string;
  strings: number;
  why: string;
}[] = [
  {
    file: "src/ui/kpi-card.tsx",
    strings: 3,
    why: "a faixa de quatro KPIs do Resultado, de 900 px em diante, tem 24 px nas quatro colunas e desce a 20 ou 18 px um valor longo numa coluna estreita (stripValueSize); a escala de dinheiro não cabe em 120 px",
  },
];

const stringsOf = (text: string) =>
  [...withoutComments(text).matchAll(STRING)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? ""
  );

export function moneyFontFaults(path: string, text: string): string[] {
  if (!TS_OR_TSX.test(path)) {
    return [];
  }
  const faults: string[] = [];
  const values = stringsOf(text).map((value) =>
    value.split(SPACES).filter(Boolean)
  );
  if ((MONEY_FILES as readonly string[]).includes(path)) {
    const absolute = values.filter((tokens) =>
      tokens.some((token) => ABSOLUTE_TEXT_SIZE.test(token))
    ).length;
    const allowed =
      MONEY_ABSOLUTE_SIZE_ELSEWHERE.find((entry) => entry.file === path)
        ?.strings ?? 0;
    if (absolute !== allowed) {
      faults.push(
        `${absolute} texto(s) com tamanho em rem ou px em dinheiro, e a lista diz ${allowed}`
      );
    }
    for (const tokens of values) {
      if (
        tokens.includes("tabular-nums") &&
        tokens.some((token) => FREE_TEXT_SIZE.test(token))
      ) {
        faults.push("text-[…] livre junto de tabular-nums em dinheiro");
      }
    }
  }
  if (path !== MONEY_COMPONENT) {
    const fractions = values
      .flat()
      .filter((token) => MONEY_FRACTION.test(token)).length;
    const listed =
      MONEY_FRACTION_ELSEWHERE.find((entry) => entry.file === path)?.strings ??
      0;
    if (fractions !== listed) {
      faults.push(
        `${fractions} fração(ões) do R$ ou dos centavos fora de ui/money.tsx, e a lista diz ${listed}`
      );
    }
  }
  return faults;
}

/**
 * The lists (DESIGN.md "Dinheiro"): the amount is written by `Money` or `MoneyText`, which decide the "R$" and the
 * mask, so these files have no "R$" of their own in a string or in JSX text. The list is of files that exist (a file
 * that was renamed or deleted makes the test fail); a list screen that migrates to `Money` enters it in the same change.
 */
const MONEY_LIST_FILES = [
  "src/catalog/screen-parts.tsx",
  "src/expenses/expense-list.tsx",
  "src/inventory/inventory-page.tsx",
  "src/sales/confirmed-sale-parts.tsx",
  "src/sales/sale-confirmed-panel.tsx",
  "src/sales/sale-history-list.tsx",
  "src/sales/sale-receipt.tsx",
] as const;
const HAND_TYPED_REAIS = /R\$/;

export function handTypedReaisFaults(path: string, text: string): string[] {
  if (!(MONEY_LIST_FILES as readonly string[]).includes(path)) {
    return [];
  }
  return HAND_TYPED_REAIS.test(withoutComments(text))
    ? [
        '"R$" escrito à mão: o valor em reais passa pelo Money ou pelo MoneyText',
      ]
    : [];
}

/**
 * Focus (DESIGN.md "Acessibilidade"): `outline-none` takes the browser's focus ring away, so the class string that
 * has it also carries the ring of its own (`focus-visible:…`, `focus:…`, `has-[…:focus-visible]…`), or the element is a
 * programmatic target that uses the `focus-ring` utility instead. Where the ring is somewhere else, the string is here
 * with the file, how many strings and why. The list is exact: a string that left it makes the test fail, and so does a
 * new one.
 */
const FOCUS_ELSEWHERE: readonly {
  file: string;
  strings: number;
  why: string;
}[] = [
  {
    file: "src/ui/dialog-layout.ts",
    strings: 1,
    why: "a folha do formulário só recebe o foco se não houver nada focável; abre no primeiro campo, que tem o anel dele",
  },
  {
    file: "src/ui/dialog.tsx",
    strings: 1,
    why: "o popup do diálogo pequeno: o foco abre no primeiro controle (o × e os botões têm focus-ring)",
  },
  {
    file: "src/ui/dropdown-menu.tsx",
    strings: 2,
    why: "o posicionador e o popup do menu não são o foco: quem tem o foco é o item, com focus:bg-accent",
  },
  {
    file: "src/ui/input-group.tsx",
    strings: 2,
    why: "o campo dentro do grupo: o anel (borda --ring e halo) é do grupo, via has-[…:focus-visible] (desenho v5.1)",
  },
  {
    file: "src/ui/popover.tsx",
    strings: 1,
    why: "o popup do popover não é o foco: o foco abre no primeiro controle de dentro, que tem o anel dele",
  },
];

const SOURCE_STRING = /"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g;
/** The utilities that take the outline away (`outline-hidden` keeps a transparent one for forced colors and draws nothing). */
const NO_OUTLINE = new Set([
  "outline-none",
  "outline-hidden",
  "outline-0",
  "outline-transparent",
]);
const NO_OUTLINE_ARBITRARY = /^\[outline:(?:none|0)/;
const BALANCED_TITLES =
  /h1,[\s\S]*h6,\s*\.text-title,\s*\.text-section\s*\{\s*text-wrap:\s*balance;/;
const IMPORTANT = /^!|!$/g;
const FOCUS_VARIANT = /^(?:focus|focus-visible|focus-within)$/;
const HAS_FOCUS_VARIANT = /^(?:group-|peer-)?has-\[.*:focus/;
// what draws something the eye sees: a ring, an outline, a border, a background or a shadow (not `ring-0`)
const VISIBLE_UTILITY = /^(?:ring|outline|border|bg|shadow)(?:-|$)/;

/** A class split into its variants and its utility; a `:` inside brackets belongs to an arbitrary value or selector. */
function splitClass(word: string) {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of word) {
    if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
    }
    if (char === ":" && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  return { utility: current.replace(IMPORTANT, ""), variants: parts };
}

const removesOutline = (word: string) =>
  NO_OUTLINE.has(splitClass(word).utility) || NO_OUTLINE_ARBITRARY.test(word);

/** `focus-ring`, or a focus variant of something visible: `focus-visible:ring-3`, `focus:bg-accent`, `has-[:focus-visible]:border-ring`. */
const drawsFocus = (word: string) => {
  const { utility, variants } = splitClass(word);
  if (utility === "focus-ring") {
    return true;
  }
  return (
    VISIBLE_UTILITY.test(utility) &&
    !NO_OUTLINE.has(utility) &&
    utility !== "ring-0" &&
    variants.some(
      (variant) =>
        FOCUS_VARIANT.test(variant) || HAS_FOCUS_VARIANT.test(variant)
    )
  );
};

/** The class strings of a source that take the outline away without a ring of their own. */
export function outlineStrings(path: string, text: string): string[] {
  if (!TS_OR_TSX.test(path)) {
    return [];
  }
  return [...withoutComments(text).matchAll(SOURCE_STRING)].flatMap((match) => {
    const words = (match[1] ?? match[2] ?? match[3] ?? "")
      .split(SPACES)
      .filter(Boolean);
    return words.some(removesOutline) && !words.some(drawsFocus)
      ? [words.join(" ")]
      : [];
  });
}

/** What is wrong between a file's strings without a ring and what the list says about it (nothing, when they agree). */
export function focusListFaults(
  path: string,
  text: string,
  list: readonly { file: string; strings: number }[]
): string[] {
  const found = outlineStrings(path, text).length;
  const listed = list.find((entry) => entry.file === path)?.strings ?? 0;
  return found === listed
    ? []
    : [`${found} string(s) sem anel de foco, e a lista diz ${listed}`];
}

/**
 * Só os números principais e indicativos dos cards animam (DESIGN.md "Movimento"): `@number-flow/react` é importado só
 * no contador, e o contador só é usado pelos itens da lista fechada (o valor e o chip do cartão de KPI, a Margem e o
 * percentual da Meta, mais a galeria que mostra o componente). Qualquer outro uso, ou outro arquivo que importe o pacote, reprova.
 * O contador (`figure-counter.tsx`) é um pedaço que só `animated-figure.tsx` carrega, com `import()` e só no nível `full`:
 * um import estático dele, de qualquer arquivo, o traria de volta ao pedaço do cartão e ao celular.
 */
export const FIGURE_COUNTER = "src/ui/figure-counter.tsx";
export const FIGURE_LOADER = "src/ui/animated-figure.tsx";
export const FIGURE_USERS = [
  "src/home/home-goal.tsx",
  "src/ui-gallery/ui-gallery.tsx",
  "src/ui/kpi-card.tsx",
] as const;
const COUNTER_PACKAGE = /@number-flow\//;
const COUNTER_USE = /<AnimatedFigure\b/;
const COUNTER_STATIC_IMPORT =
  /(?:\bfrom\s*|\bimport\s+|\brequire\s*\(\s*)["'`][^"'`]*figure-counter(?:\.tsx?)?["'`]/;
/* `typeof import("./figure-counter")` is a type, erased at build: it does not load anything */
const COUNTER_DYNAMIC_IMPORT =
  /(?<!typeof\s)\bimport\s*\(\s*["'`]\.\/figure-counter["'`]\s*\)/;

export function figureFaults(path: string, text: string): string[] {
  const code = withoutComments(text);
  const faults: string[] = [];
  if (COUNTER_PACKAGE.test(code) && path !== FIGURE_COUNTER) {
    faults.push("importa o pacote do contador fora de ui/figure-counter.tsx");
  }
  if (COUNTER_STATIC_IMPORT.test(code)) {
    faults.push(
      "importa o contador de forma estática: só o import() de ui/animated-figure.tsx o carrega"
    );
  }
  if (path === FIGURE_LOADER && !COUNTER_DYNAMIC_IMPORT.test(code)) {
    faults.push("o carregador não importa o contador com import()");
  }
  if (
    COUNTER_USE.test(code) &&
    !(FIGURE_USERS as readonly string[]).includes(path)
  ) {
    faults.push("usa o AnimatedFigure fora da lista fechada dos cartões");
  }
  return faults;
}

const FIGURE_SCOPE = sourcesUnder("src").filter((path) => TS_OR_TSX.test(path));

describe("o contador só nos números principais e indicativos dos cartões (AC-8.1)", () => {
  it("a lista fechada e o contador existem, e cada usuário da lista usa o contador (uma lista velha deixaria passar outra coisa)", () => {
    expect(FIGURE_USERS).toEqual([...FIGURE_USERS].sort());
    expect(read(FIGURE_COUNTER)).toContain('from "@number-flow/react"');
    expect(read(FIGURE_LOADER)).not.toContain("@number-flow");
    for (const user of FIGURE_USERS) {
      expect(read(user), user).toMatch(COUNTER_USE);
    }
    expect(FIGURE_SCOPE).toEqual(
      expect.arrayContaining([FIGURE_COUNTER, FIGURE_LOADER])
    );
  });

  it.each(FIGURE_SCOPE)("%s: sem contador fora da lista", (path) => {
    expect(figureFaults(path, read(path))).toEqual([]);
  });

  it("reprova o pacote fora do contador e o contador fora da lista (controle plantado)", () => {
    const pkg = 'import NumberFlow from "@number-flow/react";';
    const use = "const a = <AnimatedFigure text={x}>{x}</AnimatedFigure>;";
    expect(figureFaults("src/ui/money.tsx", pkg)).toHaveLength(1);
    expect(figureFaults("src/dashboard/result-chart.tsx", use)).toHaveLength(1);
    expect(figureFaults("src/home/home-chart.tsx", use)).toHaveLength(1);
    expect(figureFaults(FIGURE_COUNTER, pkg)).toEqual([]);
    expect(figureFaults("src/ui/kpi-card.tsx", use)).toEqual([]);
    const staticImport = 'import { Counter } from "./figure-counter";';
    const lazyImport = 'const module = await import("./figure-counter");';
    expect(figureFaults("src/ui/kpi-card.tsx", staticImport)).toHaveLength(1);
    expect(
      figureFaults("src/home/home-goal.tsx", 'import "@/ui/figure-counter";')
    ).toHaveLength(1);
    expect(figureFaults(FIGURE_LOADER, staticImport)).toHaveLength(2);
    expect(figureFaults(FIGURE_LOADER, lazyImport)).toEqual([]);
    expect(figureFaults(FIGURE_LOADER, "const a = 1;")).toHaveLength(1);
    expect(
      figureFaults(
        FIGURE_LOADER,
        'type Counter = typeof import("./figure-counter");'
      )
    ).toHaveLength(1);
    expect(figureFaults("src/ui/kpi-card.tsx", lazyImport)).toEqual([]);
    // a comment that names the package is not an import
    expect(figureFaults("src/ui/money.tsx", "// @number-flow/react")).toEqual(
      []
    );
  });
});

describe("regras de fonte da interface (t180, itens 4 e 5)", () => {
  it("cobre a base, os estilos e as pastas das telas", () => {
    expect(SCOPE).toEqual(
      expect.arrayContaining([
        "src/ui/button.tsx",
        "src/ui/dialog.tsx",
        "../../packages/ui/src/theme.css",
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

  it("as quatro essenciais do inventário ainda estão nos arquivos delas, e as classes que não movem nada também (uma lista velha deixaria passar outra coisa)", () => {
    expect(ESSENTIAL_MOTION).toHaveLength(4);
    for (const entry of ESSENTIAL_MOTION) {
      expect(MOTION_SCOPE, entry.file).toContain(entry.file);
      expect(
        withoutComments(read(entry.file)),
        `${entry.file}: ${entry.source}`
      ).toContain(entry.source);
    }
    for (const entry of INERT_MOTION) {
      expect(
        classTokens(read(entry.file)),
        `${entry.file}: ${entry.token}`
      ).toContain(entry.token);
    }
  });

  it.each(MOTION_SCOPE)(
    "%s: nenhuma rolagem suave (a rolagem que sobra é instantânea)",
    (path) => {
      expect(withoutComments(read(path))).not.toMatch(SMOOTH_SCROLL);
    }
  );

  it.each(FOCUS_SCOPE)(
    "%s: tirar o contorno só com o anel de foco junto (ou na lista exata)",
    (path) => {
      expect(focusListFaults(path, read(path), FOCUS_ELSEWHERE)).toEqual([]);
    }
  );

  it.each(FOCUS_SCOPE)(
    "%s: dinheiro só pelo Money, nos tamanhos da escala",
    (path) => {
      expect(moneyFontFaults(path, read(path))).toEqual([]);
    }
  );

  it.each(MONEY_LIST_FILES)(
    "%s: nenhum R$ escrito à mão, o valor passa pelo Money",
    (path) => {
      expect(existsSync(join(web, path)), path).toBe(true);
      expect(handTypedReaisFaults(path, read(path))).toEqual([]);
    }
  );

  it("os arquivos de dinheiro e a lista da fração ainda existem (uma lista velha deixaria passar outra coisa)", () => {
    for (const path of [
      ...MONEY_FILES,
      ...MONEY_FRACTION_ELSEWHERE.map((entry) => entry.file),
    ]) {
      expect(existsSync(join(web, path)), path).toBe(true);
    }
    const sorted = (paths: string[]) => [...paths].sort();
    expect(sorted(MONEY_FRACTION_ELSEWHERE.map((entry) => entry.file))).toEqual(
      sorted(
        FOCUS_SCOPE.filter((path) => path !== MONEY_COMPONENT).filter((path) =>
          read(path).includes("text-[0.56em]")
        )
      )
    );
  });

  it("a lista de foco em outro lugar ainda é verdade (uma lista velha deixaria passar outra coisa)", () => {
    expect(FOCUS_ELSEWHERE.map((entry) => entry.file)).toEqual([
      "src/ui/dialog-layout.ts",
      "src/ui/dialog.tsx",
      "src/ui/dropdown-menu.tsx",
      "src/ui/input-group.tsx",
      "src/ui/popover.tsx",
    ]);
    for (const entry of FOCUS_ELSEWHERE) {
      expect(FOCUS_SCOPE, entry.file).toContain(entry.file);
      expect(outlineStrings(entry.file, read(entry.file))).toHaveLength(
        entry.strings
      );
    }
  });

  it("os títulos quebram com text-wrap: balance, na camada base (t439)", () => {
    const sheet = withoutComments(read(TOKEN_SHEET));
    const base = sheet.slice(sheet.lastIndexOf("@layer base"));
    expect(base).toMatch(BALANCED_TITLES);
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
    expect(faultsOf(text, "../../packages/ui/src/theme.css")).toEqual([]);
  });

  it.each([
    ["color: oklch(0.2 0.01 85);", "../../packages/ui/src/theme.css"],
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
    [
      "@keyframes rise { to { opacity: 1 } }",
      "../../packages/ui/src/theme.css",
    ],
  ])("%s passa", (text, path) => {
    expect(faultsOf(text, path)).toEqual([]);
  });
  it.each([
    'className="grid gap-2 outline-none"',
    'className="outline-none" tabIndex={-1}',
    'cn("text-section outline-none", className)',
    'className="md:outline-none"',
    'className="outline-hidden"',
    'className="outline-none!"',
    'className="!outline-none"',
    'className="outline-0 p-2"',
    'className="outline-transparent"',
    'className="[outline:none] p-2"',
    // a focus variant of something that draws nothing is not a ring
    'className="outline-none focus:text-red-500"',
    'className="outline-none has-[>svg]:gap-1"',
    'className="outline-none focus-visible:ring-0"',
    'className="outline-none hover:bg-accent"',
  ])("%s: tirar o contorno sem anel é reprovado", (text) => {
    expect(outlineStrings("src/x.tsx", text)).toHaveLength(1);
  });

  it.each([
    'className="focus-ring grid gap-2"',
    'className="outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30"',
    'className="outline-none has-[:focus-visible]:ring-3"',
    'className="outline-none has-[[data-slot=control]:focus-visible]:border-ring"',
    'className="outline-hidden focus:bg-accent"',
    'className="outline-none focus-visible:outline-3 focus-visible:outline-ring"',
    '/* className="outline-none" in a comment */',
    'className="outline-offset-2 outline-3"',
  ])("%s: passa na regra do foco", (text) => {
    expect(outlineStrings("src/x.tsx", text)).toEqual([]);
  });

  it("dinheiro: rem, px, text livre ao lado de tabular-nums e a fração do R$ fora do Money reprovam (controle plantado)", () => {
    const money = (text: string, path = "src/ui/money.tsx") =>
      moneyFontFaults(path, text);
    expect(money('const a = "font-semibold text-[1.75rem]";').join()).toContain(
      "rem ou px"
    );
    expect(money('const a = "md:text-[28px] p-2";').join()).toContain(
      "rem ou px"
    );
    expect(money('const a = "tabular-nums text-[0.9em]";').join()).toContain(
      "tabular-nums"
    );
    expect(money('const a = "text-value-lg tabular-nums";')).toEqual([]);
    expect(money('const a = "font-medium text-[0.56em]";')).toEqual([]);
    expect(
      money('const a = "text-[0.56em]";', "src/home/home-kpi-cards.tsx").join()
    ).toContain("fora de ui/money.tsx");
    expect(
      money('const a = "text-[0.72em]";', "src/home/home-page.tsx").join()
    ).toContain("fora de ui/money.tsx");
    const strip =
      'const a = "min-[56.25rem]:text-[1.5rem]"; const b = "x:text-[1.25rem]"; const c = "y:text-[1.125rem]"; const d = "text-[0.56em]";';
    expect(money(strip, "src/ui/kpi-card.tsx")).toEqual([]);
    expect(
      money(
        `${strip} const d = "md:text-[1.875rem]";`,
        "src/ui/kpi-card.tsx"
      ).join()
    ).toContain(
      "4 texto(s) com tamanho em rem ou px em dinheiro, e a lista diz 3"
    );
    expect(
      money(
        'const a = "text-[1.3125rem] tabular-nums";',
        "src/home/home-kpi-cards.tsx"
      ).join()
    ).toContain(
      "1 texto(s) com tamanho em rem ou px em dinheiro, e a lista diz 0"
    );
    expect(
      money(
        `${strip} const e = "text-[0.56em] text-[0.72em]";`,
        "src/ui/kpi-card.tsx"
      ).join()
    ).toContain("a lista diz 1");
    expect(money(strip, "src/dashboard/result-cards.tsx").join()).toContain(
      "3 texto(s) com tamanho em rem ou px em dinheiro, e a lista diz 0"
    );
    expect(money('// "text-[1.75rem]" in a comment')).toEqual([]);
  });

  it("R$ escrito à mão numa lista reprova, e só nos arquivos da lista (controle plantado)", () => {
    const list = "src/sales/sale-history-list.tsx";
    expect(
      handTypedReaisFaults(list, "<span>R$ {total}</span>").join()
    ).toContain("escrito à mão");
    expect(handTypedReaisFaults(list, 'const a = "R$ 10,00";')).not.toEqual([]);
    expect(handTypedReaisFaults(list, "<Money text={total} />")).toEqual([]);
    expect(handTypedReaisFaults(list, '// "R$ 10,00" in a comment')).toEqual(
      []
    );
    expect(
      handTypedReaisFaults("src/home/home-page.tsx", "<span>R$ 1</span>")
    ).toEqual([]);
  });

  it("a lista exata reprova o que saiu dela e o que entrou (controle plantado)", () => {
    const one = [{ file: "src/ui/x.tsx", strings: 1 }];
    const bare = 'const a = "outline-none"; const b = "outline-none p-2";';
    const none = 'const a = "focus-ring p-2";';
    // a file that is not in the list, with a string without a ring
    expect(focusListFaults("src/ui/y.tsx", bare, one).join()).toContain(
      "lista diz 0"
    );
    // more strings than the list says
    expect(focusListFaults("src/ui/x.tsx", bare, one).join()).toContain(
      "2 string(s)"
    );
    // an old entry: the file no longer has the string
    expect(focusListFaults("src/ui/x.tsx", none, one).join()).toContain(
      "0 string(s)"
    );
    // the list and the file agree
    expect(
      focusListFaults("src/ui/x.tsx", 'const a = "outline-none";', one)
    ).toEqual([]);
  });
});

/**
 * "Atualizar" (DESIGN.md "A mesma ação é o mesmo componente"): the button that reads a screen again is
 * `RefreshButton` (`ui/refresh-button.tsx`), the only file with that text as the name of a button. The screens that
 * read again are scanned for JSX text that starts with "Atualizar" and for an `aria-label` that does, with no
 * exception.
 */
const REFRESH_COMPONENT = "src/ui/refresh-button.tsx";
const REFRESH_SCOPE = [
  ...sourcesUnder("src/home"),
  ...sourcesUnder("src/dashboard"),
  ...sourcesUnder("src/inventory"),
  "src/sales/sale-page.tsx",
];
const REFRESH_TEXT = />\s*Atualizar\b[^<>{}]*</g;
const SPIN_OUTSIDE_MOTION_LEVEL = /(?<!motion-full:)animate-spin/;
const REFRESH_LABEL = /aria-label=["{`'\s]*Atualizar/g;
export function refreshButtonFaults(path: string, text: string): string[] {
  if (path === REFRESH_COMPONENT) {
    return [];
  }
  const code = withoutComments(text);
  const found =
    (code.match(REFRESH_TEXT)?.length ?? 0) +
    (code.match(REFRESH_LABEL)?.length ?? 0);
  return found === 0
    ? []
    : [`${found} "Atualizar" escrito(s) fora do RefreshButton`];
}

describe('"Atualizar" é um componente só (L1-5, AC-5.1)', () => {
  it("o escopo cobre as cinco telas que releem", () => {
    for (const screen of [
      "src/home/home-page.tsx",
      "src/dashboard/dashboard-page.tsx",
      "src/dashboard/goals-panel.tsx",
      "src/inventory/inventory-page.tsx",
      "src/sales/sale-page.tsx",
    ]) {
      expect(REFRESH_SCOPE, screen).toContain(screen);
    }
  });

  it.each(REFRESH_SCOPE)(
    "%s: sem 'Atualizar' fora do RefreshButton",
    (path) => {
      expect(refreshButtonFaults(path, read(path))).toEqual([]);
    }
  );

  it("o botão de verdade está no componente e as telas já migradas o usam", () => {
    expect(withoutComments(read(REFRESH_COMPONENT))).toContain(">Atualizar<");
    for (const screen of [
      "src/home/home-page.tsx",
      "src/dashboard/dashboard-page.tsx",
      "src/dashboard/goals-panel.tsx",
      "src/inventory/inventory-page.tsx",
      "src/sales/sale-page.tsx",
    ]) {
      expect(read(screen), screen).toContain("<RefreshButton");
    }
  });

  it("o ícone só gira sob motion-full: e o botão diz aria-busy enquanto lê", () => {
    const code = withoutComments(read(REFRESH_COMPONENT));
    expect(code).toContain("motion-full:animate-spin");
    expect(code).not.toMatch(SPIN_OUTSIDE_MOTION_LEVEL);
    expect(code).toContain("aria-busy");
    expect(code).toContain('variant="outline"');
  });

  it("um 'Atualizar' escrito à mão reprova em qualquer tela, sem exceção (controle plantado)", () => {
    const screen = "src/dashboard/dashboard-page.tsx";
    expect(
      refreshButtonFaults(screen, "<Button>\n  Atualizar\n</Button>").join()
    ).toContain('1 "Atualizar"');
    expect(
      refreshButtonFaults(screen, "<Button>Atualizar metas</Button>")
    ).not.toEqual([]);
    expect(
      refreshButtonFaults(screen, '<Button aria-label="Atualizar metas" />')
    ).not.toEqual([]);
    expect(refreshButtonFaults(screen, "<RefreshButton busy={b} />")).toEqual(
      []
    );
    expect(refreshButtonFaults(screen, '// "Atualizar" in a comment')).toEqual(
      []
    );
    for (const file of [
      "src/inventory/inventory-page.tsx",
      "src/sales/sale-page.tsx",
    ]) {
      expect(
        refreshButtonFaults(file, "<Button>\n  Atualizar\n</Button>").join(),
        file
      ).toContain('1 "Atualizar"');
      expect(
        refreshButtonFaults(
          file,
          "<Button>Atualizar estoque e perfis</Button>"
        ),
        file
      ).not.toEqual([]);
    }
    expect(
      refreshButtonFaults(REFRESH_COMPONENT, "<span>Atualizar</span>")
    ).toEqual([]);
  });
});

/**
 * "Mesmo botão, mesmo nome" (DESIGN.md "Sublinhado só em link dentro de texto corrido"): "Esconder valores" has one
 * size, so no screen passes `size` to it; `variant="link"` has the radius of a control, not `rounded-sm`; and the
 * action of a card that is a secondary link ("Ver o que falta") is a text-only button, not `variant="link"`.
 */
const HIDE_VALUES_SIZE = /<HideValuesButton\b[^>]*\bsize=/;
const LINK_VARIANT_LINE = /^\s*link:\s*"[^"]*"/m;
const SMALL_RADIUS = /\brounded-(?:sm|xs|none)\b/;
const LINK_AS_CARD_ACTION = /variant(?:=["{]+["']?|:\s*["'])link\b/;
const CARD_ACTION_SCREENS = [
  "src/dashboard/quality-banner.tsx",
  "src/home/home-kpi-cards.tsx",
];

export function sameButtonFaults(path: string, text: string): string[] {
  const code = withoutComments(text);
  const faults: string[] = [];
  if (HIDE_VALUES_SIZE.test(code)) {
    faults.push("HideValuesButton recebe `size`: é um tamanho só");
  }
  if (path === "src/ui/button.tsx") {
    const line = LINK_VARIANT_LINE.exec(code)?.[0] ?? "";
    if (line === "" || SMALL_RADIUS.test(line)) {
      faults.push('`variant="link"` sem o raio de controle (rounded-md)');
    }
  }
  if (CARD_ACTION_SCREENS.includes(path) && LINK_AS_CARD_ACTION.test(code)) {
    faults.push("ação de cartão com variant=link: é botão só texto (ghost)");
  }
  return faults;
}

describe("mesmo botão, mesmo nome (L1-6, AC-6.1, AC-6.2, AC-6.5)", () => {
  const files = [
    "src/ui/button.tsx",
    "src/ui/hidden-values.tsx",
    "src/home/home-page.tsx",
    "src/dashboard/dashboard-page.tsx",
    ...CARD_ACTION_SCREENS,
  ];

  it.each(files)("%s: passa", (path) => {
    expect(sameButtonFaults(path, read(path))).toEqual([]);
  });

  it("o botão de verdade existe onde a regra olha (ninguém passa nesta por não ter o que ler)", () => {
    expect(read("src/ui/button.tsx")).toMatch(LINK_VARIANT_LINE);
    expect(read("src/dashboard/quality-banner.tsx")).toContain(
      'variant="ghost"'
    );
    expect(read("src/home/home-kpi-cards.tsx")).toContain('variant: "ghost"');
  });

  it("a volta de cada uma reprova (controle plantado)", () => {
    expect(
      sameButtonFaults(
        "src/dashboard/dashboard-page.tsx",
        '<HideValuesButton size="sm" />'
      )
    ).toHaveLength(1);
    expect(
      sameButtonFaults("src/home/home-page.tsx", "<HideValuesButton />")
    ).toEqual([]);
    expect(
      sameButtonFaults(
        "src/ui/button.tsx",
        '  link: "h-auto rounded-sm px-0 underline",'
      )
    ).toHaveLength(1);
    expect(
      sameButtonFaults("src/ui/button.tsx", '  link: "h-auto px-0 underline",')
    ).toEqual([]);
    expect(
      sameButtonFaults(
        "src/dashboard/quality-banner.tsx",
        '<Button size="sm" variant="link" />'
      )
    ).toHaveLength(1);
    expect(
      sameButtonFaults(
        "src/home/home-kpi-cards.tsx",
        'buttonVariants({ size: "sm", variant: "link" })'
      )
    ).toHaveLength(1);
    expect(
      sameButtonFaults(
        "src/dashboard/quality-banner.tsx",
        '<Button size="sm" variant="ghost" />'
      )
    ).toEqual([]);
  });
});

/**
 * "Uma lista de atalhos de período" (DESIGN.md "Período (`DateRangePicker`)", L2-1, AC-1.6): the names of the shortcuts
 * live in `src/ui/date-range-shortcuts.ts` and a screen only chooses which ones it shows. A name written anywhere else
 * in `src/` is a second list that drifts. The one exception is the "Este mês" button of the month picker of the
 * Despesas: it chooses the competence month, not a range, and the list says so by name.
 */
const SHORTCUT_LIST = "src/ui/date-range-shortcuts.ts";
const SHORTCUT_NAMES = [
  "Este mês",
  "Mês passado",
  "Últimos 30 dias",
  "Este ano",
] as const;
const OWN_SHORTCUT_NAME: Readonly<Record<string, readonly string[]>> = {
  "src/expenses/month-picker.tsx": ["Este mês"],
};

export function shortcutNameFaults(path: string, text: string): string[] {
  if (path === SHORTCUT_LIST) {
    return [];
  }
  const code = withoutComments(text);
  const own = OWN_SHORTCUT_NAME[path] ?? [];
  return SHORTCUT_NAMES.filter(
    (name) => code.includes(name) && !own.includes(name)
  ).map((name) => `"${name}" escrito fora de ${SHORTCUT_LIST}`);
}

export function shortcutFaultsOver(
  sources: ReadonlyArray<{ path: string; text: string }>
): string[] {
  return sources.flatMap(({ path, text }) =>
    shortcutNameFaults(path, text).map((fault) => `${path}: ${fault}`)
  );
}

describe("a lista de atalhos mora num arquivo só (L2-1, AC-1.6)", () => {
  const files = sourcesUnder("src");

  it("a árvore foi lida e a lista está nela", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain(SHORTCUT_LIST);
    expect(files).toContain("src/dashboard/period-picker.tsx");
    expect(files).toContain("src/dashboard/result-period.ts");
    expect(files.filter((path) => path.includes(".test."))).toEqual([]);
  });

  it("nenhum arquivo de src escreve o nome de um atalho", () => {
    expect(
      shortcutFaultsOver(files.map((path) => ({ path, text: read(path) })))
    ).toEqual([]);
  });

  it("a lista tem os seis atalhos e a exceção é exata: o arquivo dela ainda escreve o nome", () => {
    const listed = withoutComments(read(SHORTCUT_LIST));
    for (const name of [...SHORTCUT_NAMES, "Hoje", "7 dias"]) {
      expect(listed, name).toContain(name);
    }
    expect(Object.keys(OWN_SHORTCUT_NAME)).toEqual([
      "src/expenses/month-picker.tsx",
    ]);
    for (const [path, names] of Object.entries(OWN_SHORTCUT_NAME)) {
      for (const name of names) {
        expect(withoutComments(read(path)), `${path}: ${name}`).toContain(name);
      }
    }
  });

  it("o Resultado, o Histórico e as Metas escolhem da lista, sem lista própria (controle)", () => {
    expect(read("src/dashboard/result-period.ts")).toContain("shortcutLabel(");
    expect(read("src/dashboard/period-picker.tsx")).toContain("shortcuts=");
    expect(read("src/ui/date-range-picker.tsx")).toContain("shortcutsOf(");
  });

  it("a varredura da árvore reprova uma lista própria plantada numa tela e nomeia o arquivo (controle plantado)", () => {
    const planted = [
      { path: SHORTCUT_LIST, text: '{ label: "Este mês" }' },
      {
        path: "src/expenses/month-picker.tsx",
        text: "<button>Este mês</button>",
      },
      {
        path: "src/dashboard/period-picker.tsx",
        text: 'const shortcuts = ["Este mês", "Este ano"];',
      },
      {
        path: "src/sales/sale-history-filters.tsx",
        text: "const own = `Últimos 30 dias`;",
      },
      { path: "src/goals/goals-page.tsx", text: "// Mês passado" },
    ];
    expect(shortcutFaultsOver(planted)).toEqual([
      `src/dashboard/period-picker.tsx: "Este mês" escrito fora de ${SHORTCUT_LIST}`,
      `src/dashboard/period-picker.tsx: "Este ano" escrito fora de ${SHORTCUT_LIST}`,
      `src/sales/sale-history-filters.tsx: "Últimos 30 dias" escrito fora de ${SHORTCUT_LIST}`,
    ]);
    expect(
      shortcutFaultsOver([
        ...planted.filter(
          ({ path }) => path !== "src/dashboard/period-picker.tsx"
        ),
        {
          path: "src/expenses/month-picker.tsx",
          text: "<button>Mês passado</button>",
        },
      ])
    ).toEqual([
      `src/sales/sale-history-filters.tsx: "Últimos 30 dias" escrito fora de ${SHORTCUT_LIST}`,
      `src/expenses/month-picker.tsx: "Mês passado" escrito fora de ${SHORTCUT_LIST}`,
    ]);
  });

  it("um nome escrito à mão reprova, e a lista e a exceção não (controle plantado)", () => {
    expect(
      shortcutNameFaults(
        "src/dashboard/period-picker.tsx",
        '<button>Este mês</button> const a = "Últimos 30 dias";'
      )
    ).toHaveLength(2);
    expect(
      shortcutNameFaults(
        "src/sales/sale-history-filters.tsx",
        'const labels = ["Mês passado"];'
      )
    ).toHaveLength(1);
    expect(
      shortcutNameFaults("src/dashboard/x.ts", "// Este mês e Este ano")
    ).toEqual([]);
    expect(shortcutNameFaults(SHORTCUT_LIST, '{ label: "Este mês" }')).toEqual(
      []
    );
    expect(
      shortcutNameFaults("src/expenses/month-picker.tsx", ">Este mês<")
    ).toEqual([]);
    expect(
      shortcutNameFaults("src/expenses/month-picker.tsx", ">Este ano<")
    ).toHaveLength(1);
  });
});

const UPPERCASE_CLASS = /^!?(?:uppercase|\[text-transform:uppercase\])!?$/;
const UPPERCASE_STYLE =
  /text-transform\s*:\s*uppercase|textTransform\s*:\s*["'`]uppercase|@apply\b[^;]*\buppercase\b/;
// `cn({ uppercase: flag })`: the key of the object has no quotes, so no string holds it
const UPPERCASE_KEY = /\b(?:cn|clsx|cva|twMerge)\([^)]*?\{[^}]*\buppercase\s*:/;

// a word of a sentence: capitalized, or closed by punctuation; no class is written like that
const SENTENCE_WORD = /^[A-ZÀ-Ý][a-zà-ÿ]+$|[a-zà-ÿ][.,?;]$/;

/** The words of the strings of a source that are class lists: a sentence that says "uppercase" is not one. */
const classTokensOutsideProse = (text: string) =>
  [...withoutComments(text).matchAll(STRING)].flatMap((match) => {
    const words = (match[1] ?? match[2] ?? match[3] ?? "")
      .split(SPACES)
      .filter(Boolean);
    return words.some((word) => SENTENCE_WORD.test(word)) ? [] : words;
  });

/** Capital letters set by the style: the `uppercase` class (with or without a variant) and `text-transform: uppercase`. */
export function uppercaseStyleFaults(path: string, text: string): string[] {
  const faults: string[] = [];
  const code = withoutComments(text);
  if (UPPERCASE_STYLE.test(code)) {
    faults.push("text-transform: uppercase");
  }
  if (UPPERCASE_KEY.test(code)) {
    faults.push("classe uppercase como chave de objeto");
  }
  if (!TS_OR_TSX.test(path)) {
    return faults;
  }
  for (const token of classTokensOutsideProse(text)) {
    // the utility is what follows the last variant; a `:` inside brackets is part of an arbitrary value
    const masked = token.replace(/\[[^\]]*\]/g, (part) =>
      part.replaceAll(":", "_")
    );
    const utility = masked.slice(masked.lastIndexOf(":") + 1);
    if (UPPERCASE_CLASS.test(utility) || UPPERCASE_CLASS.test(token)) {
      faults.push(`classe ${token}`);
    }
  }
  return faults;
}

/** The one place that keeps capital letters, with the reason: the POC of the offline persistence is a lab, not the app. */
const UPPERCASE_ELSEWHERE: readonly { file: string; why: string }[] = [
  {
    file: "src/offline-poc/offline-poc.css",
    why: "prova de conceito da persistência offline: folha própria, fora do app e das telas do lojista",
  },
];

/** The files that carry capital letters set by the style, outside the written exception; `readFile` is injected so a control can plant one. */
export function uppercaseScanFaults(
  paths: readonly string[],
  readFile: (path: string) => string
): string[] {
  const listed = UPPERCASE_ELSEWHERE.map((entry) => entry.file);
  return paths
    .filter((path) => !listed.includes(path))
    .flatMap((path) =>
      uppercaseStyleFaults(path, readFile(path)).map(
        (fault) => `${path}: ${fault}`
      )
    );
}

const UPPERCASE_PACKAGE_DIRS = [
  "../../packages/ui/src",
  "../catalog/src",
] as const;

describe("o app não tem caixa alta (L1-13, AC-13.2)", () => {
  const files = [
    ...sourcesUnder("src"),
    ...UPPERCASE_PACKAGE_DIRS.flatMap(sourcesUnder),
  ];

  it("a árvore de src foi lida, com o POC dentro", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain("src/expenses/expense-list.tsx");
    expect(files).toContain("src/offline-poc/offline-poc.css");
  });

  it("os pacotes de interface e o catálogo entram na varredura", () => {
    expect(files).toContain("../../packages/ui/src/theme.css");
    expect(files).toContain("../catalog/src/styles.css");
    expect(files).toContain("../catalog/src/views.tsx");
  });

  it("nenhum arquivo de src põe texto em caixa alta pelo estilo, fora da exceção", () => {
    expect(uppercaseScanFaults(files, read)).toEqual([]);
  });

  it("a exceção é exata: o arquivo dela ainda tem caixa alta e a razão está escrita", () => {
    expect(UPPERCASE_ELSEWHERE.map((entry) => entry.file)).toEqual([
      "src/offline-poc/offline-poc.css",
    ]);
    for (const entry of UPPERCASE_ELSEWHERE) {
      expect(entry.why.length, entry.file).toBeGreaterThan(20);
      expect(
        uppercaseStyleFaults(entry.file, read(entry.file)),
        entry.file
      ).not.toEqual([]);
    }
  });

  it.each([
    ['<p className="font-medium text-xs uppercase tracking-wide">', 1],
    ['<p className="md:uppercase">', 1],
    ['<p className="!uppercase">', 1],
    ['<p className="uppercase!">', 1],
    ['<p className="[text-transform:uppercase]">', 1],
    ['cn("grid", open && "uppercase")', 1],
    ["<p style={{ textTransform: 'uppercase' }}>", 1],
    [".label { text-transform: uppercase; }", 1],
    [".label{text-transform:uppercase}", 1],
    [".label { @apply font-medium uppercase; }", 1],
    ["cn({ uppercase: dense })", 1],
    ["cn('grid', { uppercase: dense, 'p-2': true })", 1],
  ])("%s reprova (controle plantado)", (text, count) => {
    const path = text.startsWith(".") ? "src/x.css" : "src/x.tsx";
    expect(uppercaseStyleFaults(path, text).length).toBeGreaterThanOrEqual(
      count
    );
  });

  it.each([
    ["../../packages/ui/src/x.tsx", '<p className="font-medium uppercase">'],
    ["../../packages/ui/src/x.css", ".label { text-transform: uppercase; }"],
    ["../catalog/src/x.tsx", '<p className="font-medium uppercase">'],
    ["../catalog/src/x.css", ".label { text-transform: uppercase; }"],
  ])(
    "caixa alta plantada em %s reprova na varredura (controle plantado)",
    (path, text) => {
      expect(
        UPPERCASE_PACKAGE_DIRS.some((dir) => path.startsWith(`${dir}/`))
      ).toBe(true);
      expect(uppercaseScanFaults([path], () => text)).toHaveLength(1);
    }
  );

  it("a exceção vale só para o caminho exato: o mesmo nome em outro lugar reprova (controle plantado)", () => {
    const plant = ".x { text-transform: uppercase; }";
    for (const path of [
      "../catalog/src/offline-poc/offline-poc.css",
      "../../packages/ui/src/offline-poc/offline-poc.css",
      "src/offline-poc/offline-poc.css.bak",
    ]) {
      expect(
        uppercaseScanFaults([path], () => plant),
        path
      ).toHaveLength(1);
    }
    expect(
      uppercaseScanFaults(["src/offline-poc/offline-poc.css"], () => plant)
    ).toEqual([]);
  });

  it.each([
    '<p className="font-medium text-muted-foreground text-support">',
    '<p className="normal-case">',
    '<p className="not-uppercase-ish lowercase capitalize">',
    "// uppercase tracking-wide",
    "/* text-transform: uppercase */",
    "const name = text.toUpperCase();",
    "const errors = { uppercase: 'password_missing_uppercase' };",
    ".label { @apply font-medium; }",
    'const message = "Password needs an uppercase letter.";',
    ".label { text-transform: none; }",
  ])("%s passa (controle plantado)", (text) => {
    const path = text.startsWith(".") ? "src/x.css" : "src/x.tsx";
    expect(uppercaseStyleFaults(path, text)).toEqual([]);
  });
});
