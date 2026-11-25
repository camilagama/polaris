import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * O padrão visual das telas (DESIGN.md "Peças de padrão"): uma peça pública por papel, e o que foge dela reprova.
 *
 * - R1: aba de tela e filtro não importam o `Tabs` cru (`@/ui/tabs`): só `ui/` o importa (o `SectionTabs` vive lá).
 * - R2: nenhuma tela importa `Card`, `CardHeader`, `CardContent`, `CardTitle` nem `CardDescription`: a moldura é o `Block`.
 * - R3: nenhuma tela escreve à mão uma moldura (`rounded` e `border` de largura simples na mesma string de classe; uma
 *   string com `border-0` não conta, porque essa classe tira a borda).
 * - R4: `ListTotalFooter`, `ListNotice` e `RowTile` só vivem em `ui/`: a tela usa o `ListBlock` (o total é o
 *   `ListBlock.Total`), nunca as peças soltas.
 * - R5 (aviso, não reprova): um `Block` cujo conteúdo faz `.map(` de linhas fora de um `ListBlock`.
 *
 * A varredura é `src/**` fora de `ui/`, da galeria e dos testes. Cada regra tem uma lista de dívida com os arquivos de
 * antes do padrão, uma linha de comentário por pasta separando os grupos (dois pacotes de pastas diferentes não
 * conflitam ao tirar linhas), que só encolhe: arquivo novo fora do padrão reprova, e arquivo da lista que já está limpo também
 * (quem migra a tela tira o arquivo da lista no mesmo PR). `ALLOWLIST` guarda as exceções que ficam para sempre, cada
 * uma com a razão, e reprova quando a exceção deixa de ser usada.
 */
const web = fileURLToPath(new URL("..", import.meta.url));

type Rule = "R1" | "R2" | "R3" | "R4";

const RULES: readonly Rule[] = ["R1", "R2", "R3", "R4"];

const SOURCE = /\.tsx$/;
const TEST_FILE = /\.test\.tsx$/;
const OUTSIDE = ["src/ui/", "src/ui-gallery/"] as const;

// a string is matched first so a `/*` or a `//` inside it (`accept="image/*"`, a URL) does not start a comment
const COMMENT_OR_STRING =
  /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\/\*[\s\S]*?\*\/|(?:^|\s)\/\/[^\n]*/gm;
const withoutComments = (text: string) =>
  text.replace(COMMENT_OR_STRING, (_match, quoted?: string) => quoted ?? "");

const STATEMENT =
  /\b(?:import|export)\s+([^;'"`]*?)\s*from\s*(["'`])([^"'`]+)\2/g;
const DYNAMIC = /\bimport\s*\(\s*(["'`])([^"'`]+)\1/g;
const BARE = /\bimport\s*(["'`])([^"'`]+)\1/g;
const UI_MODULE = (name: string) =>
  new RegExp(
    `^(?:@\\/ui|(?:\\.{1,2}\\/)+(?:[\\w-]+\\/)*ui)\\/${name}(?:\\.tsx?)?$`
  );
const TABS_MODULE = UI_MODULE("tabs");
const CARD_MODULE = UI_MODULE("card");
const LIST_PARTS = new Set([
  "ListNotice",
  "ListNoticeBody",
  "ListTotalFooter",
  "RowTile",
]);
// the pieces and the module that still reexports them: a namespace or a dynamic import of one of them is a use too
const LIST_PART_MODULES = [
  UI_MODULE("list-notice"),
  UI_MODULE("list-total-footer"),
  UI_MODULE("row-tile"),
  /(?:^|\/)screen-parts(?:\.tsx?)?$/,
];
const CARD_NAMES = new Set([
  "Card",
  "CardContent",
  "CardDescription",
  "CardHeader",
  "CardTitle",
]);

// a string literal of any quote, a template included: the class of an element is one of them
const STRING_LITERAL =
  /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
// its own state: `matchAll` copies the `lastIndex` of the regex it is given
const STICKY_LITERAL = new RegExp(STRING_LITERAL.source, "y");
// `rounded`, `rounded-xl`, `md:rounded-[calc(…)]`; not `rounded-none` nor `rounded-t-*`, `-b-*`… (no corner, or one side only)
const ROUNDED =
  /(?:^|[\s"'`])(?:[\w[\]-]+:)*!?rounded(?:-(?!(?:none|t|b|l|r|s|e|tl|tr|bl|br|ss|se|es|ee)(?:-|[\s"'`]|$))[^\s"'`]+)?!?(?=[\s"'`]|$)/;
// the calls that join classes: their strings are one class, so `cn("rounded-xl", "border p-3")` is a frame too
const CLASS_CALL = /\b(?:cn|clsx|twMerge)\(/g;
// a border on every side: `border`, `border-2`, `border-[1.5px]`; not `border-b`, `border-t`, `border-border` (a color)
const BORDER =
  /(?:^|[\s"'`])(?:[\w[\]-]+:)*!?border(?:-(?:\d+|\[\d[^\]]*\]))?!?(?=[\s"'`]|$)/;
// a plain `border-0` takes the border away at every width and state: it is not a border, and what is left decides
const PLAIN_NO_BORDER = /(^|[\s"'`])border-0(?=[\s"'`]|$)/g;
const isFrame = (classes: string) => {
  const kept = ` ${classes.replace(PLAIN_NO_BORDER, "$1")} `;
  return ROUNDED.test(kept) && BORDER.test(kept);
};

/** The text of the call whose `(` is at `open`, up to its matching `)`, skipping what is inside strings. */
function callBody(code: string, open: number): { body: string; end: number } {
  let depth = 0;
  let index = open;
  while (index < code.length) {
    const char = code[index];
    if (char === '"' || char === "'" || char === "`") {
      STICKY_LITERAL.lastIndex = index;
      const literal = STICKY_LITERAL.exec(code);
      index = literal ? index + literal[0].length : index + 1;
      continue;
    }
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return { body: code.slice(open + 1, index), end: index + 1 };
      }
    }
    index += 1;
  }
  return { body: code.slice(open + 1), end: code.length };
}

/** The classes of the source, one string per literal and one per `cn(...)` call (its literals joined by a space). */
function classStrings(code: string): string[] {
  const strings: string[] = [];
  let rest = "";
  let cursor = 0;
  for (const call of code.matchAll(CLASS_CALL)) {
    const open = (call.index ?? 0) + call[0].length - 1;
    if (open < cursor) {
      continue;
    }
    const { body, end } = callBody(code, open);
    rest += code.slice(cursor, call.index);
    strings.push(
      [...body.matchAll(STRING_LITERAL)]
        .map(([literal]) => literal.slice(1, -1))
        .join(" ")
    );
    cursor = end;
  }
  rest += code.slice(cursor);
  return [...strings, ...[...rest.matchAll(STRING_LITERAL)].map(([l]) => l)];
}

const AS_KEYWORD = /\s+as\s+/;
const TYPE_PREFIX = /^type\s+/;
const DEBT_FILE = /"(src\/[^"]+)"/;
const NAMED_IMPORTS = /\{([^}]*)\}/;

function importedNames(clause: string): string[] {
  const named = clause.match(NAMED_IMPORTS)?.[1] ?? "";
  return named
    .split(",")
    .map(
      (part) => part.trim().replace(TYPE_PREFIX, "").split(AS_KEYWORD)[0] ?? ""
    )
    .filter((name) => name !== "");
}

/** The rules a source breaks: R1, R2 and R4 once each, R3 once per string of class with a frame written by hand. */
export function ruleHits(text: string): Record<Rule, number> {
  const code = withoutComments(text);
  const imports = [
    ...[...code.matchAll(STATEMENT)].map(
      ([, clause = "", , specifier = ""]) => ({ clause, specifier })
    ),
    ...[...code.matchAll(DYNAMIC), ...code.matchAll(BARE)].map(
      ([, , specifier = ""]) => ({ clause: "*", specifier })
    ),
  ];
  const opens = (clause: string) => clause.includes("*");
  const r1 = imports.some(({ specifier }) => TABS_MODULE.test(specifier));
  const r2 = imports.some(
    ({ clause, specifier }) =>
      CARD_MODULE.test(specifier) &&
      (opens(clause) || importedNames(clause).some((n) => CARD_NAMES.has(n)))
  );
  const r3 = classStrings(code).filter(isFrame).length;
  const r4 = imports.some(
    ({ clause, specifier }) =>
      importedNames(clause).some((name) => LIST_PARTS.has(name)) ||
      (opens(clause) && LIST_PART_MODULES.some((re) => re.test(specifier)))
  );
  return { R1: r1 ? 1 : 0, R2: r2 ? 1 : 0, R3: r3, R4: r4 ? 1 : 0 };
}

const BLOCK_TAG = /<Block(?![\w.])|<\/Block>/g;
const LIST_BLOCK_BODY = /<ListBlock\b[\s\S]*?<\/ListBlock>/g;
const ROW_MAP = /\.map\s*\(/;

/** Where the opening tag that starts at `from` ends: its `>`, past the braces and strings of its attributes. */
function openTagEnd(code: string, from: number): number {
  let depth = 0;
  let index = from;
  while (index < code.length) {
    const char = code[index];
    if (char === '"' || char === "'" || char === "`") {
      STICKY_LITERAL.lastIndex = index;
      const literal = STICKY_LITERAL.exec(code);
      index += literal ? literal[0].length : 1;
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
    } else if (char === ">" && depth === 0) {
      return index;
    }
    index += 1;
  }
  return code.length;
}

/**
 * How many `Block`s of the source hold a `.map(` of rows outside a `ListBlock` (R5, a warning): a list drawn by hand
 * on the frame is the `ListBlock`'s job. `<BlockHeader` and the like are other tags; a self-closing `Block` has no body.
 */
export function blockMapHits(text: string): number {
  const code = withoutComments(text);
  const open: number[] = [];
  let hits = 0;
  for (const tag of code.matchAll(BLOCK_TAG)) {
    const at = tag.index ?? 0;
    if (tag[0] === "</Block>") {
      const start = open.pop();
      const body = start === undefined ? "" : code.slice(start, at);
      if (ROW_MAP.test(body.replace(LIST_BLOCK_BODY, ""))) {
        hits += 1;
      }
      continue;
    }
    const end = openTagEnd(code, at + tag[0].length);
    if (code[end - 1] !== "/") {
      open.push(end + 1);
    }
  }
  return hits;
}

/** The warnings of R5 for the files that hold one: they do not fail the test. */
export function r5Warnings(hits: ReadonlyMap<string, number>): string[] {
  return [...hits]
    .filter(([, count]) => count > 0)
    .map(
      ([file]) =>
        `${file}: Block com .map de linhas fora de um ListBlock (R5, aviso): use o ListBlock`
    );
}

/** The only reasons an exception of R3 may give: an image, and the bubble of a chart. */
export const ALLOWLIST_REASONS = ["chart-bubble", "thumbnail"] as const;

export interface Exception {
  file: string;
  reason: (typeof ALLOWLIST_REASONS)[number];
  why: string;
}

/**
 * The exceptions of R3 that stay: the file, one of the two reasons and why the pattern does not apply there. R2 has no
 * list: nothing outside `Block` imports `Card*`. Sorted by file; an exception no file uses any more fails the test, and
 * so does one whose file draws a list or a table (a list is a block with a title too, so it is never an exception).
 */
export const ALLOWLIST: readonly Exception[] = [];

// what a list or a table of the screen looks like in the source
const LIST_OR_TABLE =
  /<ul\b|<ol\b|<Table\b|<table\b|role=["']list["']|\bdivide-y\b/;

/** What is wrong with the exceptions themselves, given the source of each file. */
export function exceptionFaults(
  allowlist: readonly Exception[],
  source: (file: string) => string
): string[] {
  return allowlist.flatMap(({ file, reason, why }) => {
    const faults: string[] = [];
    if (!ALLOWLIST_REASONS.includes(reason)) {
      faults.push(`${file}: motivo "${reason}" fora da lista fechada`);
    }
    if (why.length <= 20) {
      faults.push(`${file}: a razão da exceção está curta demais`);
    }
    if (LIST_OR_TABLE.test(withoutComments(source(file)))) {
      faults.push(
        `${file}: o arquivo desenha lista ou tabela, que nunca é exceção: use o Block`
      );
    }
    return faults;
  });
}

/**
 * The files of before the pattern, per rule: only shrinks, and each screen that migrates takes its files out. One
 * comment line per folder starts each group, so two changes that take out files of different folders do not touch
 * neighbouring lines.
 */
export const DEBT: Readonly<Record<Rule, readonly string[]>> = {
  R1: [
    // catalog
    "src/catalog/product-import/import-preview-step.tsx",
  ],
  R2: [
    // app-shell
    "src/app-shell/state-panel.tsx",
    // catalog
    "src/catalog/category-form.tsx",
    "src/catalog/category-list.tsx",
    "src/catalog/product-list.tsx",
    // customers
    // data-export
    // expenses
    "src/expenses/expense-by-category.tsx",
    "src/expenses/expense-categories-panel.tsx",
    "src/expenses/expense-rules-panel.tsx",
    "src/expenses/expenses-page.tsx",
    // help
    "src/help/help-page.tsx",
    // offline
    "src/offline/attention-panel.tsx",
    "src/offline/logout-dialog.tsx",
    "src/offline/runtime/device-item.tsx",
    "src/offline/runtime/devices-page.tsx",
    // organization
    // payment-profiles
    // sales
    "src/sales/sale-id-missing.tsx",
    "src/sales/sale-item-editor.tsx",
    "src/sales/sale-page.tsx",
    "src/sales/sale-payment-section.tsx",
    "src/sales/sale-summary-panel.tsx",
    // settings
    // sign-in
    "src/sign-in/change-password-page.tsx",
    "src/sign-in/entry-ui.tsx",
    // subscription
  ],
  R3: [
    // app-shell
    "src/app-shell/action-strip.tsx",
    "src/app-shell/menu-progress.tsx",
    // catalog
    "src/catalog/product-form.tsx",
    "src/catalog/product-media-crop.tsx",
    "src/catalog/product-media-list.tsx",
    "src/catalog/product-media-panel.tsx",
    "src/catalog/product-variants-form.tsx",
    // customers
    "src/customers/customer-list.tsx",
    // expenses
    "src/expenses/expense-list.tsx",
    "src/expenses/month-picker.tsx",
    // legal
    "src/legal/legal-page.tsx",
    // offline
    "src/offline/runtime/logout-control.tsx",
    "src/offline/runtime/sync-status.tsx",
    // payment-profiles
    // sales
    "src/sales/sale-payment-section.tsx",
    "src/sales/sale-summary-panel.tsx",
    // subscription
  ],
  R4: [
    // catalog
    "src/catalog/category-list.tsx",
    "src/catalog/product-list.tsx",
    "src/catalog/screen-parts.tsx",
    // customers
    // expenses
    "src/expenses/expense-list.tsx",
    // offline
    "src/offline/runtime/device-item.tsx",
    // payment-profiles
    // sales
  ],
};

export interface Listing {
  allowlist: readonly Exception[];
  debt: Readonly<Record<Rule, readonly string[]>>;
}

/** What the rules find in `hits` (file → rules) that the listing does not cover, and what the listing covers in vain. */
export function listingFaults(
  hits: ReadonlyMap<string, Record<Rule, number>>,
  { allowlist, debt }: Listing
): string[] {
  const faults: string[] = [];
  for (const rule of RULES) {
    const excused = new Set(
      rule === "R3" ? allowlist.map((entry) => entry.file) : []
    );
    const owed = new Set(debt[rule]);
    for (const [file, found] of hits) {
      if (found[rule] > 0 && !(owed.has(file) || excused.has(file))) {
        faults.push(`${file}: fora do padrão (${rule}) e fora da lista`);
      }
    }
    for (const file of owed) {
      if ((hits.get(file)?.[rule] ?? 0) === 0) {
        faults.push(
          `${file}: limpo em ${rule} e ainda na lista de dívida: tire-o da lista`
        );
      }
    }
    for (const file of excused) {
      if ((hits.get(file)?.[rule] ?? 0) === 0) {
        faults.push(
          `${file}: exceção de ${rule} sem uso no ALLOWLIST: tire-a da lista`
        );
      }
    }
  }
  return faults;
}

const sourcesUnder = (dir: string): string[] =>
  readdirSync(join(web, dir), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name, "en"))
    .flatMap((entry) => {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        return sourcesUnder(path);
      }
      return SOURCE.test(entry.name) && !TEST_FILE.test(entry.name)
        ? [path]
        : [];
    });

const SCOPE = sourcesUnder("src").filter(
  (path) => !OUTSIDE.some((folder) => path.startsWith(folder))
);

const read = (path: string) => readFileSync(join(web, path), "utf8");

const HITS = new Map(SCOPE.map((path) => [path, ruleHits(read(path))]));

const filesOf = (rule: Rule) =>
  [...HITS].filter(([, found]) => found[rule] > 0).map(([file]) => file);

describe("o padrão visual das telas (R1 a R3)", () => {
  it("a árvore de src foi lida e a galeria e ui/ ficaram de fora", () => {
    expect(SCOPE.length).toBeGreaterThan(150);
    expect(SCOPE).toContain("src/home/home-parts.tsx");
    expect(SCOPE.some((path) => path.startsWith("src/ui/"))).toBe(false);
    expect(SCOPE.some((path) => path.startsWith("src/ui-gallery/"))).toBe(
      false
    );
  });

  it("R5 (aviso): a árvore diz onde um Block ainda desenha linhas à mão, sem reprovar", () => {
    const warnings = r5Warnings(
      new Map(SCOPE.map((path) => [path, blockMapHits(read(path))]))
    );
    for (const warning of warnings) {
      console.warn(warning);
    }
    expect(SCOPE.length).toBeGreaterThan(0);
  });

  it("nada foge do padrão fora das listas, e nenhuma lista guarda o que já está limpo", () => {
    expect(listingFaults(HITS, { allowlist: ALLOWLIST, debt: DEBT })).toEqual(
      []
    );
  });

  it.each(RULES)("as listas de %s são exatas, ordenadas e existem", (rule) => {
    const debt = DEBT[rule];
    expect(debt).toEqual([...new Set(debt)].sort());
    for (const file of debt) {
      expect(existsSync(join(web, file)), file).toBe(true);
    }
    expect(filesOf(rule).length).toBe(
      debt.length +
        (rule === "R3"
          ? ALLOWLIST.filter((entry) => !debt.includes(entry.file)).length
          : 0)
    );
  });

  it("o ALLOWLIST é ordenado, só tem os motivos da lista fechada, nenhuma exceção desenha lista ou tabela e nenhuma está também na dívida", () => {
    expect(ALLOWLIST.map((entry) => entry.file)).toEqual(
      ALLOWLIST.map((entry) => entry.file).sort()
    );
    expect(exceptionFaults(ALLOWLIST, read)).toEqual([]);
    for (const entry of ALLOWLIST) {
      expect(DEBT.R3, entry.file).not.toContain(entry.file);
    }
  });

  it("as listas e tabelas principais ficam na dívida: elas saem só quando a tela vai para o Block", () => {
    for (const file of [
      "src/catalog/product-list.tsx",
      "src/catalog/category-list.tsx",
      "src/expenses/expense-list.tsx",
    ]) {
      expect([...DEBT.R2, ...DEBT.R3], file).toContain(file);
    }
  });
});

const NONE = { R1: 0, R2: 0, R3: 0, R4: 0 };

describe("a trava reprova o que planto (controles)", () => {
  it.each([
    [
      "R1",
      'import { Tabs, TabsContent } from "@/ui/tabs";\nexport const X = () => <Tabs />;',
    ],
    ["R1", 'import { TabsList } from "../ui/tabs";'],
    ["R1", 'const tabs = await import("@/ui/tabs");'],
    [
      "R2",
      'import { Card, CardContent } from "@/ui/card";\nexport const X = () => <Card />;',
    ],
    ["R2", 'import { CardTitle as Title } from "../../ui/card";'],
    ["R2", 'import * as C from "@/ui/card";'],
    ["R3", 'export const X = () => <div className="rounded-xl border p-3" />;'],
    ["R3", "const c = `flex md:rounded-lg md:border-2 x`;"],
    ["R3", 'const c = cn("rounded-xl", "border p-3");'],
    ["R3", 'const c = cn("rounded-xl", ativo && "border", "p-3");'],
    ["R3", 'const c = cn("flex", cn("rounded-lg", "border"));'],
    ["R3", 'const c = "rounded-full border-2";'],
    ["R1", 'import "@/ui/tabs";'],
    ["R2", 'export { Card } from "../ui/card";'],
    ["R3", "const c = cn('rounded border-[1.5px] bg-card');"],
    ["R3", 'const c = "rounded border p-3";'],
    ["R3", 'const c = "rounded border md:border-0";'],
    ["R3", 'const c = "rounded border-0 data-[open]:border";'],
    ["R4", 'import { ListNoticeBody } from "@/ui/list-notice";'],
    [
      "R4",
      'import { ListTotalFooter } from "../catalog/screen-parts";\nexport const X = () => <ListTotalFooter count="" value={null} />;',
    ],
    ["R4", 'import { ListNotice, formatDate } from "./screen-parts";'],
    ["R4", 'import { RowTile as Tile } from "@/ui/row-tile";'],
    ["R4", 'import { type ListNotice } from "@/ui/list-notice";'],
    ["R4", 'import * as Parts from "../catalog/screen-parts";'],
    ["R4", 'const parts = await import("@/ui/list-total-footer");'],
    ["R4", 'export { RowTile } from "@/ui/row-tile";'],
  ] as const)("%s: %s reprova", (rule, text) => {
    expect(ruleHits(text)[rule]).toBeGreaterThan(0);
    const hits = new Map([["src/x/tela.tsx", ruleHits(text)]]);
    expect(
      listingFaults(hits, {
        allowlist: [],
        debt: { R1: [], R2: [], R3: [], R4: [] },
      })
    ).toEqual([`src/x/tela.tsx: fora do padrão (${rule}) e fora da lista`]);
  });

  it.each([
    'import { CardFrame, CardFramePanel } from "@/ui/card";',
    'import { Block, BlockPanel } from "@/ui/block";',
    'import { SectionTabs } from "@/ui/section-tabs";',
    'import { ScreenTabList } from "../app-shell/screen-tabs";',
    'import { Card } from "./card-list";',
    "// import { Tabs } from '@/ui/tabs'; <div className=\"rounded border\" />",
    'const a = "rounded-xl border-b";',
    'const a = "rounded-t-lg border-t";',
    'const a = "rounded-full border-border";',
    'const a = "border p-2";',
    'const a = "rounded-md bg-muted";',
    'const a = "borderless rounded";',
    'const a = "unrounded border";',
    'const a = "rounded-none border";',
    'const a = "rounded border-0 bg-muted";',
    'const a = cn("rounded-xl", "border-0", "p-2");',
    'import { ListBlock } from "@/ui/list-block";',
    'import { ListCountLine, LoadMoreButton } from "./screen-parts";',
    'import { RowOpenButton, formatDate } from "../catalog/screen-parts";',
    'import { RowTileSkeleton } from "./row-tile-skeleton";',
    'import { Block, BlockPanel } from "@/ui/block";',
    'import { Card } from "./card";',
    'import { Tabs } from "./tabs";',
    'const a = cn("rounded-xl", "bg-card");\nconst b = cn("border", "p-2");',
    '<input accept="image/*" />;\nconst a = "rounded border";'.replace(
      "rounded border",
      "rounded-md bg-muted"
    ),
  ])("%s passa", (text) => {
    expect(ruleHits(text)).toEqual(NONE);
  });

  it("uma exceção do ALLOWLIST cobre só a regra e o arquivo dela", () => {
    const hits = new Map([
      ["src/x/miniatura.tsx", ruleHits('const a = "rounded border";')],
    ]);
    const allowlist = [
      {
        file: "src/x/miniatura.tsx",
        reason: "thumbnail",
        why: "a miniatura de uma imagem",
      },
    ] as const;
    const debt = { R1: [], R2: [], R3: [], R4: [] };
    expect(listingFaults(hits, { allowlist, debt })).toEqual([]);
    expect(
      listingFaults(
        new Map([["src/x/outra.tsx", ruleHits('const a = "rounded border";')]]),
        { allowlist, debt }
      )
    ).toEqual([
      "src/x/outra.tsx: fora do padrão (R3) e fora da lista",
      "src/x/miniatura.tsx: exceção de R3 sem uso no ALLOWLIST: tire-a da lista",
    ]);
  });

  it("arquivo de dívida limpo e esquecido na lista reprova", () => {
    const hits = new Map([["src/x/tela.tsx", NONE]]);
    expect(
      listingFaults(hits, {
        allowlist: [],
        debt: { R1: [], R2: ["src/x/tela.tsx"], R3: [], R4: [] },
      })
    ).toEqual([
      "src/x/tela.tsx: limpo em R2 e ainda na lista de dívida: tire-o da lista",
    ]);
  });

  it("arquivo novo com Card reprova", () => {
    const hits = new Map([
      ["src/x/nova.tsx", ruleHits('import { Card } from "@/ui/card";')],
    ]);
    expect(
      listingFaults(hits, {
        allowlist: [],
        debt: { R1: [], R2: [], R3: [], R4: [] },
      })
    ).toEqual(["src/x/nova.tsx: fora do padrão (R2) e fora da lista"]);
  });

  it("exceção sem uso reprova", () => {
    expect(
      listingFaults(new Map(), {
        allowlist: [
          {
            file: "src/x/bolha.tsx",
            reason: "chart-bubble",
            why: "a bolha que acompanha o ponto do gráfico",
          },
        ],
        debt: { R1: [], R2: [], R3: [], R4: [] },
      })
    ).toEqual([
      "src/x/bolha.tsx: exceção de R3 sem uso no ALLOWLIST: tire-a da lista",
    ]);
  });
});

describe("a trava não isenta lista nem tabela (controles plantados)", () => {
  const LIST_FILE = [
    'import { Card } from "@/ui/card";',
    "export const Lista = () => (",
    '  <Card><ul className="divide-y"><li>x</li></ul></Card>',
    ");",
  ].join("\n");
  const none = { allowlist: [], debt: { R1: [], R2: [], R3: [], R4: [] } };

  it("um arquivo de lista com Card reprova pela R2", () => {
    const hits = new Map([["src/x/lista.tsx", ruleHits(LIST_FILE)]]);
    expect(listingFaults(hits, none)).toEqual([
      "src/x/lista.tsx: fora do padrão (R2) e fora da lista",
    ]);
  });

  it("o mesmo arquivo no ALLOWLIST de R3 também reprova: lista nunca é exceção", () => {
    const entry = {
      file: "src/x/lista.tsx",
      reason: "thumbnail",
      why: "a miniatura de uma imagem na linha",
    } as const;
    expect(exceptionFaults([entry], () => LIST_FILE)).toEqual([
      "src/x/lista.tsx: o arquivo desenha lista ou tabela, que nunca é exceção: use o Block",
    ]);
  });

  it.each([
    "<ul><li>a</li></ul>",
    '<div role="list" />',
    "<Table><TableRow /></Table>",
    '<div className="divide-y" />',
  ])("%s conta como lista ou tabela", (text) => {
    const entry = {
      file: "src/x/a.tsx",
      reason: "chart-bubble",
      why: "a bolha que acompanha o ponto do gráfico",
    } as const;
    expect(exceptionFaults([entry], () => text)).toHaveLength(1);
  });

  it("um motivo fora da lista fechada reprova, e uma exceção boa passa", () => {
    const ruim = {
      file: "src/x/a.tsx",
      reason: "quero-assim",
      why: "porque o desenho ficou melhor assim",
    } as unknown as Exception;
    expect(exceptionFaults([ruim], () => "<div />")).toEqual([
      'src/x/a.tsx: motivo "quero-assim" fora da lista fechada',
    ]);
    const boa = {
      file: "src/x/a.tsx",
      reason: "thumbnail",
      why: "a miniatura de uma imagem de produto",
    } as const;
    expect(exceptionFaults([boa], () => "<img />")).toEqual([]);
  });

  it("R2 não tem exceção: uma entrada do ALLOWLIST não cobre um Card", () => {
    const hits = new Map([
      ["src/x/a.tsx", ruleHits('import { Card } from "@/ui/card";')],
    ]);
    const entry = {
      file: "src/x/a.tsx",
      reason: "thumbnail",
      why: "a miniatura de uma imagem de produto",
    } as const;
    expect(listingFaults(hits, { ...none, allowlist: [entry] })).toContain(
      "src/x/a.tsx: fora do padrão (R2) e fora da lista"
    );
  });
});

describe("R4: as peças soltas da lista só vivem em ui/ (controles)", () => {
  const none = { allowlist: [], debt: { R1: [], R2: [], R3: [], R4: [] } };

  it("um arquivo plantado que importa o ListTotalFooter reprova pela R4", () => {
    const planted = [
      'import { ListTotalFooter } from "../catalog/screen-parts";',
      'export const Total = () => <ListTotalFooter count="" value={null} />;',
    ].join("\n");
    expect(
      listingFaults(new Map([["src/x/total.tsx", ruleHits(planted)]]), none)
    ).toEqual(["src/x/total.tsx: fora do padrão (R4) e fora da lista"]);
  });

  it("o arquivo que só usa o ListBlock passa, e o que ficou na dívida de R4 sem usar reprova", () => {
    const hits = new Map([
      [
        "src/x/lista.tsx",
        ruleHits('import { ListBlock } from "@/ui/list-block";'),
      ],
    ]);
    expect(
      listingFaults(hits, {
        ...none,
        debt: { ...none.debt, R4: ["src/x/lista.tsx"] },
      })
    ).toEqual([
      "src/x/lista.tsx: limpo em R4 e ainda na lista de dívida: tire-o da lista",
    ]);
  });

  it("os arquivos da dívida de R4 são os de hoje: as 5 telas que ainda importam e o screen-parts que reexporta", () => {
    expect(DEBT.R4).toEqual([
      "src/catalog/category-list.tsx",
      "src/catalog/product-list.tsx",
      "src/catalog/screen-parts.tsx",
      "src/expenses/expense-list.tsx",
      "src/offline/runtime/device-item.tsx",
    ]);
  });
});

describe("R5: Block com .map de linhas fora de um ListBlock (aviso)", () => {
  const BLOCK_WITH_ROWS = [
    'import { Block, BlockPanel } from "@/ui/block";',
    "export const Lista = ({ rows }) => (",
    '  <Block aria-labelledby="t">',
    "    <BlockPanel>{rows.map((row) => <Linha key={row.id} />)}</BlockPanel>",
    "  </Block>",
    ");",
  ].join("\n");

  it("avisa o arquivo plantado e não o reprova", () => {
    const hits = new Map([["src/x/lista.tsx", blockMapHits(BLOCK_WITH_ROWS)]]);
    expect(r5Warnings(hits)).toEqual([
      "src/x/lista.tsx: Block com .map de linhas fora de um ListBlock (R5, aviso): use o ListBlock",
    ]);
    expect(
      listingFaults(new Map([["src/x/lista.tsx", ruleHits(BLOCK_WITH_ROWS)]]), {
        allowlist: [],
        debt: { R1: [], R2: [], R3: [], R4: [] },
      })
    ).toEqual([]);
  });

  it.each([
    [
      "o ListBlock com as linhas",
      "<ListBlock>{rows.map((row) => <ListBlock.Row key={row} />)}</ListBlock>",
    ],
    ["um Block sem .map", '<Block aria-labelledby="t"><p>texto</p></Block>'],
    ["o Block do plain", '<Block variant="plain">{x}</Block>'],
    [
      "um Block que se fecha sozinho",
      '<Block aria-labelledby="t" />\n{rows.map(f)}',
    ],
    ["um .map fora do Block", '<Block aria-labelledby="t" />;\nrows.map(f);'],
    [
      "um .map só no comentário",
      '<Block aria-labelledby="t">{/* rows.map(f) */}<p /></Block>',
    ],
    [
      "um Block com .map só dentro de um ListBlock",
      '<Block aria-labelledby="t"><ListBlock>{rows.map(f)}</ListBlock></Block>',
    ],
  ])("não avisa %s", (_name, text) => {
    expect(blockMapHits(text)).toBe(0);
  });

  it.each([
    [
      "um Block dentro de outro",
      '<Block aria-labelledby="a"><Block aria-labelledby="b">{rows.map(f)}</Block></Block>',
      2,
    ],
    [
      "um Block com atributo que tem > e uma função",
      '<Block aria-labelledby="a" data-x={(a) => a > 1}>{rows.map(f)}</Block>',
      1,
    ],
  ])("avisa %s", (_name, text, count) => {
    expect(blockMapHits(text)).toBe(count);
  });
});

const folderOf = (file: string) => file.split("/")[1] ?? "";

/**
 * The text of a list of the debt as the source writes it. With `comments` each folder in `folders` has its comment
 * line, also when the last file of it is gone: the line that stays is what keeps the neighbour folders apart.
 */
function listText(
  files: readonly string[],
  comments: false | readonly string[]
): string {
  const lines: string[] = [];
  if (comments === false) {
    return `${files.map((file) => `    "${file}",`).join("\n")}\n`;
  }
  for (const folder of comments) {
    lines.push(`    // ${folder}`);
    for (const file of files.filter((entry) => folderOf(entry) === folder)) {
      lines.push(`    "${file}",`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** `git merge-file` of two edits of `base`: the merged text and whether it conflicted. */
function mergeThreeWay(base: string, mine: string, theirs: string) {
  const dir = mkdtempSync(join(tmpdir(), "debt-merge-"));
  try {
    for (const [name, text] of [
      ["base", base],
      ["mine", mine],
      ["theirs", theirs],
    ] as const) {
      writeFileSync(join(dir, name), text);
    }
    const run = spawnSync(
      "git",
      ["merge-file", "-p", "mine", "base", "theirs"],
      { cwd: dir, encoding: "utf8" }
    );
    if (run.error || run.status === null) {
      throw new Error(`git merge-file não rodou: ${run.error?.message}`);
    }
    return { conflicted: run.status !== 0, text: run.stdout };
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

describe("a dívida por pasta: tirar arquivos de pastas diferentes não conflita (AC-L0.8)", () => {
  const folders = [...new Set(DEBT.R2.map(folderOf))];
  const without = (folder: string | undefined) =>
    DEBT.R2.filter((file) => folderOf(file) !== folder);

  it("duas cópias da lista de R2, cada uma sem uma pasta vizinha diferente, mesclam sem conflito", () => {
    expect(folders.length).toBeGreaterThan(5);
    const base = listText(DEBT.R2, folders);
    for (const [index, folder] of folders.slice(0, -1).entries()) {
      const next = folders[index + 1];
      const merged = mergeThreeWay(
        base,
        listText(without(folder), folders),
        listText(without(next), folders)
      );
      expect(merged.conflicted, `${folder} e ${next}`).toBe(false);
      expect(merged.text).toBe(
        listText(
          DEBT.R2.filter((file) => ![folder, next].includes(folderOf(file))),
          folders
        )
      );
    }
  });

  it("controle: sem a linha de comentário por pasta as mesmas duas edições conflitam", () => {
    const [first, second] = folders;
    const merged = mergeThreeWay(
      listText(DEBT.R2, false),
      listText(without(first), false),
      listText(without(second), false)
    );
    expect(merged.conflicted).toBe(true);
  });

  it.each(RULES)(
    "a lista de %s tem um comentário por pasta, no começo de cada grupo",
    (rule) => {
      const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
      const start = source.indexOf(`  ${rule}: [\n`);
      const body = source.slice(start, source.indexOf("\n  ],", start));
      const lines = body.split("\n").slice(1);
      expect(lines.filter((line) => line.includes('"src/'))).toHaveLength(
        DEBT[rule].length
      );
      let last = "";
      for (const [index, line] of lines.entries()) {
        const file = line.match(DEBT_FILE)?.[1];
        if (file === undefined) {
          continue;
        }
        const folder = folderOf(file);
        if (folder !== last) {
          expect(lines[index - 1]?.trim(), file).toBe(`// ${folder}`);
        }
        last = folder;
      }
    }
  );
});
