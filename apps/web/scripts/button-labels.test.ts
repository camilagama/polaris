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
 * formulário"). The scan reads every `.tsx` of `src` as text, so a label added to any screen is caught; only
 * the gallery and the labs, which are not product screens, stay out, and the exclusions are listed exactly.
 */
const SRC = fileURLToPath(new URL("../src", import.meta.url));
const EXCLUDED_FOLDERS = ["offline-poc/", "ui-gallery/"];
const TEST_FILE = /\.(?:test|spec)\.tsx?$/;
const JSX_TEXT = />\s*(OK|Ok|Sim)[.!]?\s*<\//g;
const STRING_LITERAL = /["'`](OK|Ok|Sim)[.!]?["'`]/g;

function genericButtonLabels(source: string): string[] {
  return [
    ...[...source.matchAll(JSX_TEXT)].map((match) => match[1] ?? ""),
    ...[...source.matchAll(STRING_LITERAL)].map((match) => match[1] ?? ""),
  ];
}

function tsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return tsxFiles(path);
    }
    return entry.name.endsWith(".tsx") && !TEST_FILE.test(entry.name)
      ? [path]
      : [];
  });
}

function scan(root: string): string[] {
  return tsxFiles(root)
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
