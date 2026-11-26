import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const workflow = readFileSync(
  path.join(root, ".github/workflows/ci.yml"),
  "utf8"
);

const JOB_START = /^ {2}[^\s#]/;
const RUN_HEADER = /run: \|$/;
const LEADING_SPACES = /^ */;
const SELECTED_OUTPUT = /selected: \$\{\{ steps\.plan\.outputs\.selected \}\}/;
const COVERAGE_DOWNLOAD =
  /- if: \$\{\{ needs\.shard-plan\.outputs\.selected != '0' \}\}\n\s+uses: actions\/download-artifact@\S+ # \S+\n\s+with:\n\s+pattern: playwright-timings-shard-\*/;

/** A workflow expression, written without a template placeholder in a plain string. */
const expression = (inner) => ["$", "{{ ", inner, " }}"].join("");

const indentOf = (line) => LEADING_SPACES.exec(line)[0].length;

/** The text of a job of the workflow: from `  <name>:` to the next job (a line indented by two spaces). */
function jobBlock(name) {
  const lines = workflow.split("\n");
  const start = lines.indexOf(`  ${name}:`);
  if (start === -1) {
    throw new Error(`job ${name} not found in ci.yml`);
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => JOB_START.test(line));
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join("\n");
}

/** The `run: |` script of the step that holds `marker`. */
function runScript(block, marker) {
  const lines = block.split("\n");
  const at = lines.findIndex((line) => line.includes(marker));
  if (at === -1) {
    throw new Error(`no line with ${marker}`);
  }
  const header = lines.findLastIndex(
    (line, i) => i <= at && RUN_HEADER.test(line)
  );
  const indent = indentOf(lines[header + 1]);
  const body = [];
  for (const line of lines.slice(header + 1)) {
    if (line.trim() !== "" && indentOf(line) < indent) {
      break;
    }
    body.push(line.slice(indent));
  }
  return body.join("\n");
}

const AGGREGATE = runScript(
  jobBlock("offline-poc-browser"),
  'echo "plan=$PLAN'
);

const green = {
  CATALOG: "success",
  CHANGES: "success",
  CI_FULL: "false",
  COVERAGE: "success",
  EVENT: "pull_request",
  PARTS: "success",
  PLAN: "success",
  SELECTED: "5",
};

function aggregate(overrides) {
  const result = spawnSync("bash", ["-e", "-c", AGGREGATE], {
    encoding: "utf8",
    env: { BROWSER: "true", PATH: process.env.PATH, ...green, ...overrides },
  });
  return result.status;
}

describe("o agregado do gate de navegador", () => {
  it("passa com tudo verde, em PR e em execução completa", () => {
    expect(aggregate({})).toBe(0);
    expect(aggregate({ CI_FULL: "true" })).toBe(0);
  });

  it("aceita os shards pulados quando o PR não selecionou nenhum arquivo", () => {
    expect(aggregate({ PARTS: "skipped", SELECTED: "0" })).toBe(0);
  });

  it("reprova shards pulados em tudo que não é o caso da lista vazia em PR", () => {
    const skipped = { PARTS: "skipped" };
    expect(aggregate({ ...skipped, CI_FULL: "true", SELECTED: "0" })).toBe(1);
    expect(aggregate({ ...skipped, EVENT: "push", SELECTED: "0" })).toBe(1);
    expect(
      aggregate({ ...skipped, EVENT: "workflow_dispatch", SELECTED: "0" })
    ).toBe(1);
    expect(aggregate({ ...skipped, SELECTED: "" })).toBe(1);
    expect(aggregate({ ...skipped, SELECTED: "5" })).toBe(1);
    expect(aggregate({ ...skipped, SELECTED: "00" })).toBe(1);
  });

  it("reprova a lista vazia quando o plano, a cobertura ou o catálogo não passaram", () => {
    const empty = { PARTS: "skipped", SELECTED: "0" };
    for (const broken of ["PLAN", "COVERAGE", "CATALOG"]) {
      for (const result of ["failure", "skipped", "cancelled"]) {
        expect(aggregate({ ...empty, [broken]: result })).toBe(1);
      }
    }
  });

  it("reprova shard que falhou ou foi cancelado, com ou sem seleção", () => {
    for (const result of ["failure", "cancelled"]) {
      expect(aggregate({ PARTS: result })).toBe(1);
      expect(aggregate({ PARTS: result, SELECTED: "0" })).toBe(1);
    }
  });

  it("segue aceitando tudo pulado quando a detecção disse que o navegador não muda", () => {
    const untouched = {
      BROWSER: "false",
      CATALOG: "skipped",
      COVERAGE: "skipped",
      PARTS: "skipped",
      PLAN: "skipped",
      SELECTED: "",
    };
    expect(aggregate(untouched)).toBe(0);
    expect(aggregate({ ...untouched, CI_FULL: "true" })).toBe(1);
    expect(aggregate({ ...untouched, CHANGES: "failure" })).toBe(1);
    expect(aggregate({ ...untouched, BROWSER: "true" })).toBe(1);
  });
});

describe("os jobs do gate de navegador no ci.yml", () => {
  const plan = jobBlock("shard-plan");

  it("o plano lê o diff, escolhe os specs sem poder reprovar o job e os passa ao plano", () => {
    expect(plan).toContain("fetch-depth: 2");
    expect(plan).toContain(
      "node scripts/ci-select-specs.mjs --diff HEAD^1 HEAD --out apps/web/shard-plan/selection.json ||"
    );
    expect(plan).toContain("--selection apps/web/shard-plan/selection.json");
    expect(plan).toMatch(SELECTED_OUTPUT);
    expect(plan).toContain(
      "echo \"selected=$(jq '[.shards[].files[] | length] | add // 0' apps/web/shard-plan/plan.json)\""
    );
    const selectAt = plan.indexOf("Select the specs of the change");
    expect(selectAt).toBeGreaterThan(
      plan.indexOf("List the tests of each config")
    );
    expect(selectAt).toBeLessThan(plan.indexOf("id: plan"));
  });

  it("os shards pulam com 0 arquivos selecionados e só então", () => {
    const parts = jobBlock("offline-poc-browser-part");
    const condition = parts
      .split("\n")
      .find((line) => line.includes("if: ${{ !cancelled()"));
    expect(condition).toContain("needs.shard-plan.outputs.selected != '0'");
    expect(condition).toContain("needs.shard-plan.result == 'success'");
  });

  it("a cobertura roda sempre que há plano e só baixa os relatórios dos shards quando houve shard", () => {
    const coverage = jobBlock("shard-coverage");
    expect(coverage).toContain(
      `if: ${expression("!cancelled() && github.event_name != 'push' && needs.shard-plan.result == 'success'")}`
    );
    expect(coverage).toMatch(COVERAGE_DOWNLOAD);
  });
});
