import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  isSelected,
  readJson,
  readLists,
  testsOfReport,
} from "./ci-shard-plan.mjs";

/**
 * The guard of the split of the browser gate: nothing the list has may go unplanned or unrun. Compares the files of the
 * plan (`scripts/ci-shard-plan.mjs`) with the real list of each config (`playwright test --list --reporter=json`), and
 * the tests the shards ran (their `timings-<suite>.json`, in `playwright-timings-shard-<n>/`) with the tests the list
 * has, per suite, file and project. Any difference is a line that names the file, project or count, and the exit code
 * is 1.
 *
 * A plan that narrows (`plan.selection.full === false`, the pull request run) is compared with the listed tests of the
 * selected files only: every selected file must be in exactly one shard and run, and a file the selection leaves out
 * must be in none. A plan with no selection, or with `full: true`, is compared with the whole list.
 *
 * Usage:
 *   node scripts/ci-shard-coverage.mjs --plan plan.json --list offline-poc=list-offline-poc.json --list pwa=list-pwa.json
 *     --reports <folder with playwright-timings-shard-<n>/timings-<suite>.json>
 */

const SHARD_FOLDER = /shard-(\d+)$/;
const REPORT_FILE = /^timings-(.+)\.json$/;

export function reportsFromFolder(folder) {
  const found = [];
  if (!existsSync(folder)) {
    return found;
  }
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const match = SHARD_FOLDER.exec(entry.name);
    if (!(entry.isDirectory() && match)) {
      continue;
    }
    for (const name of readdirSync(join(folder, entry.name))) {
      const report = REPORT_FILE.exec(name);
      if (report) {
        found.push({
          report: readJson(join(folder, entry.name, name)),
          shard: Number(match[1]),
          suite: report[1],
        });
      }
    }
  }
  return found;
}

const countKey = (suite, file, project) =>
  `${suite} ${file} [${project || "sem projeto"}]`;

function addCount(map, key, by = 1) {
  map.set(key, (map.get(key) ?? 0) + by);
}

function plannedFiles(plan) {
  const planned = new Map();
  for (const shard of plan.shards ?? []) {
    for (const [suite, files] of Object.entries(shard.files ?? {})) {
      for (const file of files) {
        const key = `${suite} ${file}`;
        planned.set(key, [...(planned.get(key) ?? []), shard.shard]);
      }
    }
  }
  return planned;
}

/** The files of every list (`everything`) and those of them the plan has to run (`selected`). */
function listedFiles(plan, lists) {
  const everything = new Set();
  const selected = new Set();
  for (const [suite, report] of Object.entries(lists)) {
    for (const test of testsOfReport(report)) {
      everything.add(`${suite} ${test.file}`);
      if (isSelected(plan, suite, test.file)) {
        selected.add(`${suite} ${test.file}`);
      }
    }
  }
  return { everything, selected };
}

function checkFiles(plan, lists, problems) {
  const planned = plannedFiles(plan);
  const { everything, selected } = listedFiles(plan, lists);
  for (const key of [...selected].sort()) {
    if (!planned.has(key)) {
      problems.push(`fora do plano: ${key} está no --list e em nenhum shard`);
    }
  }
  for (const spec of plan.unlisted ?? []) {
    problems.push(
      `selecionado e fora do --list: ${spec} está na seleção e em nenhuma lista`
    );
  }
  for (const [key, shards] of [...planned].sort()) {
    if (!everything.has(key)) {
      problems.push(`fora da lista: ${key} está no plano e não no --list`);
    } else if (!selected.has(key)) {
      problems.push(
        `fora da seleção: ${key} está no plano e a seleção do PR não o pede`
      );
    }
    if (shards.length > 1) {
      problems.push(`em mais de um shard: ${key} (${shards.join(", ")})`);
    }
  }
}

function countListed(plan, lists) {
  const expected = new Map();
  for (const [suite, report] of Object.entries(lists)) {
    for (const test of testsOfReport(report)) {
      if (isSelected(plan, suite, test.file)) {
        addCount(expected, countKey(suite, test.file, test.project));
      }
    }
  }
  return expected;
}

function countRan(plan, reports, problems) {
  const ran = new Map();
  for (const { report, shard, suite } of reports) {
    const own = new Set(
      plan.shards?.find((s) => s.shard === shard)?.files?.[suite] ?? []
    );
    const outside = new Set();
    for (const test of testsOfReport(report)) {
      if (test.ran) {
        addCount(ran, countKey(suite, test.file, test.project));
      }
      if (!own.has(test.file)) {
        outside.add(test.file);
      }
    }
    for (const file of [...outside].sort()) {
      problems.push(
        `shard ${shard} rodou ${suite} ${file}, que o plano não pôs nele`
      );
    }
  }
  return ran;
}

function checkReportsPresent(plan, reports, problems) {
  for (const shard of plan.shards ?? []) {
    for (const [suite, files] of Object.entries(shard.files ?? {})) {
      const has = reports.some(
        (r) => r.shard === shard.shard && r.suite === suite
      );
      if (files.length > 0 && !has) {
        problems.push(
          `shard ${shard.shard}: sem timings-${suite}.json (${files.length} arquivos planejados sem relatório)`
        );
      }
    }
  }
}

function compareCounts(expected, ran, problems) {
  const keys = new Set([...expected.keys(), ...ran.keys()]);
  for (const key of [...keys].sort()) {
    const want = expected.get(key) ?? 0;
    const got = ran.get(key) ?? 0;
    if (want !== got) {
      problems.push(`${key}: ${want} no --list, ${got} executados`);
    }
  }
}

function checkRuns(plan, lists, reports, problems) {
  const expected = countListed(plan, lists);
  const ran = countRan(plan, reports, problems);
  checkReportsPresent(plan, reports, problems);
  compareCounts(expected, ran, problems);
  const totals = {};
  for (const suite of Object.keys(lists)) {
    if (testsOfReport(lists[suite]).length === 0) {
      problems.push(`${suite}: o --list não tem nenhum teste`);
    }
    const sum = (map) =>
      [...map]
        .filter(([key]) => key.startsWith(`${suite} `))
        .reduce((n, [, count]) => n + count, 0);
    totals[suite] = {
      listed: sum(expected),
      ran: sum(ran),
      skipped: reports
        .filter((r) => r.suite === suite)
        .flatMap((r) => testsOfReport(r.report))
        .filter((t) => t.skipped).length,
    };
    if (totals[suite].listed !== totals[suite].ran) {
      problems.push(
        `${suite}: ${totals[suite].listed} testes no --list, ${totals[suite].ran} executados`
      );
    }
  }
  return totals;
}

export function checkCoverage({ lists, plan, reports }) {
  const problems = [];
  checkFiles(plan, lists, problems);
  const totals = checkRuns(plan, lists, reports, problems);
  return { problems, totals };
}

function parseArgs(argv) {
  const options = { lists: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      i += 1;
      if (argv[i] === undefined) {
        throw new Error(`${arg} needs a value`);
      }
      return argv[i];
    };
    if (arg === "--plan") {
      options.plan = value();
    } else if (arg === "--list") {
      options.lists.push(value());
    } else if (arg === "--reports") {
      options.reports = value();
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  if (!(options.plan && options.reports && options.lists.length > 0)) {
    throw new Error("--plan, --reports and at least one --list are needed");
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const plan = readJson(options.plan);
  const { problems, totals } = checkCoverage({
    lists: readLists(options.lists),
    plan,
    reports: reportsFromFolder(options.reports),
  });
  console.log(
    plan.selection?.full === false
      ? `seleção do PR: ${plan.selection.specs.length} specs (${plan.selection.motivo})`
      : "sem seleção: a suíte toda"
  );
  for (const [suite, total] of Object.entries(totals)) {
    console.log(
      `${suite}: ${total.listed} no --list, ${total.ran} executados (${total.skipped} deles pulados)`
    );
  }
  if (problems.length > 0) {
    console.error(`shard-coverage: ${problems.length} diferença(s)`);
    for (const problem of problems) {
      console.error(`- ${problem}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    "shard-coverage: todo arquivo planejado uma vez, todo teste executado"
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
