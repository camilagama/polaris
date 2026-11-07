import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { KNOWN_COARSE_FINDINGS } from "../e2e/reflow-known";

/**
 * Every spec that sweeps a screen at 320 px with the browser font at 20 px (or reads it at 360 px with 16) declares its
 * cases with `reflowTest` (`e2e/reflow.ts`), which runs each one with a mouse and with a finger. A spec that opens the
 * sweep with a plain `test` measures only the mouse, and the cut that shows only with a finger goes to the phone.
 *
 * Which specs are reflow specs is read from the folder: a name with "reflow", or an import from `./reflow`. Each one has
 * a line in `SPECS` with the exact number of plain `test(` calls and of `coarse:` options it keeps, and why; a new spec,
 * a new plain `test(` or a new `coarse: false` fails here until the line says so. `reflow-rotas.e2e.ts` runs only with
 * a finger by design and is checked for that. No exclusion that is not in `SPECS` or `OTHER`.
 */
const E2E = fileURLToPath(new URL("../e2e/", import.meta.url));

interface SpecRule {
  /** Plain `test(` calls in the part of the file that sweeps (a case that is not a reflow measure). */
  bare: number;
  /** `reflowTest(` calls that leave the finger case out with `coarse:`. */
  coarse: number;
  /** The first line of the part of the file that sweeps, when the spec is a big file that sweeps in one place. */
  from?: string;
  /** Why each plain `test(` and each `coarse:` stays. */
  why: string;
}

const SPECS: Readonly<Record<string, SpecRule>> = {
  "clientes-reflow.e2e.ts": {
    bare: 0,
    coarse: 1,
    why: "the window of 1280 px is not a phone",
  },
  "dashboard.e2e.ts": {
    bare: 0,
    coarse: 0,
    from: 'test.describe("o passo a passo do Resultado a 320 px com a letra do navegador em 20 px"',
    why: "",
  },
  "despesas-reflow.e2e.ts": { bare: 0, coarse: 0, why: "" },
  "estoque-reflow.e2e.ts": {
    bare: 0,
    coarse: 1,
    why: "the window of 1280 px is not a phone",
  },
  "expenses.e2e.ts": {
    bare: 0,
    coarse: 0,
    from: 'test.describe("a 320 px com letra de 20 px"',
    why: "",
  },
  "historico-reflow.e2e.ts": {
    bare: 0,
    coarse: 1,
    why: "the window of 1280 px is not a phone",
  },
  "home.e2e.ts": {
    bare: 1,
    coarse: 1,
    from: 'test.describe("Mais vendidos do mês a 320 px com a letra do navegador em 20 px"',
    why: "the heights test opens its own browser contexts, which a finger case would not share; the window of 1280 px is not a phone",
  },
  "money-nowrap-reflow.e2e.ts": { bare: 0, coarse: 0, why: "" },
  "pendencias-reflow.e2e.ts": {
    bare: 0,
    coarse: 1,
    why: "the window of 1280 px is not a phone",
  },
  "sale-item-reflow.e2e.ts": {
    bare: 1,
    coarse: 0,
    why: "the order of the DOM does not depend on the size of anything, so there is nothing for a finger to change",
  },
  "shell-reflow.e2e.ts": {
    bare: 0,
    coarse: 2,
    why: "the window of 1280 px is not a phone; the font of 24 px is a best effort, not a promise",
  },
};

/** Files that name "reflow" or import it and are not specs of a screen. */
const OTHER: Readonly<Record<string, string>> = {
  "reflow-helper.e2e.ts":
    "tests the sweep itself with planted defects; it plants one that cuts only with a finger",
  "reflow-rotas.e2e.ts":
    "runs only with a finger (the one run of the routes without a spec of their own)",
};

const REFLOW_IMPORT = /from "\.\/reflow"/;

function reflowFiles() {
  return readdirSync(E2E)
    .filter((name) => name.endsWith(".e2e.ts"))
    .filter(
      (name) =>
        name.includes("reflow") ||
        REFLOW_IMPORT.test(readFileSync(join(E2E, name), "utf8"))
    )
    .sort();
}

const count = (source: string, pattern: RegExp) =>
  [...source.matchAll(pattern)].length;

const BARE_TEST = /^\s*test(?:\.only)?\(/gm;
const REFLOW_TEST = /^\s*reflowTest\(/gm;
const COARSE_OPTION = /\bcoarse:/g;

/** What is wrong with one spec, in words that name the fix. */
function problemsOf(name: string, whole: string, rule: SpecRule) {
  const start = rule.from === undefined ? 0 : whole.indexOf(rule.from);
  if (start < 0) {
    return [
      `${name}: the line that opens the sweep ("${rule.from}") is not in the file; update SPECS`,
    ];
  }
  const source = whole.slice(start);
  const found: string[] = [];
  if (count(source, REFLOW_TEST) === 0) {
    found.push(
      `${name}: no \`reflowTest(\`: its cases measure only the mouse; declare them with reflowTest`
    );
  }
  const bare = count(source, BARE_TEST);
  if (bare !== rule.bare) {
    found.push(
      `${name}: ${bare} plain \`test(\` where SPECS allows ${rule.bare}; declare the case with reflowTest, or say in SPECS why it stays`
    );
  }
  const coarse = count(source, COARSE_OPTION);
  if (coarse !== rule.coarse) {
    found.push(
      `${name}: ${coarse} \`coarse:\` where SPECS allows ${rule.coarse}; a case without the finger needs its reason in SPECS`
    );
  }
  return found;
}

const RULE: SpecRule = { bare: 0, coarse: 0, why: "" };

describe("the reflow specs run with a finger too", () => {
  it("every reflow spec is in SPECS or in OTHER, and none of them is gone", () => {
    expect(reflowFiles()).toEqual(
      [...Object.keys(SPECS), ...Object.keys(OTHER)].sort()
    );
  });

  it("each spec declares its cases with reflowTest and keeps only the plain tests and coarse options SPECS names", () => {
    const problems = Object.entries(SPECS).flatMap(([name, rule]) =>
      problemsOf(name, readFileSync(join(E2E, name), "utf8"), rule)
    );
    expect(problems).toEqual([]);
  });

  it("each exception in SPECS has its reason", () => {
    const missing = Object.entries(SPECS)
      .filter(([, rule]) => rule.bare + rule.coarse > 0)
      .filter(([, rule]) => rule.why.trim().length < 20)
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });

  it("the routes spec and the helper spec keep what makes them what they are", () => {
    const rotas = readFileSync(join(E2E, "reflow-rotas.e2e.ts"), "utf8");
    expect(rotas).toContain("test.use({ hasTouch: true, isMobile: true });");
    const helper = readFileSync(join(E2E, "reflow-helper.e2e.ts"), "utf8");
    expect(count(helper, REFLOW_TEST)).toBe(3);
    expect(helper).toContain("@media (pointer: coarse)");
  });

  it("the list of known findings has every field and no repeated line", () => {
    const lines = KNOWN_COARSE_FINDINGS;
    const keys = lines.map(
      (line) =>
        `${line.spec}|${line.selector}|${line.clientWidth}|${line.scrollWidth}`
    );
    expect(new Set(keys).size).toBe(keys.length);
    for (const line of lines) {
      expect(Object.keys(SPECS)).toContain(line.spec);
      expect(line.cases.length).toBeGreaterThan(0);
      expect(line.screen.trim().length).toBeGreaterThan(0);
      expect(line.selector.trim().length).toBeGreaterThan(0);
      expect(line.reason.trim().length).toBeGreaterThanOrEqual(30);
      expect(line.scrollWidth).toBeGreaterThan(line.clientWidth);
      expect(Number.isInteger(line.clientWidth)).toBe(true);
      expect(Number.isInteger(line.scrollWidth)).toBe(true);
    }
  });
});

describe("the check fails on what it says it fails on", () => {
  const WITH = 'reflowTest("a 320 px", async ({ page }) => {});\n';

  it("passes a spec that declares its case with reflowTest", () => {
    expect(problemsOf("a.e2e.ts", WITH, RULE)).toEqual([]);
  });

  it("fails a spec with no reflowTest", () => {
    const found = problemsOf(
      "a.e2e.ts",
      'test("a 320 px", async ({ page }) => {});\n',
      { ...RULE, bare: 1 }
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("no `reflowTest(`");
  });

  it("fails a plain test added next to a reflowTest, indented or with .only", () => {
    for (const added of [
      'test("novo", async () => {});\n',
      '  test("novo", async () => {});\n',
      'test.only("novo", async () => {});\n',
    ]) {
      const found = problemsOf("a.e2e.ts", WITH + added, RULE);
      expect(found).toHaveLength(1);
      expect(found[0]).toContain("1 plain `test(` where SPECS allows 0");
    }
  });

  it("does not count test.describe, test.use or test.skip as a case", () => {
    const source = `${WITH}test.describe("g", () => {});\ntest.use({});\ntest.skip(() => true, "x");\n`;
    expect(problemsOf("a.e2e.ts", source, RULE)).toEqual([]);
  });

  it("fails a case that leaves the finger out without a line that says so", () => {
    const source = `${WITH}reflowTest("b", async () => {}, { coarse: false });\n`;
    const found = problemsOf("a.e2e.ts", source, RULE);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("1 `coarse:` where SPECS allows 0");
    expect(problemsOf("a.e2e.ts", source, { ...RULE, coarse: 1 })).toEqual([]);
  });

  it("reads only the part of a big file that sweeps, and fails when its opening line is gone", () => {
    const big = `test("outro", async () => {});\nSWEEP\n${WITH}`;
    expect(problemsOf("a.e2e.ts", big, { ...RULE, from: "SWEEP" })).toEqual([]);
    const found = problemsOf("a.e2e.ts", big, { ...RULE, from: "NAO EXISTE" });
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("is not in the file");
  });
});
