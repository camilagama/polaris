import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const WORKFLOW_PATH = ".github/workflows/visual-baselines.yml";
const SPEC_PATH = "apps/web/e2e-pwa/ui-visual.e2e.ts";

const GREP_FLAG = /--grep(-invert)?[ =](?:"([^"]*)"|'([^']*)')/g;
const GREP_INVERT_ARGUMENT = / --grep-invert "[^"]*"/;
const GREP_ARGUMENT = / --grep "[^"]*"/;
const TEST_TITLE = /^test\(\s*(?:"([^"]*)"|'([^']*)'|`([^`$]*)`)\s*,/gm;

const greps = (workflow) =>
  [...workflow.matchAll(GREP_FLAG)].map((m) => ({
    flag: m[1] ? "--grep-invert" : "--grep",
    text: m[2] ?? m[3],
  }));

const titles = (spec) =>
  [...spec.matchAll(TEST_TITLE)].map((m) => m[1] ?? m[2] ?? m[3]);

const findGrepProblems = (workflow, spec) => {
  const found = greps(workflow);
  const problems = [];
  for (const flag of ["--grep-invert", "--grep"]) {
    if (!found.some((g) => g.flag === flag)) {
      problems.push(
        `${WORKFLOW_PATH}: falta ${flag} "<título do teste da lista>". Sem ele o workflow ${flag === "--grep-invert" ? "roda o teste da lista antes de as capturas novas existirem e reprova" : "deixa de conferir a pasta de baselines depois de gravar"}. Restaure o passo, entre aspas duplas, na forma ${flag} "<título exato de ${SPEC_PATH}>".`
      );
    }
  }
  const distinct = [...new Set(found.map((g) => g.text))];
  if (distinct.length > 1) {
    problems.push(
      `${WORKFLOW_PATH}: --grep e --grep-invert usam textos diferentes (${distinct.map((t) => `"${t}"`).join(", ")}). Os dois têm de ser o título exato do teste da lista em ${SPEC_PATH}.`
    );
  }
  const existing = titles(spec);
  for (const text of distinct) {
    if (!existing.includes(text)) {
      problems.push(
        `${WORKFLOW_PATH}: o texto "${text}" do --grep/--grep-invert não é título de nenhum test(...) em ${SPEC_PATH}. Se o teste da lista foi renomeado, troque o texto nos passos do workflow para o título novo (só o mantenedor grava workflow: entregue como patch); se foi o workflow que mudou, volte ao título do e2e. Sem isso o --grep-invert não exclui o teste e o --grep não roda nada.`
      );
    }
  }
  return problems;
};

const realWorkflow = readFileSync(
  process.env.VISUAL_BASELINES_WORKFLOW_FILE ?? WORKFLOW_PATH,
  "utf8"
);
const realSpec = readFileSync(SPEC_PATH, "utf8");

const TITLE = "a pasta de baselines tem exatamente as imagens da lista";
const FIXTURE_WORKFLOW = `run: bun run test:visual:update --grep-invert "${TITLE}"
run: bun run test:visual --grep "${TITLE}"
`;
const FIXTURE_SPEC = `test("${TITLE}", () => {
  expect(1).toBe(1);
});
`;

describe("visual-baselines: --grep do workflow e título do teste da lista", () => {
  it("o workflow e o e2e usam o mesmo título", () => {
    expect(findGrepProblems(realWorkflow, realSpec)).toEqual([]);
  });

  it("o workflow tem os dois passos, com --grep-invert antes do --grep", () => {
    const flags = greps(realWorkflow).map((g) => g.flag);
    expect(flags).toEqual(["--grep-invert", "--grep"]);
  });

  it("o ajuste de fixture sem mutação passa", () => {
    expect(findGrepProblems(FIXTURE_WORKFLOW, FIXTURE_SPEC)).toEqual([]);
  });

  it("título renomeado no e2e reprova com a correção", () => {
    const problems = findGrepProblems(
      FIXTURE_WORKFLOW,
      FIXTURE_SPEC.replace(TITLE, "a pasta de baselines tem as imagens")
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("troque o texto nos passos do workflow");
  });

  it("texto do --grep diferente do título reprova", () => {
    const problems = findGrepProblems(
      FIXTURE_WORKFLOW.replace(`--grep "${TITLE}"`, '--grep "outro título"'),
      FIXTURE_SPEC
    );
    expect(problems.some((p) => p.includes("textos diferentes"))).toBe(true);
    expect(problems.some((p) => p.includes("não é título"))).toBe(true);
  });

  it("workflow sem --grep-invert reprova", () => {
    expect(
      findGrepProblems(
        FIXTURE_WORKFLOW.replace(GREP_INVERT_ARGUMENT, ""),
        FIXTURE_SPEC
      )
    ).toEqual([expect.stringContaining("falta --grep-invert")]);
  });

  it("workflow sem --grep reprova", () => {
    expect(
      findGrepProblems(
        FIXTURE_WORKFLOW.replace(GREP_ARGUMENT, ""),
        FIXTURE_SPEC
      )
    ).toEqual([expect.stringContaining("falta --grep ")]);
  });
});
