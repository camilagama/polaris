import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * The flaky report of the e2e journeys on the real local stack (T-125a). The job retries once; a test that only
 * passed on the retry is a hidden failure, so it is listed in the step summary (journey, project, first error),
 * and the run FAILS when two or more tests passed only on the retry, or when any money journey (sale,
 * return/cancellation, stock) did. A test annotated `retry-proposital` retries on purpose (the T0 harness test)
 * and is not counted.
 *
 * Usage: node scripts/e2e-flaky-report.mjs apps/web/test-results/e2e-real-report.json
 * With `--report-only` the summary is written but the run never fails because of flaky tests; `--label <text>` names
 * the suite in the summary heading (default: "e2e na pilha real"). A report that is missing, cut off or without
 * `suites` is named in one line on stderr (path and label) and in the summary; it fails the run like a flaky
 * verdict does, and with `--report-only` it exits 0.
 */

const MONEY_JOURNEYS = /jornadas\/(venda|devolucao|estoque)\.e2e\.ts$/;
const PURPOSEFUL_RETRY = "retry-proposital";
export const FLAKY_LIMIT = 2;
const DEFAULT_LABEL = "e2e na pilha real";

function* tests(suite, file) {
  const here = suite.file ?? file;
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      yield { file: spec.file ?? here, test, title: spec.title };
    }
  }
  for (const child of suite.suites ?? []) {
    yield* tests(child, here);
  }
}

function annotated(test) {
  const annotations = [
    ...(test.annotations ?? []),
    ...(test.results ?? []).flatMap((result) => result.annotations ?? []),
  ];
  return annotations.some((annotation) => annotation.type === PURPOSEFUL_RETRY);
}

function firstError(test) {
  const failed = (test.results ?? []).find(
    (result) => result.status !== "passed"
  );
  const message = failed?.error?.message ?? failed?.errors?.[0]?.message ?? "";
  return message.replace(ANSI_COLOR, "").split("\n")[0].slice(0, 200);
}

/** The flaky tests of a Playwright JSON report and the verdict of the threshold. */
export function flakyReport(report) {
  const flaky = [];
  for (const suite of report.suites ?? []) {
    for (const { file, test, title } of tests(suite)) {
      if (test.status === "flaky" && !annotated(test)) {
        flaky.push({
          error: firstError(test),
          file,
          money: MONEY_JOURNEYS.test(file),
          project: test.projectName,
          title,
        });
      }
    }
  }
  const reasons = [];
  if (flaky.length >= FLAKY_LIMIT) {
    reasons.push(
      `${flaky.length} tests passed only on the retry (limit: fewer than ${FLAKY_LIMIT})`
    );
  }
  if (flaky.some((entry) => entry.money)) {
    reasons.push(
      "a money journey (sale, return/cancellation, stock) passed only on the retry"
    );
  }
  return { failed: reasons.length > 0, flaky, reasons };
}

export function summary({ flaky, reasons }, label = DEFAULT_LABEL) {
  const lines = [`### ${label}: testes que só passaram no retry`, ""];
  if (flaky.length === 0) {
    lines.push("Nenhum.");
  } else {
    lines.push(
      "| Jornada | Projeto | Teste | Primeiro erro |",
      "| --- | --- | --- | --- |"
    );
    for (const entry of flaky) {
      lines.push(
        `| ${entry.file} | ${entry.project} | ${entry.title} | ${entry.error.replaceAll("|", "\\|")} |`
      );
    }
  }
  if (reasons.length > 0) {
    lines.push("", `**Reprovado:** ${reasons.join("; ")}.`);
  }
  return `${lines.join("\n")}\n`;
}

const ANSI_COLOR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function parseArgs(args) {
  let reportOnly = false;
  let label = DEFAULT_LABEL;
  let path;
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at];
    if (arg === "--report-only") {
      reportOnly = true;
    } else if (arg === "--label") {
      at += 1;
      label = args[at];
    } else if (arg.startsWith("--") || path !== undefined) {
      return;
    } else {
      path = arg;
    }
  }
  if (path === undefined || !label || label.startsWith("--")) {
    return;
  }
  return { label, path, reportOnly };
}

/** Reads the Playwright report; a missing, cut-off or misshapen file is a problem to report, not a stack trace. */
function loadReport(path) {
  let report;
  try {
    report = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { problem: error.code === "ENOENT" ? "ausente" : "ilegível" };
  }
  if (!(report && typeof report === "object" && Array.isArray(report.suites))) {
    return { problem: "ilegível" };
  }
  return { report };
}

function unusableMessage(problem, { label, path }) {
  return problem === "ausente"
    ? `Relatório do Playwright ausente (${label}): ${path} não existe.`
    : `Relatório do Playwright ilegível (${label}): ${path} não pôde ser lido como relatório do Playwright (JSON com suites).`;
}

function unusableSummary(problem, { label, path }) {
  const what =
    problem === "ausente"
      ? `**Relatório não existe:** \`${path}\``
      : `**Relatório ilegível:** \`${path}\` não pôde ser lido como relatório do Playwright (JSON com suites); um relatório cortado no meio cai aqui`;
  return [
    `### ${label}: testes que só passaram no retry`,
    "",
    `${what}; não há como listar os testes instáveis.`,
    "",
    "**Reprovado:** sem relatório para conferir.",
    "",
  ].join("\n");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    throw new Error(
      "usage: node scripts/e2e-flaky-report.mjs <playwright json report> [--report-only] [--label <text>]"
    );
  }
  const loaded = loadReport(options.path);
  const result = loaded.report ? flakyReport(loaded.report) : undefined;
  const text = result
    ? summary(result, options.label)
    : unusableSummary(loaded.problem, options);
  console.log(text);
  if (!result) {
    console.error(unusableMessage(loaded.problem, options));
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  }
  if ((result?.failed ?? true) && !options.reportOnly) {
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
