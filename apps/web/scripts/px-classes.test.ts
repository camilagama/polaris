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
 * Sizes in classes are `rem`, so the screen follows the text size of the system (DESIGN.md, "Responsividade e
 * toque"). The scan reads every `.ts` and `.tsx` of `src` as text and reports an arbitrary value with a `px`
 * length (`text-[11px]`, `min-[900px]`, `calc(12rem+11px)`); a `0px` is not a size and passes. The labs and the
 * gallery are read too. Only the strokes below stay in `px`, each with its reason, and the list is checked
 * exactly by file, class and number of uses: an entry nothing uses any more, or used once more, fails. Media queries written in JavaScript are not classes
 * (`motion-level.ts` keeps its 760 px and 500 px on purpose, DESIGN.md). A bare spacing, position or size token
 * (`left-0.875`) only generates CSS in Tailwind when its number is a multiple of 0.25, so the second scan reports
 * the ones off that scale: without the CSS the class disappears silently.
 */
const SRC = fileURLToPath(new URL("../src", import.meta.url));
const TEST_FILE = /\.(?:test|spec)\.tsx?$/;
const SOURCE_FILE = /\.tsx?$/;
const ARBITRARY_VALUE = /([\w@/.!-]*)\[([^[\]\s"'`]*)\]/g;
const PX_LENGTH = /(?<![A-Za-z\d])(\d*\.?\d+)px/g;
const SCALE_CLASS =
  /(?<![\w-])-?(?:p[xytrblse]?|m[xytrblse]?|gap(?:-[xy])?|space-[xy]|inset(?:-[xy])?|top|right|bottom|left|start|end|w|h|size|min-w|min-h|max-w|max-h)-(\d*\.?\d+)(?![\w./%[(-])/g;
const SCALE_STEP = 0.25;
const SCALE_FIX = "use um múltiplo de 0,25 ou um valor entre colchetes em rem";

interface PxException {
  count: number;
  path: string;
  reason: string;
  segment: string;
}

const RING = "contorno de foco de 3 px, igual em toda a interface (DESIGN.md)";
const GLOW = "brilho de 1 px no topo do cartão no tema escuro (traço)";
const TOOLTIP_EDGE = "filete de 1 px do painel do tooltip (traço)";

const PX_EXCEPTIONS: readonly PxException[] = [
  {
    count: 1,
    path: "app-shell/app-shell.tsx",
    reason:
      "ícone de 18 px da aba da barra inferior: a reserva --app-bottom-bar de styles/index.css soma 18px à altura de duas linhas de rótulo",
    segment: "size-[18px]",
  },
  {
    count: 1,
    path: "catalog/product-media-crop.tsx",
    reason: "contorno de 1 px do retângulo de recorte sobre a foto (traço)",
    segment: "shadow-[0_0_0_1px_var(--background)]",
  },
  {
    count: 1,
    path: "sales/sale-summary-panel.tsx",
    reason: RING,
    segment: "ring-[3px]",
  },
  {
    count: 2,
    path: "ui/bklit/charts/tooltip/tooltip-box.tsx",
    reason: "raio interno é o raio do painel menos a borda de 1 px",
    segment: "rounded-[calc(var(--radius-xl)-1px)]",
  },
  {
    count: 1,
    path: "ui/bklit/charts/tooltip/tooltip-box.tsx",
    reason: TOOLTIP_EDGE,
    segment: "shadow-[0_-1px_rgb(255_255_255/0.06)]",
  },
  {
    count: 1,
    path: "ui/bklit/charts/tooltip/tooltip-box.tsx",
    reason: TOOLTIP_EDGE,
    segment: "shadow-[0_1px_rgb(0_0_0/0.04)]",
  },
  {
    count: 1,
    path: "ui/button.tsx",
    reason: "brilho e sombra de 1 px e 2 px do botão primário (traço)",
    segment:
      "shadow-[inset_0_1px_0_var(--btn-shine),0_1px_2px_var(--btn-drop)]",
  },
  {
    count: 1,
    path: "ui/card.tsx",
    reason: GLOW,
    segment: "shadow-[inset_0_1px_0_var(--card-glow)]",
  },
  { count: 1, path: "ui/checkbox.tsx", reason: RING, segment: "ring-[3px]" },
  { count: 2, path: "ui/input-group.tsx", reason: RING, segment: "ring-[3px]" },
  {
    count: 2,
    path: "ui/kpi-card.tsx",
    reason: GLOW,
    segment: "shadow-[inset_0_1px_0_var(--card-glow)]",
  },
  { count: 2, path: "ui/radio-group.tsx", reason: RING, segment: "ring-[3px]" },
  { count: 1, path: "ui/select.tsx", reason: RING, segment: "ring-[3px]" },
  {
    count: 1,
    path: "ui/sidebar.tsx",
    reason: "linha de 2 px da trilha de redimensionar a lateral (traço)",
    segment: "w-[2px]",
  },
  { count: 1, path: "ui/textarea.tsx", reason: RING, segment: "ring-[3px]" },
];

function isSourceFile(name: string): boolean {
  return SOURCE_FILE.test(name) && !TEST_FILE.test(name);
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return isSourceFile(entry.name) ? [path] : [];
  });
}

function pxSegments(source: string): string[] {
  return [...source.matchAll(ARBITRARY_VALUE)].flatMap((match) => {
    const [, prefix = "", inner = ""] = match;
    const lengths = [...inner.matchAll(PX_LENGTH)].map((px) => Number(px[1]));
    return lengths.some((value) => value !== 0) ? [`${prefix}[${inner}]`] : [];
  });
}

function offScaleSegments(source: string): string[] {
  return [...source.matchAll(SCALE_CLASS)].flatMap((match) => {
    const steps = Number(match[1]) / SCALE_STEP;
    return Math.abs(steps - Math.round(steps)) > 1e-9 ? [match[0]] : [];
  });
}

function scan(root: string): { path: string; segments: string[] }[] {
  return sourceFiles(root)
    .map((path) => ({
      path: relative(root, path).split(sep).join("/"),
      segments: pxSegments(readFileSync(path, "utf8")),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function scaleFindings(root: string): string[] {
  return sourceFiles(root)
    .map((path) => ({
      path: relative(root, path).split(sep).join("/"),
      segments: offScaleSegments(readFileSync(path, "utf8")),
    }))
    .sort((a, b) => a.path.localeCompare(b.path))
    .flatMap(({ path, segments }) =>
      segments.map((segment) => `${path}: ${segment}`)
    );
}

function key(path: string, segment: string): string {
  return `${path}: ${segment}`;
}

function isAllowed(path: string, segment: string): boolean {
  return PX_EXCEPTIONS.some(
    (exception) => exception.path === path && exception.segment === segment
  );
}

function findings(root: string): string[] {
  return scan(root).flatMap(({ path, segments }) =>
    segments
      .filter((segment) => !isAllowed(path, segment))
      .map((segment) => key(path, segment))
  );
}

function usedExceptions(root: string): string[] {
  const counts = new Map<string, number>();
  for (const { path, segments } of scan(root)) {
    for (const segment of segments.filter((item) => isAllowed(path, item))) {
      counts.set(key(path, segment), (counts.get(key(path, segment)) ?? 0) + 1);
    }
  }
  return [...counts].map(([name, count]) => `${count}x ${name}`).sort();
}

const planted = mkdtempSync(join(tmpdir(), "px-classes-"));
afterAll(() => rmSync(planted, { force: true, recursive: true }));

function plant(files: Record<string, string>): string {
  const root = mkdtempSync(join(planted, "src-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

describe("classes use rem, not px", () => {
  it("reads every source file of the app, labs and gallery included", () => {
    const scanned = scan(SRC).map(({ path }) => path);
    expect(scanned.length).toBeGreaterThan(300);
    expect(scanned).toContain("ui/kpi-card.tsx");
    expect(scanned).toContain("ui/dialog-layout.ts");
    expect(scanned).toContain("dashboard/result-chart.tsx");
    expect(scanned.some((path) => path.startsWith("ui-gallery/"))).toBe(true);
    expect(scanned.some((path) => path.startsWith("offline-poc/"))).toBe(true);
    expect(scanned.some((path) => TEST_FILE.test(path))).toBe(false);
  });

  it("finds no px outside the exceptions", () => {
    expect(findings(SRC)).toEqual([]);
  });

  it("finds no spacing or size class off the 0.25 scale", () => {
    expect(
      scaleFindings(SRC),
      `classe fora da escala de 0,25: ${SCALE_FIX}`
    ).toEqual([]);
  });

  it("keeps the list of exceptions exact: file, class and count", () => {
    expect(usedExceptions(SRC)).toEqual(
      PX_EXCEPTIONS.map(
        ({ count, path, segment }) => `${count}x ${key(path, segment)}`
      ).sort()
    );
    expect(
      new Set(PX_EXCEPTIONS.map(({ path, segment }) => key(path, segment))).size
    ).toBe(PX_EXCEPTIONS.length);
    for (const exception of PX_EXCEPTIONS) {
      expect(exception.reason.length).toBeGreaterThan(10);
    }
  });

  it("plant: a px size fails in a class, a variant, a calc and a .ts constant", () => {
    const root = plant({
      "home/deep/card.tsx": [
        'export const A = "text-[11px] pr-[7px] touch:size-[18px]";',
        'export const B = "min-[900px]:grid-cols-4 md:max-[899.98px]:col-span-2";',
        'export const C = "pr-[calc(12rem+11px)] [&_svg]:size-[18px]";',
      ].join("\n"),
      "ui/layout.ts":
        'export const D = "max-w-[420px] min-[390px]:min-h-[2rem]";',
    });
    expect(findings(root)).toEqual([
      "home/deep/card.tsx: text-[11px]",
      "home/deep/card.tsx: pr-[7px]",
      "home/deep/card.tsx: size-[18px]",
      "home/deep/card.tsx: min-[900px]",
      "home/deep/card.tsx: max-[899.98px]",
      "home/deep/card.tsx: pr-[calc(12rem+11px)]",
      "home/deep/card.tsx: size-[18px]",
      "ui/layout.ts: max-w-[420px]",
      "ui/layout.ts: min-[390px]",
    ]);
  });

  it("plant: a listed class in another file, or used once more, is no longer exact", () => {
    const root = plant({
      "ui/select.tsx":
        'export const A = "ring-[3px] focus-visible:ring-[3px]";',
      "ui/other.tsx": 'export const B = "ring-[3px]";',
    });
    expect(findings(root)).toEqual(["ui/other.tsx: ring-[3px]"]);
    expect(usedExceptions(root)).toEqual(["2x ui/select.tsx: ring-[3px]"]);
  });

  it("plant: the forms of an arbitrary px value the pattern must see", () => {
    const root = plant({
      "ui/forms.tsx": [
        'export const A = "!w-[10px] [--gap:12px] @[400px]:flex w-[.5px] h-[0.5px]";',
        'export const B = "[@media(min-width:900px)]:grid [&:has([data-x])]:w-[10px]";',
        'export const C = "-mt-[2.5px] w-[0px] w-[0.0px]";',
      ].join("\n"),
    });
    expect(findings(root)).toEqual([
      "ui/forms.tsx: !w-[10px]",
      "ui/forms.tsx: [--gap:12px]",
      "ui/forms.tsx: @[400px]",
      "ui/forms.tsx: w-[.5px]",
      "ui/forms.tsx: h-[0.5px]",
      "ui/forms.tsx: [@media(min-width:900px)]",
      "ui/forms.tsx: w-[10px]",
      "ui/forms.tsx: -mt-[2.5px]",
    ]);
  });

  it("plant: rem, 0px and the listed strokes pass; the same utility with another px fails", () => {
    const clean = plant({
      "ui/ok.tsx": [
        'export const A = "text-[0.6875rem] min-[56.25rem]:grid-cols-4 pr-1.75";',
        'export const B = "top-[var(--dialog-top,0px)] [--card-spacing:0px]";',
      ].join("\n"),
      "ui/sidebar.tsx": 'export const C = "after:w-[2px]";',
      "ui/textarea.tsx": 'export const D = "focus-visible:ring-[3px]";',
    });
    expect(findings(clean)).toEqual([]);
    expect(usedExceptions(clean)).toEqual([
      "1x ui/sidebar.tsx: w-[2px]",
      "1x ui/textarea.tsx: ring-[3px]",
    ]);
    const dirty = plant({
      "ui/bad.tsx":
        'export const A = "ring-[4px] w-[3px] shadow-[0_2px_rgb(0_0_0/0.04)]";',
    });
    expect(findings(dirty)).toEqual([
      "ui/bad.tsx: ring-[4px]",
      "ui/bad.tsx: w-[3px]",
      "ui/bad.tsx: shadow-[0_2px_rgb(0_0_0/0.04)]",
    ]);
  });

  it("plant: test files and non-source files are not read", () => {
    const root = plant({
      "ui/kpi-card.test.tsx": 'expect(m).toContain("text-[11px]");',
      "ui/notes.md": "text-[11px]",
    });
    expect(scan(root)).toEqual([]);
  });

  it("plant: a spacing or size class off the 0.25 scale fails, on-scale and other forms pass", () => {
    const bad = plant({
      "home/card.tsx": [
        'export const A = "left-0.875 -mt-1.1 md:gap-x-0.3 [&_svg]:size-2.6";',
        'export const B = "!pr-1.125 min-h-0.1 max-w-3.9 space-y-0.7 inset-x-0.2";',
      ].join("\n"),
      "ui/layout.ts": 'export const C = "top-1.3 bottom-0.15 w-4.6 h-1.05";',
    });
    expect(scaleFindings(bad)).toEqual([
      "home/card.tsx: left-0.875",
      "home/card.tsx: -mt-1.1",
      "home/card.tsx: gap-x-0.3",
      "home/card.tsx: size-2.6",
      "home/card.tsx: pr-1.125",
      "home/card.tsx: min-h-0.1",
      "home/card.tsx: max-w-3.9",
      "home/card.tsx: space-y-0.7",
      "home/card.tsx: inset-x-0.2",
      "ui/layout.ts: top-1.3",
      "ui/layout.ts: bottom-0.15",
      "ui/layout.ts: w-4.6",
      "ui/layout.ts: h-1.05",
    ]);
    const clean = plant({
      "ui/ok.tsx": [
        'export const A = "left-0.25 -mt-1.5 gap-x-0.75 size-2.5 pr-1.75 w-1/2 h-1.5/3";',
        'export const B = "ring-offset-1.1 inset-ring-1.1 scroll-mt-0.3x w-[0.875rem] top-[0.3rem] max-w-xs";',
        'export const C = "w-0 h-12 min-w-px p-0.5 inset-0 space-x-reverse";',
      ].join("\n"),
    });
    expect(scaleFindings(clean)).toEqual([]);
  });
});
