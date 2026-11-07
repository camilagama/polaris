import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SCREENS } from "./page";
import { type StringLiteral, stringLiteralsAt } from "./visible-text";

const NOT_LETTER = String.raw`(?<![\p{L}\p{N}_-])`;
const NOT_LETTER_AFTER = String.raw`(?![\p{L}\p{N}_-])`;

const wordsOf = (alternatives: string) =>
  new RegExp(`${NOT_LETTER}(${alternatives})${NOT_LETTER_AFTER}`, "iu");

const OWNER_WORDS = [
  "concess(?:ão|ões|ao|oes)",
  "direitos?",
  "ocorrências?",
  "comandos próprios",
  "uuids?",
  "pontos? de atenção",
  "fluxos? de privacidade",
  "janelas?(?!\\s+d[eao]s?(?![\\p{L}\\p{N}_-]))",
];

const SHELL_WORDS = wordsOf(
  [
    ...OWNER_WORDS,
    "capacidades?",
    "grants?",
    "dlq",
    "rls",
    "worker",
    "tokens?",
    "id de banco",
    "diagnóstic[oa]s?",
    "tenants?",
    "casos?",
    "incidentes?",
    "retry",
    "purge",
    "holds?",
    "entitlements?",
  ].join("|")
);

const TEXT_WORDS = wordsOf(
  [
    ...OWNER_WORDS,
    "casos?",
    "incidentes?",
    "dlq",
    "retry",
    "purge",
    "holds?",
    "grants?",
    "entitlements?",
    "diagnóstic[oa]s?",
  ].join("|")
);

const WHITESPACE = /\s/;
const CAPITAL = /^\p{Lu}/u;
const ONE_LOWERCASE_WORD = /^\p{Ll}+[.,:;!?…]?$/u;
const TEST_HELPER = /(^|\/)test-[a-z-]+\.ts$/;

interface Kept {
  allowed: RegExp;
  file: string;
  start: string;
}

const PURGE = /purge/gi;

const KEPT: readonly Kept[] = [
  {
    // a CSS class of the panel (admin.css selects it), not a text the operator reads
    allowed: PURGE,
    file: "ui/views/purge.ts",
    start: "purge action-panel",
  },
  {
    allowed: /nesse caso/gi,
    file: "ui/views/privacy-case.ts",
    start: "Com a identidade não confirmada, só se recusa",
  },
  {
    // the server's divergence, in the words of the UX review: the incident is what engineering receives
    allowed: /incidente/gi,
    file: "ui/refund-words.ts",
    start:
      " não é o que o provedor tem. Nada foi feito. A engenharia recebe um incidente;",
  },
];

interface Identifier {
  before: RegExp;
  file: string;
  word: string;
}

const UNION_MEMBER = /^\s*\| $/;
const ROUTE_ENTRY = /^\s*"\/[a-z]+": $/;
const SCREENS_LIST = /\bscreens: \[("[a-z-]+", )*$/;
const SCREEN_FIELD = /\bscreen: $/;
const SCREEN_COMPARED = /\brequest\.screen === $/;
const AREA_COMPARED = /\barea === $/;
const ACTION_FIELD = /\baction\??: $/;
const ACTION_KEY = /\baction: $/;
const KIND_KEY = /\bkind: $/;
const ACTION_COMPARED = /\b(request|context)\.action === $/;

/**
 * Lowercase single words the scan would read as a label but that are code: a route segment, a kind, a screen id, a key
 * of the domain. Each entry says what must come before the opening quote on its line, so a label that reuses the word
 * in another place is still caught. Every entry must still be found by the scan, so none outlives the code it excuses.
 */
const IDENTIFIERS: readonly Identifier[] = [
  { before: ACTION_FIELD, file: "ui/app.ts", word: "purge" },
  {
    before: /\bgetAttribute\("data-acao"\) === $/,
    file: "ui/main.ts",
    word: "purge",
  },
  { before: ACTION_FIELD, file: "ui/main.ts", word: "purge" },
  {
    before: /\bSupportCaseDetail\[$/,
    file: "ui/views/access.ts",
    word: "grants",
  },
  { before: /\{ class: $/, file: "ui/views/entitlements.ts", word: "grants" },
  { before: ACTION_COMPARED, file: "ui/views/privacy-case.ts", word: "purge" },
  { before: /\bStoreState\[$/, file: "ui/views/purge.ts", word: "hold" },
  { before: UNION_MEMBER, file: "src/ui/page.ts", word: "caso" },
  { before: SCREENS_LIST, file: "src/ui/page.ts", word: "caso" },
  { before: SCREEN_FIELD, file: "src/ui/page.ts", word: "caso" },
  { before: SCREEN_COMPARED, file: "src/ui/page.ts", word: "caso" },
  { before: UNION_MEMBER, file: "src/ui/page.ts", word: "casos" },
  { before: SCREENS_LIST, file: "src/ui/page.ts", word: "casos" },
  { before: ROUTE_ENTRY, file: "src/ui/page.ts", word: "casos" },
  { before: AREA_COMPARED, file: "src/ui/page.ts", word: "casos" },
  { before: SCREEN_COMPARED, file: "src/ui/page.ts", word: "casos" },
  { before: UNION_MEMBER, file: "src/ui/page.ts", word: "incidente" },
  { before: SCREENS_LIST, file: "src/ui/page.ts", word: "incidente" },
  { before: SCREEN_FIELD, file: "src/ui/page.ts", word: "incidente" },
  { before: UNION_MEMBER, file: "src/ui/page.ts", word: "incidentes" },
  { before: SCREENS_LIST, file: "src/ui/page.ts", word: "incidentes" },
  { before: ROUTE_ENTRY, file: "src/ui/page.ts", word: "incidentes" },
  { before: AREA_COMPARED, file: "src/ui/page.ts", word: "incidentes" },
  { before: ACTION_FIELD, file: "src/ui/page.ts", word: "purge" },
  { before: ACTION_COMPARED, file: "src/ui/page.ts", word: "purge" },
];

const repository = fileURLToPath(new URL("../../../..", import.meta.url));
const admin = join(repository, "apps/admin");

function sourcesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourcesUnder(path);
    }
    return path.endsWith(".ts") &&
      !path.endsWith(".test.ts") &&
      !TEST_HELPER.test(path)
      ? [path]
      : [];
  });
}

function visibleLiterals(source: string): StringLiteral[] {
  return stringLiteralsAt(source).filter(
    ({ text }) =>
      WHITESPACE.test(text) ||
      CAPITAL.test(text) ||
      ONE_LOWERCASE_WORD.test(text)
  );
}

function lineBefore(source: string, start: number): string {
  return source.slice(source.lastIndexOf("\n", start - 1) + 1, start);
}

interface Hit {
  file: string;
  literal: string;
  word: string;
}

function hitsIn(
  files: { file: string; source: string }[],
  words: RegExp,
  kept: readonly Kept[],
  identifiers: readonly Identifier[] = []
): { hits: Hit[]; identifiersUsed: Set<number>; keptUsed: Set<number> } {
  const hits: Hit[] = [];
  const keptUsed = new Set<number>();
  const identifiersUsed = new Set<number>();
  for (const { file, source } of files) {
    for (const { start, text: literal } of visibleLiterals(source)) {
      const first = words.exec(literal)?.[1];
      if (first === undefined) {
        continue;
      }
      const identifier = ONE_LOWERCASE_WORD.test(literal)
        ? identifiers.findIndex(
            (item) =>
              item.file === file &&
              item.word === literal &&
              item.before.test(lineBefore(source, start))
          )
        : -1;
      if (identifier !== -1) {
        identifiersUsed.add(identifier);
        continue;
      }
      const index = kept.findIndex(
        (item) => item.file === file && literal.startsWith(item.start)
      );
      const entry = kept[index];
      if (entry === undefined) {
        hits.push({ file, literal, word: first });
        continue;
      }
      keptUsed.add(index);
      const rest = words.exec(literal.replace(entry.allowed, ""))?.[1];
      if (rest !== undefined) {
        hits.push({ file, literal, word: rest });
      }
    }
  }
  return { hits, identifiersUsed, keptUsed };
}

const screenFiles = [
  ...sourcesUnder(join(admin, "ui")),
  join(admin, "src/ui/page.ts"),
].map((path) => ({
  file: relative(admin, path),
  source: readFileSync(path, "utf8"),
}));

describe("the words the operator does not read (AC-IA3)", () => {
  it("keeps the system's words out of the menu, the titles and the sentences", () => {
    const found = Object.entries(SCREENS).flatMap(
      ([screen, { purpose, title }]) =>
        [title, purpose].flatMap((text) => {
          const word = SHELL_WORDS.exec(text)?.[1];
          return word === undefined ? [] : [`${screen}: ${word} in "${text}"`];
        })
    );
    expect(found).toEqual([]);
  });

  it("keeps them out of every text the screens write, but for the exact texts kept", () => {
    const { hits } = hitsIn(screenFiles, TEXT_WORDS, KEPT, IDENTIFIERS);
    expect(
      hits.map(
        (hit) => `${hit.file}: ${hit.word} in "${hit.literal.slice(0, 80)}"`
      )
    ).toEqual([]);
  });

  it("keeps no text that the scan no longer finds in the list of texts kept", () => {
    const { keptUsed } = hitsIn(screenFiles, TEXT_WORDS, KEPT);
    expect([...keptUsed].sort((a, b) => a - b)).toEqual(
      KEPT.map((_, index) => index)
    );
  });

  it("keeps no identifier that the scan no longer finds in the list of identifiers", () => {
    const { identifiersUsed } = hitsIn(
      screenFiles,
      TEXT_WORDS,
      KEPT,
      IDENTIFIERS
    );
    expect([...identifiersUsed].sort((a, b) => a - b)).toEqual(
      IDENTIFIERS.map((_, index) => index)
    );
  });

  it("keeps the case of the cut: the word caso is kept nowhere as a text", () => {
    const { hits } = hitsIn(
      screenFiles,
      wordsOf("casos?"),
      KEPT.filter((entry) => entry.allowed !== PURGE),
      IDENTIFIERS
    );
    expect(
      hits.map((hit) => `${hit.file}: ${hit.literal.slice(0, 60)}`)
    ).toEqual([]);
  });
});

const template = (before: string, expression: string, after: string) =>
  ["const a = `", before, "$", "{", expression, "}", after, "`;"].join("");

describe("the scan reads what it should (a planted word in each shape of text)", () => {
  const scan = (
    source: string,
    kept: typeof KEPT = [],
    identifiers: typeof IDENTIFIERS = []
  ) =>
    hitsIn([{ file: "x.ts", source }], TEXT_WORDS, kept, identifiers).hits.map(
      (hit) => hit.word
    );

  it.each([
    ['const a = "Abrir caso aberto";', ["caso"]],
    ["const a = 'Ver incidentes';", ["incidentes"]],
    [template("Cancelar o purge de ", "name", ""), ["purge"]],
    [template("", "name", ": Purge agendado"), ["Purge"]],
    [template("", "f({ b: 1 })", " Ver o hold da loja"), ["hold"]],
    ['const a = "O DLQ está cheio";', ["DLQ"]],
    ['const a = "Pedir o retry agora";', ["retry"]],
    ['const a = "Dar um grant à loja";', ["grant"]],
    ['const a = "Abrir o Diagnóstico";', ["Diagnóstico"]],
    ['const a = "Só vale nesse caso.";', ["caso"]],
    ['const a = "purge";', ["purge"]],
    ["const a = { label: 'caso' };", ["caso"]],
    ['const a = "retry";', ["retry"]],
    ['const a = "diagnóstico";', ["diagnóstico"]],
    ['const a = "caso.";', ["caso"]],
    ['const a = "retry?";', ["retry"]],
    ['const a = "Dar uma concessão";', ["concessão"]],
    ['const a = "As concessões em vigor";', ["concessões"]],
    ['const a = "Nenhum direito está acima do plano";', ["direito"]],
    ['const a = "Ocorrências";', ["Ocorrências"]],
    ['const a = "pelos comandos próprios";', ["comandos próprios"]],
    ['const a = "O ID (UUID) do registro";', ["UUID"]],
    ['const a = "Nenhum ponto de atenção.";', ["ponto de atenção"]],
    ['const a = "Pontos de atenção";', ["Pontos de atenção"]],
    ['const a = "Fica no fluxo de privacidade.";', ["fluxo de privacidade"]],
    ['const a = "Nada nessa janela.";', ["janela"]],
    ['const a = "lojas criadas na janela";', ["janela"]],
    [template("", "n", " lojas na janela"), ["janela"]],
    ['const a = "A janela passou.";', ["janela"]],
    ['const a = "janela";', ["janela"]],
  ])("finds the word in %s", (source, words) => {
    expect(scan(source)).toEqual(words);
  });

  it.each([
    ["// Abrir caso\nconst a = 1;"],
    ["/* o purge da loja */ const a = 1;"],
    ["const caso = 1; const purge = caso + 1;"],
    ['const a = "purge-titulo";'],
    ['const a = "organization:purge";'],
    ['const a = "/casos/novo";'],
    [template("", "casos.length", " atendimentos")],
    ['const a = "Janela de reembolso consultada";'],
    ['const a = "A janela de recuperação da loja";'],
    ['const a = "dentro da janela do estorno";'],
    ['const a = "O isUuid decide";'],
    ['const a = "concessao-revisao";'],
    ["const uuid = crypto.randomUUID();"],
  ])("finds nothing in %s", (source) => {
    expect(scan(source)).toEqual([]);
  });

  it("lets a lowercase single word through only when the file, the word and what comes before it are listed as an identifier", () => {
    const source = 'const a = { action: "purge" };';
    const listed = { before: ACTION_KEY, file: "x.ts", word: "purge" };
    expect(scan(source)).toEqual(["purge"]);
    expect(scan(source, [], [listed])).toEqual([]);
    expect(scan(source, [], [{ ...listed, file: "y.ts" }])).toEqual(["purge"]);
    expect(scan(source, [], [{ ...listed, word: "caso" }])).toEqual(["purge"]);
    expect(scan(source, [], [{ ...listed, before: KIND_KEY }])).toEqual([
      "purge",
    ]);
    expect(scan('const a = "O purge";', [], [listed])).toEqual(["purge"]);
  });

  it("catches a label that reuses a listed identifier in the same file", () => {
    const listed = { before: ACTION_KEY, file: "x.ts", word: "purge" };
    const real = 'type A = { action: "purge" };';
    const label = 'const b = { label: "purge" };';
    expect(scan(`${real}\n${label}`, [], [listed])).toEqual(["purge"]);
    expect(scan(`${label}\n${real}`, [], [listed])).toEqual(["purge"]);
    expect(
      scan('const c = { action: "purge", label: "purge" };', [], [listed])
    ).toEqual(["purge"]);
  });

  it.each(
    [...new Set(IDENTIFIERS.map((item) => `${item.file}|${item.word}`))].map(
      (key) => key.split("|") as [string, string]
    )
  )(
    "catches a label %s planted next to the real identifiers of %s",
    (file, word) => {
      const real = screenFiles.find((entry) => entry.file === file)?.source;
      expect(real).toBeDefined();
      const scanFile = (source: string) =>
        hitsIn([{ file, source }], TEXT_WORDS, KEPT, IDENTIFIERS).hits.map(
          (hit) => `${hit.word} in "${hit.literal}"`
        );
      expect(scanFile(real ?? "")).toEqual([]);
      expect(
        scanFile(`${real}\nexport const planted = { label: "${word}" };`)
      ).toEqual([`${word} in "${word}"`]);
    }
  );

  it("lets a text through only when the file and the start of the text are listed, and only its allowed word", () => {
    const source = 'const a = "O purge só existe para loja encerrada.";';
    const listed = { allowed: PURGE, file: "x.ts", start: "O purge só" };
    expect(scan(source)).toEqual(["purge"]);
    expect(scan(source, [listed])).toEqual([]);
    expect(scan(source, [{ ...listed, file: "y.ts" }])).toEqual(["purge"]);
    expect(scan(source, [{ ...listed, start: "Outro texto" }])).toEqual([
      "purge",
    ]);
    const other = 'const a = "O purge só existe para o incidente.";';
    expect(scan(other, [listed])).toEqual(["incidente"]);
  });
});
