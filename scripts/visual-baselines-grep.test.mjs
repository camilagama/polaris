import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SPEC = "apps/web/e2e-pwa/ui-visual.e2e.ts";
const WORKFLOW = ".github/workflows/visual-baselines.yml";

const LIST_TEST_ANCHOR = 'snapshotPath("x.png")';
const TEST_TITLE = /^test\(\s*(["'`])((?:(?!\1).)*)\1\s*,/gm;
const YAML_COMMENT_LINE = /^\s*#.*$/gm;
const REGEX_METACHARACTER = /[\\^$.*+?()[\]{}|]/;
const GREP_FLAG = /--grep(-invert)?[= ]\s*(?:"([^"]*)"|'([^']*)')/g;

function listTestTitle(source) {
  const anchors = source.split(LIST_TEST_ANCHOR).length - 1;
  if (anchors !== 1) {
    throw new Error(
      `${SPEC} should have exactly one test that reads the folder with ${LIST_TEST_ANCHOR}, found ${anchors}; if the list test moved, update LIST_TEST_ANCHOR in scripts/visual-baselines-grep.test.mjs`
    );
  }
  const before = source.slice(0, source.indexOf(LIST_TEST_ANCHOR));
  const titles = [...before.matchAll(TEST_TITLE)];
  if (titles.length === 0) {
    throw new Error(
      `no top-level test( title found before the list test in ${SPEC}`
    );
  }
  return titles.at(-1)[2];
}

function workflowGreps(yaml) {
  return [...yaml.replace(YAML_COMMENT_LINE, "").matchAll(GREP_FLAG)].map(
    (match) => ({
      flag: match[1] ? "--grep-invert" : "--grep",
      text: match[2] ?? match[3],
    })
  );
}

// Playwright reads --grep and --grep-invert as a regular expression, so a metacharacter in the title would stop matching it literally
function mismatches(title, greps) {
  const problems = [];
  if (REGEX_METACHARACTER.test(title)) {
    problems.push(
      `${SPEC}: the title "${title}" of the list test has a regular expression character, and ${WORKFLOW} passes it to --grep and --grep-invert as a regular expression; keep the title to letters, digits, spaces and : , ; - or escape it in both flags`
    );
  }
  for (const flag of ["--grep-invert", "--grep"]) {
    const found = greps.filter((grep) => grep.flag === flag);
    if (found.length === 0) {
      problems.push(
        `${WORKFLOW} has no ${flag} "${title}": the generation step and the list-test step must both name the test of ${SPEC}`
      );
    }
    for (const { text } of found) {
      if (text !== title) {
        problems.push(
          `${WORKFLOW}: ${flag} "${text}" is not the title "${title}" of the list test in ${SPEC}; change the one that is wrong so both are identical (otherwise ${flag === "--grep" ? "the list step finds no test" : "the generation step stops excluding the list test and hangs"})`
        );
      }
    }
  }
  return problems;
}

describe("the title of the list test and the greps of visual-baselines.yml", () => {
  const spec = readFileSync(path.join(root, SPEC), "utf8");
  const workflow = readFileSync(path.join(root, WORKFLOW), "utf8");

  it("are the same text in the spec and in both flags of the workflow", () => {
    expect(mismatches(listTestTitle(spec), workflowGreps(workflow))).toEqual(
      []
    );
  });
});

describe("what the guard rejects", () => {
  const title = "a pasta tem as imagens";
  const specSource = `test.use({});\ntest("${title}", () => {\n  const f = dirname(info.snapshotPath("x.png"));\n});\ntest("outro", () => {});\n`;
  const yaml = (invert, grep) =>
    `run: bun run test:visual:update --grep-invert "${invert}"\nrun: bun run test:visual --grep "${grep}"\n`;

  it("takes the title of the test that holds the anchor, not the last one", () => {
    expect(listTestTitle(specSource)).toBe(title);
  });

  it("accepts the same text in both flags", () => {
    expect(mismatches(title, workflowGreps(yaml(title, title)))).toEqual([]);
  });

  it("rejects a title that changed in the spec", () => {
    const problems = mismatches(
      "a pasta tem as imagens!",
      workflowGreps(yaml(title, title))
    );
    expect(problems).toHaveLength(2);
    expect(problems.join("\n")).toContain(SPEC);
  });

  it("rejects a --grep-invert that changed in the workflow", () => {
    const problems = mismatches(
      title,
      workflowGreps(yaml("a pasta tem as imagen", title))
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("--grep-invert");
    expect(problems[0]).toContain(WORKFLOW);
  });

  it("rejects a --grep that changed in the workflow", () => {
    const problems = mismatches(
      title,
      workflowGreps(yaml(title, "a pasta tem as imagen"))
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('--grep "');
  });

  it("rejects a title with a regular expression character", () => {
    const risky = "a pasta (baselines)";
    const problems = mismatches(risky, workflowGreps(yaml(risky, risky)));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("regular expression");
  });

  it("ignores a commented flag, so it neither satisfies nor breaks the guard", () => {
    const commented = `# --grep-invert "${title}"\nrun: bun run test:visual --grep "${title}"\n# --grep "titulo antigo"\n`;
    const problems = mismatches(title, workflowGreps(commented));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("has no --grep-invert");
  });

  it("accepts a flag written with a single quote or an equals sign", () => {
    const greps = workflowGreps(
      `run: x --grep-invert='${title}'\nrun: y --grep '${title}'\n`
    );
    expect(mismatches(title, greps)).toEqual([]);
  });

  it("rejects a workflow that lost one of the flags", () => {
    const onlyGrep = `run: bun run test:visual --grep "${title}"\n`;
    const problems = mismatches(title, workflowGreps(onlyGrep));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("has no --grep-invert");
  });

  it("rejects a second list test or none", () => {
    expect(() => listTestTitle("test('a', () => {});")).toThrow("exactly one");
    expect(() => listTestTitle(`${specSource}\n${specSource}`)).toThrow(
      "exactly one"
    );
  });
});
