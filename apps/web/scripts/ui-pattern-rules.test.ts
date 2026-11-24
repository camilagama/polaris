import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * O padrão visual das telas (DESIGN.md "Peças de padrão"): uma peça pública por papel, e o que foge dela reprova.
 *
 * - R1: aba de tela e filtro não importam o `Tabs` cru (`@/ui/tabs`): só `ui/` o importa (o `SectionTabs` vive lá).
 * - R2: nenhuma tela importa `Card`, `CardHeader`, `CardContent`, `CardTitle` nem `CardDescription`: a moldura é o `Block`.
 * - R3: nenhuma tela escreve à mão uma moldura (`rounded` e `border` de largura simples na mesma string de classe).
 *
 * A varredura é `src/**` fora de `ui/`, da galeria e dos testes. Cada regra tem uma lista de dívida com os arquivos de
 * antes do padrão, que só encolhe: arquivo novo fora do padrão reprova, e arquivo da lista que já está limpo também
 * (quem migra a tela tira o arquivo da lista no mesmo PR). `ALLOWLIST` guarda as exceções que ficam para sempre, cada
 * uma com a razão, e reprova quando a exceção deixa de ser usada.
 */
const web = fileURLToPath(new URL("..", import.meta.url));

type Rule = "R1" | "R2" | "R3";

const RULES: readonly Rule[] = ["R1", "R2", "R3"];

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
const NAMED_IMPORTS = /\{([^}]*)\}/;

function importedNames(clause: string): string[] {
  const named = clause.match(NAMED_IMPORTS)?.[1] ?? "";
  return named
    .split(",")
    .map((part) => part.trim().split(AS_KEYWORD)[0] ?? "")
    .filter((name) => name !== "");
}

/** The rules a source breaks: R1 and R2 once each, R3 once per string of class with a frame written by hand. */
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
  const r3 = classStrings(code).filter(
    (classes) => ROUNDED.test(` ${classes} `) && BORDER.test(` ${classes} `)
  ).length;
  return { R1: r1 ? 1 : 0, R2: r2 ? 1 : 0, R3: r3 };
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

/** The files of before the pattern, per rule: only shrinks, and each screen that migrates takes its files out. */
export const DEBT: Readonly<Record<Rule, readonly string[]>> = {
  R1: ["src/catalog/product-import/import-preview-step.tsx"],
  R2: [
    "src/app-shell/state-panel.tsx",
    "src/catalog/category-form.tsx",
    "src/catalog/category-list.tsx",
    "src/catalog/product-list.tsx",
    "src/catalog/public-catalog-panels.tsx",
    "src/catalog/screen-parts.tsx",
    "src/customers/customer-list.tsx",
    "src/dashboard/goal-card.tsx",
    "src/dashboard/goals-panel.tsx",
    "src/dashboard/result-chain.tsx",
    "src/data-export/data-export-cards.tsx",
    "src/data-export/data-export-list.tsx",
    "src/expenses/expense-by-category.tsx",
    "src/expenses/expense-categories-panel.tsx",
    "src/expenses/expense-rules-panel.tsx",
    "src/expenses/expenses-page.tsx",
    "src/help/help-page.tsx",
    "src/home/home-goal.tsx",
    "src/home/home-parts.tsx",
    "src/inventory/inventory-page.tsx",
    "src/offline/attention-panel.tsx",
    "src/offline/logout-dialog.tsx",
    "src/offline/runtime/device-item.tsx",
    "src/offline/runtime/devices-page.tsx",
    "src/organization/close-store-section.tsx",
    "src/organization/closed-queue-section.tsx",
    "src/organization/closed-store-page.tsx",
    "src/payment-profiles/payment-profile-list.tsx",
    "src/sales/offline-sale-panels.tsx",
    "src/sales/sale-confirmed-panel.tsx",
    "src/sales/sale-customer-panel.tsx",
    "src/sales/sale-detail-page.tsx",
    "src/sales/sale-history-empty.tsx",
    "src/sales/sale-history-list.tsx",
    "src/sales/sale-history-page.tsx",
    "src/sales/sale-id-missing.tsx",
    "src/sales/sale-item-editor.tsx",
    "src/sales/sale-page.tsx",
    "src/sales/sale-payment-section.tsx",
    "src/sales/sale-receipt.tsx",
    "src/sales/sale-summary-panel.tsx",
    "src/sales/sale-timeline.tsx",
    "src/settings/email-preference-card.tsx",
    "src/settings/settings-screen.tsx",
    "src/sign-in/change-password-page.tsx",
    "src/sign-in/entry-ui.tsx",
    "src/subscription/subscription-commands.tsx",
    "src/subscription/subscription-offer.tsx",
    "src/subscription/subscription-page.tsx",
    "src/subscription/subscription-parts.tsx",
    "src/subscription/subscription-waiting.tsx",
  ],
  R3: [
    "src/app-shell/action-strip.tsx",
    "src/app-shell/menu-progress.tsx",
    "src/app-shell/store-card.tsx",
    "src/catalog/product-form.tsx",
    "src/catalog/product-media-crop.tsx",
    "src/catalog/product-media-list.tsx",
    "src/catalog/product-media-panel.tsx",
    "src/catalog/product-variants-form.tsx",
    "src/customers/customer-form.tsx",
    "src/customers/customer-list.tsx",
    "src/expenses/expense-filters.tsx",
    "src/expenses/expense-list.tsx",
    "src/expenses/month-picker.tsx",
    "src/home/home-figures.tsx",
    "src/inventory/stock-command-panel.tsx",
    "src/inventory/stock-panel-fields.tsx",
    "src/legal/legal-page.tsx",
    "src/offline/runtime/logout-control.tsx",
    "src/offline/runtime/sync-status.tsx",
    "src/payment-profiles/payment-profile-list.tsx",
    "src/sales/offline-sale-panels.tsx",
    "src/sales/sale-payment-section.tsx",
    "src/sales/sale-summary-panel.tsx",
    "src/subscription/subscription-commands.tsx",
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
      "src/customers/customer-list.tsx",
      "src/expenses/expense-list.tsx",
      "src/inventory/inventory-page.tsx",
      "src/sales/sale-history-page.tsx",
      "src/sales/sale-history-list.tsx",
    ]) {
      expect([...DEBT.R2, ...DEBT.R3], file).toContain(file);
    }
  });
});

const NONE = { R1: 0, R2: 0, R3: 0 };

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
  ] as const)("%s: %s reprova", (rule, text) => {
    expect(ruleHits(text)[rule]).toBeGreaterThan(0);
    const hits = new Map([["src/x/tela.tsx", ruleHits(text)]]);
    expect(
      listingFaults(hits, {
        allowlist: [],
        debt: { R1: [], R2: [], R3: [] },
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
    const debt = { R1: [], R2: [], R3: [] };
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
        debt: { R1: [], R2: ["src/x/tela.tsx"], R3: [] },
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
        debt: { R1: [], R2: [], R3: [] },
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
        debt: { R1: [], R2: [], R3: [] },
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
  const none = { allowlist: [], debt: { R1: [], R2: [], R3: [] } };

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
