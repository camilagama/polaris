import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The button says the choice ("Excluir venda" / "Manter"), never "OK", "Sim" or "Sim, <verbo>" (DESIGN.md,
 * "Diálogo de formulário"). The scan reads every `.tsx` of `src` as text, so a label added to any screen is caught, and
 * also the `*-texts.ts` constants that hold button text; a plain `.ts` is not read, because it would flag
 * strings that are not labels. The `*-model.ts` files, where some confirmation labels live, are read only
 * for "Sim, <verbo>", since their other strings are not button text. Only the gallery and the labs, which are not product screens, stay out, and
 * the exclusions are listed exactly. A second rule bounds a literal `<Button>` label at 5 words and no final
 * period; it reads the text written straight before `</Button>`, joining the pieces that JSX splits with
 * `{" "}` and line breaks, so a label that comes from a constant or a prop, or that is followed by an
 * icon or another element, is not counted.
 */
const SRC = fileURLToPath(new URL("../src", import.meta.url));
const EXCLUDED_FOLDERS = ["offline-poc/", "ui-gallery/"];
const TEST_FILE = /\.(?:test|spec)\.tsx?$/;
const TEXTS_CONSTANTS = /-texts\.ts$/;
const MODEL_CONSTANTS = /-model\.ts$/;
const JSX_TEXT = />\s*(OK|Ok|Sim(?:,[^<>{}]*?)?)[.!]?\s*<\//g;
const SIM_VERB_LITERAL = /["'`](Sim, [^"'`\n]*?)[.!]?["'`]/g;
const STRING_LITERAL = /["'`](OK|Ok|Sim(?:, [^"'`\n]*?)?)[.!]?["'`]/g;
const JSX_SPACE = String.raw`\{\s*(?:"\s+"|'\s+')\s*\}`;
const BUTTON_LITERAL_TEXT = new RegExp(
  `>((?:[^<>{}]|${JSX_SPACE})+)</Button>`,
  "g"
);
const JSX_SPACE_EXPRESSION = new RegExp(JSX_SPACE, "g");
const MAX_BUTTON_WORDS = 5;
const WHITESPACE = /\s+/;

interface AllowedLabel {
  file: string;
  label: string;
  reason: string;
}

/**
 * Labels over the word limit that keep their text until the design decides. The key is file and label
 * text, never a line number, so moving the button inside the file does not fail the entry; an entry that no
 * longer matches any label fails, so the list cannot outlive its last button.
 */
const ALLOWED: readonly AllowedLabel[] = [];

interface LabelFinding {
  file: string;
  line: number;
  label: string;
  problem: string;
}

function genericButtonLabels(source: string): string[] {
  return [
    ...[...source.matchAll(JSX_TEXT)].map((match) => match[1] ?? ""),
    ...[...source.matchAll(STRING_LITERAL)].map((match) => match[1] ?? ""),
  ];
}

function buttonLabelProblem(label: string): string | null {
  const words = label.split(" ").length;
  if (words > MAX_BUTTON_WORDS) {
    return `${words} words, the limit is ${MAX_BUTTON_WORDS}`;
  }
  return label.endsWith(".") ? "ends with a period" : null;
}

function buttonLabelFindings(source: string, file: string): LabelFinding[] {
  return [...source.matchAll(BUTTON_LITERAL_TEXT)].flatMap((match) => {
    const label = (match[1] ?? "")
      .replace(JSX_SPACE_EXPRESSION, " ")
      .split(WHITESPACE)
      .filter(Boolean)
      .join(" ");
    const problem = buttonLabelProblem(label);
    if (problem === null) {
      return [];
    }
    const line = source.slice(0, match.index).split("\n").length;
    return [{ file, label, line, problem }];
  });
}

function simVerbLabels(source: string): string[] {
  return [...source.matchAll(SIM_VERB_LITERAL)].map((match) => match[1] ?? "");
}

function sourceFiles(
  directory: string,
  isSource: (name: string) => boolean
): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path, isSource);
    }
    return isSource(entry.name) && !TEST_FILE.test(entry.name) ? [path] : [];
  });
}

function isScreenSource(name: string): boolean {
  return name.endsWith(".tsx") || TEXTS_CONSTANTS.test(name);
}

function scanWith(root: string, isSource: (name: string) => boolean): string[] {
  return sourceFiles(root, isSource)
    .map((path) => relative(root, path).split(sep).join("/"))
    .filter(
      (path) => !EXCLUDED_FOLDERS.some((folder) => path.startsWith(folder))
    )
    .sort();
}

function scan(root: string): string[] {
  return scanWith(root, isScreenSource);
}

function scanModels(root: string): string[] {
  return scanWith(root, (name) => MODEL_CONSTANTS.test(name));
}

function findings(root: string): string[] {
  const read = (path: string) => readFileSync(join(root, path), "utf8");
  return [
    ...scan(root).flatMap((path) =>
      genericButtonLabels(read(path)).map((label) => `${path}: ${label}`)
    ),
    ...scanModels(root).flatMap((path) =>
      simVerbLabels(read(path)).map((label) => `${path}: ${label}`)
    ),
  ];
}

function describeFinding(found: LabelFinding): string {
  return `${found.file}:${found.line}: "${found.label}" (${found.problem})`;
}

function labelProblems(root: string, allowed: readonly AllowedLabel[]) {
  const found = scan(root).flatMap((path) =>
    buttonLabelFindings(readFileSync(join(root, path), "utf8"), path)
  );
  const same = (entry: AllowedLabel, item: LabelFinding) =>
    entry.file === item.file && entry.label === item.label;
  const unused = allowed.filter(
    (entry) => !found.some((item) => same(entry, item))
  );
  const violations = found.filter(
    (item) => !allowed.some((entry) => same(entry, item))
  );
  return {
    unused: unused.map((entry) => `${entry.file}: "${entry.label}"`),
    violations: violations.map(describeFinding),
  };
}

const planted = mkdtempSync(join(tmpdir(), "button-labels-"));
afterAll(() => rmSync(planted, { force: true, recursive: true }));

function plant(files: Record<string, string>): string {
  const root = mkdtempSync(join(planted, "src-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

describe("button labels say the choice, not OK, Sim or Sim, <verbo>", () => {
  it("scans the screens and leaves out only the gallery and the labs", () => {
    expect(EXCLUDED_FOLDERS).toEqual(["offline-poc/", "ui-gallery/"]);
    const scanned = scan(SRC);
    expect(scanned.length).toBeGreaterThan(250);
    expect(scanned).toContain("legal/acceptance/acceptance-page.tsx");
    expect(scanned).toContain("offline/attention-panel.tsx");
    expect(scanned).toContain("legal/acceptance/acceptance-texts.ts");
    expect(scanned).toContain("sign-in/password-texts.ts");
    expect(scanned).toContain("sign-in/sign-in-texts.ts");
    const models = scanModels(SRC);
    expect(models.length).toBeGreaterThan(30);
    for (const name of [
      "devices-model.ts",
      "closed-store-model.ts",
      "closed-queue-model.ts",
    ]) {
      expect(models.some((path) => path.endsWith(`/${name}`))).toBe(true);
    }
    expect(
      readdirSync(SRC)
        .filter((name) => EXCLUDED_FOLDERS.includes(`${name}/`))
        .sort()
    ).toEqual(["offline-poc", "ui-gallery"]);
  });

  it("finds no OK, Sim or Sim, <verbo> label in any screen", () => {
    expect(findings(SRC)).toEqual([]);
  });

  it("plant: a screen with the label fails, in a folder or a file the scan must read", () => {
    const root = plant({
      "sales/deep/screen.tsx": "export const A = () => <Button>OK</Button>;",
      "ui/dialog-sample.tsx": 'export const B = "Sim";',
    });
    expect(findings(root)).toEqual([
      "sales/deep/screen.tsx: OK",
      "ui/dialog-sample.tsx: Sim",
    ]);
  });

  it("plant: a *-texts.ts constant with the label fails, and passes without it", () => {
    const dirty = plant({
      "legal/deep/sample-texts.ts":
        'export const texts = { confirm: "OK", cancel: "Sim" } as const;',
    });
    expect(findings(dirty)).toEqual([
      "legal/deep/sample-texts.ts: OK",
      "legal/deep/sample-texts.ts: Sim",
    ]);
    const clean = plant({
      "legal/deep/sample-texts.ts":
        'export const texts = { confirm: "Aceitar e continuar", cancel: "Manter" } as const;',
    });
    expect(scan(clean)).toEqual(["legal/deep/sample-texts.ts"]);
    expect(findings(clean)).toEqual([]);
  });

  it("control: a .ts that is not *-texts.ts, and a texts test, are not read", () => {
    const root = plant({
      "legal/helper.ts": 'export const a = "OK";',
      "legal/sample-texts.test.ts": 'export const b = "Sim";',
      "legal/sample-texts.ts": 'export const c = "Manter";',
      "ui-gallery/sample-texts.ts": 'export const d = "OK";',
    });
    expect(scan(root)).toEqual(["legal/sample-texts.ts"]);
    expect(findings(root)).toEqual([]);
  });

  it("plant: a *-model.ts constant with Sim, <verbo> fails, and passes without it", () => {
    const dirty = plant({
      "settings/deep/devices-model.ts":
        'export const CONFIRM = "Sim, revogar este aparelho";',
    });
    expect(findings(dirty)).toEqual([
      "settings/deep/devices-model.ts: Sim, revogar este aparelho",
    ]);
    const clean = plant({
      "settings/deep/devices-model.ts":
        'export const CONFIRM = "Revogar aparelho";',
    });
    expect(scanModels(clean)).toEqual(["settings/deep/devices-model.ts"]);
    expect(findings(clean)).toEqual([]);
  });

  it("control: a *-model.ts is read only for Sim, <verbo>, and its test and the labs are not read", () => {
    const root = plant({
      "settings/alone-model.ts":
        'export const a = "OK"; export const b = "Sim"; export const c = "Diga Sim, por favor"; export const d = "Simples, direto";',
      "settings/other-model.test.ts":
        'export const e = "Sim, revogar este aparelho";',
      "settings/model.ts": 'export const f = "Sim, revogar este aparelho";',
      "offline-poc/lab-model.ts":
        'export const g = "Sim, revogar este aparelho";',
      "ui-gallery/sample-model.ts":
        'export const h = "Sim, revogar este aparelho";',
    });
    expect(scanModels(root)).toEqual(["settings/alone-model.ts"]);
    expect(findings(root)).toEqual([]);
  });

  it("control: the gallery, the labs and test files are left out, and only they", () => {
    const root = plant({
      "offline-poc/lab.tsx": "export const A = () => <Button>OK</Button>;",
      "sales/screen.test.tsx": "export const B = () => <Button>Sim</Button>;",
      "sales/screen.tsx": "export const C = () => <Button>Manter</Button>;",
      "ui-gallery/gallery.tsx": "export const D = () => <Button>OK</Button>;",
    });
    expect(scan(root)).toEqual(["sales/screen.tsx"]);
    expect(findings(root)).toEqual([]);
  });

  it.each([
    ["JSX text", "<Button>OK</Button>", ["OK"]],
    ["JSX text with a prop", '<Button variant="outline">Sim</Button>', ["Sim"]],
    [
      "JSX text after an arrow function prop",
      "<Button onClick={() => close()}>OK</Button>",
      ["OK"],
    ],
    ["JSX text with spaces", "<Button>\n  Sim\n</Button>", ["Sim"]],
    ["JSX text with a period", "<Button>Ok.</Button>", ["Ok"]],
    ["string constant", 'const CONFIRM = "OK";', ["OK"]],
    ["template literal", "const CONFIRM = `Sim`;", ["Sim"]],
    [
      "JSX text with Sim, <verbo>",
      '<Button variant="destructive">Sim, descartar e recomeçar</Button>',
      ["Sim, descartar e recomeçar"],
    ],
    [
      "string constant with Sim, <verbo>",
      'const CONFIRM = "Sim, revogar este aparelho";',
      ["Sim, revogar este aparelho"],
    ],
    [
      "string constant with Sim, <verbo> and a final period",
      'const CONFIRM = "Sim, descartar.";',
      ["Sim, descartar"],
    ],
    [
      "template literal with Sim, <verbo>",
      "const CONFIRM = `Sim, desfazer`;",
      ["Sim, desfazer"],
    ],
  ])("plant: %s is caught", (_name, source, expected) => {
    expect(genericButtonLabels(source)).toEqual(expected);
  });

  it.each([
    ["a label that says the choice", "<Button>Excluir venda</Button>"],
    ["a word that only contains it", 'const x = "Simples"; const y = "Book";'],
    ["a sentence that only has Sim inside", 'const x = "Diga Sim, por favor";'],
    [
      "a word that starts with Sim, with a comma",
      'const x = "Simples, direto";',
    ],
    ["a tone key in lowercase", "const tone = 'ok';"],
  ])("control: %s is not caught", (_name, source) => {
    expect(genericButtonLabels(source)).toEqual([]);
  });
});

describe("button labels have at most 5 words and no final period", () => {
  it("lists only labels that still exist, each with a reason", () => {
    expect(ALLOWED.every((entry) => entry.reason.length > 0)).toBe(true);
    expect(labelProblems(SRC, ALLOWED).unused).toEqual([]);
  });

  it("finds no label over the limit or ending in a period outside the list", () => {
    expect(labelProblems(SRC, ALLOWED).violations).toEqual([]);
  });

  it("plant: 6 words and a final period fail, 5 words pass", () => {
    const root = plant({
      "sales/long.tsx":
        "export const A = () => <Button>Cancelar esta venda e começar outra</Button>;",
      "sales/period.tsx":
        "export const B = () => <Button>Manter meta.</Button>;",
      "sales/five.tsx":
        "export const C = () => <Button>Escolher outra forma de pagamento</Button>;",
    });
    expect(labelProblems(root, []).violations).toEqual([
      'sales/long.tsx:1: "Cancelar esta venda e começar outra" (6 words, the limit is 5)',
      'sales/period.tsx:1: "Manter meta." (ends with a period)',
    ]);
  });

  it("plant: a label split across lines and after an arrow function prop is counted", () => {
    const root = plant({
      "sales/multi.tsx":
        "const A = () => (\n  <Button onClick={() => close()}>\n    Cancelar esta venda\n    e começar outra\n  </Button>\n);",
    });
    expect(labelProblems(root, []).violations).toEqual([
      'sales/multi.tsx:2: "Cancelar esta venda e começar outra" (6 words, the limit is 5)',
    ]);
  });

  it("plant: an allowed label passes, and an entry that no longer matches fails", () => {
    const root = plant({
      "sales/long.tsx":
        "export const A = () => <Button>Cancelar esta venda e começar outra</Button>;",
    });
    const entry = {
      file: "sales/long.tsx",
      label: "Cancelar esta venda e começar outra",
      reason: "a decidir (Petković/Bruno)",
    };
    expect(labelProblems(root, [entry])).toEqual({
      unused: [],
      violations: [],
    });
    expect(
      labelProblems(root, [{ ...entry, label: "Cancelar esta venda" }])
    ).toEqual({
      unused: ['sales/long.tsx: "Cancelar esta venda"'],
      violations: [
        'sales/long.tsx:1: "Cancelar esta venda e começar outra" (6 words, the limit is 5)',
      ],
    });
    expect(
      labelProblems(root, [{ ...entry, file: "sales/other.tsx" }])
    ).toEqual({
      unused: ['sales/other.tsx: "Cancelar esta venda e começar outra"'],
      violations: [
        'sales/long.tsx:1: "Cancelar esta venda e começar outra" (6 words, the limit is 5)',
      ],
    });
    const fixed = plant({
      "sales/long.tsx":
        "export const A = () => <Button>Descartar venda</Button>;",
    });
    expect(labelProblems(fixed, [entry]).unused).toEqual([
      'sales/long.tsx: "Cancelar esta venda e começar outra"',
    ]);
  });

  it("plant: an allowed label that moves to another line still passes", () => {
    const root = plant({
      "sales/long.tsx":
        "const unrelated = 1;\nconst another = 2;\nexport const A = () => <Button>Cancelar esta venda e começar outra</Button>;",
    });
    const entry = {
      file: "sales/long.tsx",
      label: "Cancelar esta venda e começar outra",
      reason: "a decidir (Petković/Bruno)",
    };
    expect(labelProblems(root, [entry])).toEqual({
      unused: [],
      violations: [],
    });
  });

  it("plant: a label split by a JSX space expression is joined and counted", () => {
    const root = plant({
      "sales/split-ok.tsx":
        'export const B = () => <Button>Escolher outra{" "}forma de pagamento</Button>;',
      "sales/split.tsx":
        "export const A = () => (\n  <Button>\n    Cancelar esta{\" \"}\n    venda e começar{' '}outra\n  </Button>\n);",
    });
    expect(labelProblems(root, []).violations).toEqual([
      'sales/split.tsx:2: "Cancelar esta venda e começar outra" (6 words, the limit is 5)',
    ]);
  });

  it("plant: a split label moved to another line is matched by file and text", () => {
    const root = plant({
      "sales/split.tsx":
        'const x = 1;\nexport const A = () => <Button>Cancelar esta venda{" "}e começar outra</Button>;',
    });
    const entry = {
      file: "sales/split.tsx",
      label: "Cancelar esta venda e começar outra",
      reason: "a decidir (Petković/Bruno)",
    };
    expect(labelProblems(root, [entry])).toEqual({
      unused: [],
      violations: [],
    });
  });

  it.each([
    ["an expression child", "<Button>{label}</Button>"],
    ["text with an element inside", "<Button>Salvar <b>agora</b></Button>"],
    ["text before an expression", '<Button>Salvar{" "}{label}</Button>'],
    ["a short label with an ellipsis", "<Button>Salvando…</Button>"],
  ])("control: %s is not read as a literal label", (_name, source) => {
    expect(buttonLabelFindings(source, "x.tsx")).toEqual([]);
  });
});
