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

const COMMENT = /\/\*[\s\S]*?\*\/|(?:^|\s)\/\/[^\n]*/gm;
const withoutComments = (text: string) => text.replace(COMMENT, "");

const STATEMENT =
  /\b(?:import|export)\s+([^;'"`]*?)\s*from\s*(["'`])([^"'`]+)\2/g;
const DYNAMIC = /\bimport\s*\(\s*(["'`])([^"'`]+)\1/g;
const UI_MODULE = (name: string) =>
  new RegExp(
    `^(?:@\\/ui|(?:\\.{1,2}\\/)+(?:[\\w-]+\\/)*ui)\\/${name}(?:\\.tsx?)?$|^\\.\\/${name}(?:\\.tsx?)?$`
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
// `rounded`, `rounded-xl`, `md:rounded-[calc(…)]`; not `rounded-t-*` nor `-b-*` (a corner of one side is no frame)
const ROUNDED =
  /(?:^|[\s"'`])(?:[\w[\]-]+:)*!?rounded(?:-(?!(?:t|b|l|r|s|e|tl|tr|bl|br|ss|se|es|ee)(?:-|[\s"'`]|$))[^\s"'`]+)?!?(?=[\s"'`]|$)/;
// a border on every side: `border`, `border-2`, `border-[1.5px]`; not `border-b`, `border-t`, `border-border` (a color)
const BORDER =
  /(?:^|[\s"'`])(?:[\w[\]-]+:)*!?border(?:-(?:\d+|\[\d[^\]]*\]))?!?(?=[\s"'`]|$)/;

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
    ...[...code.matchAll(DYNAMIC)].map(([, , specifier = ""]) => ({
      clause: "*",
      specifier,
    })),
  ];
  const opens = (clause: string) => clause.includes("*");
  const r1 = imports.some(({ specifier }) => TABS_MODULE.test(specifier));
  const r2 = imports.some(
    ({ clause, specifier }) =>
      CARD_MODULE.test(specifier) &&
      (opens(clause) || importedNames(clause).some((n) => CARD_NAMES.has(n)))
  );
  const r3 = [...code.matchAll(STRING_LITERAL)].filter(
    ([literal]) => ROUNDED.test(literal) && BORDER.test(literal)
  ).length;
  return { R1: r1 ? 1 : 0, R2: r2 ? 1 : 0, R3: r3 };
}

/**
 * The exceptions that stay: the file, the rule and why the pattern does not apply. Sorted by file; an exception no
 * file uses any more fails the test.
 */
export const ALLOWLIST: readonly { file: string; rule: Rule; why: string }[] =
  [];

/** The files of before the pattern, per rule: only shrinks, and each screen that migrates takes its files out. */
export const DEBT: Readonly<Record<Rule, readonly string[]>> = {
  R1: [
    "src/catalog/product-dialog.tsx",
    "src/catalog/product-import/import-preview-step.tsx",
    "src/dashboard/dashboard-page.tsx",
    "src/expenses/expenses-page.tsx",
  ],
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
  allowlist: readonly { file: string; rule: Rule; why: string }[];
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
      allowlist.filter((entry) => entry.rule === rule).map((e) => e.file)
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
        ALLOWLIST.filter((entry) => entry.rule === rule).filter(
          (entry) => !debt.includes(entry.file)
        ).length
    );
  });

  it("o ALLOWLIST é ordenado, cada exceção tem a razão escrita e nenhuma está também na dívida", () => {
    expect(ALLOWLIST.map((entry) => `${entry.rule} ${entry.file}`)).toEqual(
      ALLOWLIST.map((entry) => `${entry.rule} ${entry.file}`).sort()
    );
    for (const entry of ALLOWLIST) {
      expect(entry.why.length, entry.file).toBeGreaterThan(20);
      expect(DEBT[entry.rule], entry.file).not.toContain(entry.file);
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
        rule: "R3",
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
          { file: "src/x/bolha.tsx", rule: "R3", why: "a bolha do gráfico" },
        ],
        debt: { R1: [], R2: [], R3: [] },
      })
    ).toEqual([
      "src/x/bolha.tsx: exceção de R3 sem uso no ALLOWLIST: tire-a da lista",
    ]);
  });
});
