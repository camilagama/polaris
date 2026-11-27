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
 * The button says the choice ("Excluir venda" / "Manter"), never "OK" or "Sim" alone (DESIGN.md, "Diálogo de
 * formulário"). The scan reads every `.tsx` of `src` as text, so a label added to any screen is caught, and
 * also the `*-texts.ts` constants that hold button text; a plain `.ts` is not read, because it would flag
 * strings that are not labels. Only the gallery and the labs, which are not product screens, stay out, and
 * the exclusions are listed exactly. A second rule bounds a literal `<Button>` label at 5 words and no final
 * period; it reads only text written straight before `</Button>`, so a label that comes from a constant or
 * a prop, or that is followed by an icon, is not counted.
 */
const SRC = fileURLToPath(new URL("../src", import.meta.url));
const EXCLUDED_FOLDERS = ["offline-poc/", "ui-gallery/"];
const TEST_FILE = /\.(?:test|spec)\.tsx?$/;
const TEXTS_CONSTANTS = /-texts\.ts$/;
const JSX_TEXT = />\s*(OK|Ok|Sim)[.!]?\s*<\//g;
const STRING_LITERAL = /["'`](OK|Ok|Sim)[.!]?["'`]/g;
const BUTTON_LITERAL_TEXT = />([^<>{}]+)<\/Button>/g;
const MAX_BUTTON_WORDS = 5;
const WHITESPACE = /\s+/;

interface AllowedLabel {
  file: string;
  line: number;
  label: string;
  reason: string;
}

/**
 * Labels over the word limit that keep their text until the design decides. The key is file, line and
 * text: an entry that no longer matches a label (text or line moved) fails, so the list cannot outlive the
 * button; when only the line moved, set the entry's `line` to the one the violation reports.
 */
const ALLOWED: readonly AllowedLabel[] = [
  {
    file: "sales/sale-summary-panel.tsx",
    label: "Atualizar dados e revisar a venda",
    line: 401,
    reason: "a decidir (Petković/Bruno)",
  },
  {
    file: "sales/sale-summary-panel.tsx",
    label: "Descartar esta venda e começar outra",
    line: 476,
    reason: "a decidir (Petković/Bruno)",
  },
];

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
    const label = (match[1] ?? "").split(WHITESPACE).filter(Boolean).join(" ");
    const problem = buttonLabelProblem(label);
    if (problem === null) {
      return [];
    }
    const line = source.slice(0, match.index).split("\n").length;
    return [{ file, label, line, problem }];
  });
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    const isSource =
      entry.name.endsWith(".tsx") || TEXTS_CONSTANTS.test(entry.name);
    return isSource && !TEST_FILE.test(entry.name) ? [path] : [];
  });
}

function scan(root: string): string[] {
  return sourceFiles(root)
    .map((path) => relative(root, path).split(sep).join("/"))
    .filter(
      (path) => !EXCLUDED_FOLDERS.some((folder) => path.startsWith(folder))
    )
    .sort();
}

function findings(root: string): string[] {
  return scan(root).flatMap((path) =>
    genericButtonLabels(readFileSync(join(root, path), "utf8")).map(
      (label) => `${path}: ${label}`
    )
  );
}

function describeFinding(found: LabelFinding): string {
  return `${found.file}:${found.line}: "${found.label}" (${found.problem})`;
}

function labelProblems(root: string, allowed: readonly AllowedLabel[]) {
  const found = scan(root).flatMap((path) =>
    buttonLabelFindings(readFileSync(join(root, path), "utf8"), path)
  );
  const same = (entry: AllowedLabel, item: LabelFinding) =>
    entry.file === item.file &&
    entry.line === item.line &&
    entry.label === item.label;
  const unused = allowed.filter(
    (entry) => !found.some((item) => same(entry, item))
  );
  const violations = found.filter(
    (item) => !allowed.some((entry) => same(entry, item))
  );
  return {
    unused: unused.map((entry) => `${entry.file}:${entry.line}`),
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

describe("button labels say the choice, not OK or Sim", () => {
  it("scans the screens and leaves out only the gallery and the labs", () => {
    expect(EXCLUDED_FOLDERS).toEqual(["offline-poc/", "ui-gallery/"]);
    const scanned = scan(SRC);
    expect(scanned.length).toBeGreaterThan(250);
    expect(scanned).toContain("legal/acceptance/acceptance-page.tsx");
    expect(scanned).toContain("offline/attention-panel.tsx");
    expect(scanned).toContain("legal/acceptance/acceptance-texts.ts");
    expect(scanned).toContain("sign-in/password-texts.ts");
    expect(scanned).toContain("sign-in/sign-in-texts.ts");
    expect(
      readdirSync(SRC)
        .filter((name) => EXCLUDED_FOLDERS.includes(`${name}/`))
        .sort()
    ).toEqual(["offline-poc", "ui-gallery"]);
  });

  it("finds no OK or Sim label in any screen", () => {
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
  ])("plant: %s is caught", (_name, source, expected) => {
    expect(genericButtonLabels(source)).toEqual(expected);
  });

  it.each([
    ["a label that says the choice", "<Button>Excluir venda</Button>"],
    ["a word that only contains it", 'const x = "Simples"; const y = "Book";'],
    ["a sentence", 'const x = "Sim, excluir esta venda";'],
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
        "export const A = () => <Button>Descartar esta venda e começar outra</Button>;",
      "sales/period.tsx":
        "export const B = () => <Button>Manter meta.</Button>;",
      "sales/five.tsx":
        "export const C = () => <Button>Escolher outra forma de pagamento</Button>;",
    });
    expect(labelProblems(root, []).violations).toEqual([
      'sales/long.tsx:1: "Descartar esta venda e começar outra" (6 words, the limit is 5)',
      'sales/period.tsx:1: "Manter meta." (ends with a period)',
    ]);
  });

  it("plant: a label split across lines and after an arrow function prop is counted", () => {
    const root = plant({
      "sales/multi.tsx":
        "const A = () => (\n  <Button onClick={() => close()}>\n    Descartar esta venda\n    e começar outra\n  </Button>\n);",
    });
    expect(labelProblems(root, []).violations).toEqual([
      'sales/multi.tsx:2: "Descartar esta venda e começar outra" (6 words, the limit is 5)',
    ]);
  });

  it("plant: an allowed label passes, and an entry that no longer matches fails", () => {
    const root = plant({
      "sales/long.tsx":
        "export const A = () => <Button>Descartar esta venda e começar outra</Button>;",
    });
    const entry = {
      file: "sales/long.tsx",
      label: "Descartar esta venda e começar outra",
      line: 1,
      reason: "a decidir (Petković/Bruno)",
    };
    expect(labelProblems(root, [entry])).toEqual({
      unused: [],
      violations: [],
    });
    expect(labelProblems(root, [{ ...entry, line: 2 }])).toEqual({
      unused: ["sales/long.tsx:2"],
      violations: [
        'sales/long.tsx:1: "Descartar esta venda e começar outra" (6 words, the limit is 5)',
      ],
    });
    const fixed = plant({
      "sales/long.tsx":
        "export const A = () => <Button>Descartar venda</Button>;",
    });
    expect(labelProblems(fixed, [entry]).unused).toEqual(["sales/long.tsx:1"]);
  });

  it.each([
    ["an expression child", "<Button>{label}</Button>"],
    ["text with an element inside", "<Button>Salvar <b>agora</b></Button>"],
    ["a short label with an ellipsis", "<Button>Salvando…</Button>"],
  ])("control: %s is not read as a literal label", (_name, source) => {
    expect(buttonLabelFindings(source, "x.tsx")).toEqual([]);
  });
});
