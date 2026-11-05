import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SCREENS } from "./page";
import { stringLiterals } from "./visible-text";

const NOT_LETTER = String.raw`(?<![\p{L}\p{N}_-])`;
const NOT_LETTER_AFTER = String.raw`(?![\p{L}\p{N}_-])`;

const wordsOf = (alternatives: string) =>
  new RegExp(`${NOT_LETTER}(${alternatives})${NOT_LETTER_AFTER}`, "iu");

const SHELL_WORDS = wordsOf(
  [
    "capacidades?",
    "concessões",
    "concessão",
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
const TEST_HELPER = /(^|\/)test-[a-z-]+\.ts$/;

interface Kept {
  allowed: RegExp;
  file: string;
  start: string;
}

const PURGE = /purge/gi;

const KEPT: readonly Kept[] = [
  {
    allowed: PURGE,
    file: "ui/purge-words.ts",
    start: "a partir do próximo ciclo do purge",
  },
  {
    allowed: PURGE,
    file: "ui/purge-words.ts",
    start: "Agendar não apaga agora",
  },
  {
    allowed: PURGE,
    file: "ui/purge-words.ts",
    start: "Para agendar o purge",
  },
  {
    allowed: PURGE,
    file: "ui/purge-words.ts",
    start: "O purge só existe",
  },
  {
    allowed: PURGE,
    file: "ui/purge-words.ts",
    start: "Este atendimento está fechado: purge e trava legal",
  },
  {
    allowed: PURGE,
    file: "ui/purge-words.ts",
    start: "A loja foi encerrada há menos de 90 dias: o purge",
  },
  {
    allowed: PURGE,
    file: "ui/purge-words.ts",
    start: "Há uma trava legal vigente nesta loja: o purge",
  },
  {
    allowed: PURGE,
    file: "ui/purge-words.ts",
    start: "Este não é um atendimento de privacidade: o purge",
  },
  {
    allowed: PURGE,
    file: "ui/purge-words.ts",
    start: "O escopo do atendimento inclui dados que o purge",
  },
  {
    allowed: PURGE,
    file: "ui/purge-words.ts",
    start: "O escopo do atendimento não cobre tudo o que o purge",
  },
  {
    allowed: PURGE,
    file: "ui/purge-words.ts",
    start:
      "A renovação da assinatura ainda não foi cancelada no provedor: o purge",
  },
  {
    allowed: PURGE,
    file: "ui/purge-words.ts",
    start: "Não deu para ler a cobrança da loja",
  },
  {
    allowed: PURGE,
    file: "ui/purge-words.ts",
    start: "A loja volta a poder ser apagada pelas regras normais",
  },
  {
    allowed: PURGE,
    file: "ui/views/purge.ts",
    start: "O escopo deste atendimento não é exatamente o que o purge apaga",
  },
  { allowed: PURGE, file: "ui/views/purge.ts", start: "purge action-panel" },
  {
    allowed: PURGE,
    file: "ui/views/purge.ts",
    start: "Este atendimento está fechado: purge e trava legal precisam",
  },
  {
    allowed: /nesse caso/gi,
    file: "ui/views/privacy-case.ts",
    start: "Com a identidade não confirmada, só se recusa",
  },
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

function visibleLiterals(source: string): string[] {
  return stringLiterals(source).filter(
    (literal) => WHITESPACE.test(literal) || CAPITAL.test(literal)
  );
}

interface Hit {
  file: string;
  literal: string;
  word: string;
}

function hitsIn(
  files: { file: string; source: string }[],
  words: RegExp,
  kept: readonly Kept[]
): { hits: Hit[]; keptUsed: Set<number> } {
  const hits: Hit[] = [];
  const keptUsed = new Set<number>();
  for (const { file, source } of files) {
    for (const literal of visibleLiterals(source)) {
      const first = words.exec(literal)?.[1];
      if (first === undefined) {
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
  return { hits, keptUsed };
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
    const { hits } = hitsIn(screenFiles, TEXT_WORDS, KEPT);
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

  it("keeps the case of the cut: the word caso is kept nowhere", () => {
    const { hits } = hitsIn(
      screenFiles,
      wordsOf("casos?"),
      KEPT.filter((entry) => entry.allowed !== PURGE)
    );
    expect(
      hits.map((hit) => `${hit.file}: ${hit.literal.slice(0, 60)}`)
    ).toEqual([]);
  });
});

const template = (before: string, expression: string, after: string) =>
  ["const a = `", before, "$", "{", expression, "}", after, "`;"].join("");

describe("the scan reads what it should (a planted word in each shape of text)", () => {
  const scan = (source: string, kept: typeof KEPT = []) =>
    hitsIn([{ file: "x.ts", source }], TEXT_WORDS, kept).hits.map(
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
  ])("finds nothing in %s", (source) => {
    expect(scan(source)).toEqual([]);
  });

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
