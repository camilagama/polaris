import { readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The split of the browser gate by time. Reads the time per file of `ci/test-durations.json` (`scripts/ci-timing.mjs
 * --durations`) and the real list of each Playwright config (`playwright test --list --reporter=json`, with the same
 * projects the shard runs), and hands the files out to K shards, the longest first, each to the shard with the least time
 * so far (LPT). A file is the unit: it runs whole, on every project of its config, in one shard. A listed file without a
 * time counts as the median of the timed ones; a timed file the list no longer has is left out.
 *
 * The weight of a file is its time divided by the workers of its config (`config.workers` of the list, which the plan job
 * computes on the same runner as the shards): a shard runs each config with that many workers, and the wall of a config
 * in a shard was its summed test time over its workers (2.85 to 2.91 with 3 workers, 3.6 to 3.94 with 4, run
 * 44835784977). `--workers <suite>=<n>` overrides the number, to simulate the CI elsewhere.
 *
 * With `--selection <file>` (the output of `scripts/ci-select-specs.mjs`) a pull request plans only the files whose
 * repository path the selection names, and no more shards than files; `full: true`, a missing or unreadable file and a
 * folder the plan cannot place in the repository plan every file. The plan keeps the selection and the repository
 * folder of each suite (`repoDirs`), which is what the guard `scripts/ci-shard-coverage.mjs` compares the list with.
 *
 * Usage:
 *   node scripts/ci-shard-plan.mjs --shards 10 --list offline-poc=list-offline-poc.json --list pwa=list-pwa.json
 *     [--durations ci/test-durations.json] [--workers <suite>=<n>] [--selection selection.json] [--out plan.json]
 *   node scripts/ci-shard-plan.mjs --filters plan.json --shard 2 --suite pwa
 *
 * The second form prints, one per line, the arguments of `playwright test` for the files of that shard and suite: the
 * CLI reads each argument as a regular expression over the absolute path, so a bare `home.e2e.ts` would also take
 * `dashboard-home.e2e.ts`; the filter is anchored at the test folder and at the end.
 */

const DEFAULT_DURATIONS = "ci/test-durations.json";

function* testsOf(suite) {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      yield test;
    }
  }
  for (const child of suite.suites ?? []) {
    yield* testsOf(child);
  }
}

/**
 * The tests of a Playwright JSON report (of `--list` or of a run), `[{ file, project, ran }]`. The file is that of the
 * top suite, as in `sumDurations` of `ci-timing.mjs`; `ran` says the test has a result (a test skipped by a modifier has
 * one, a test the run never reached has none).
 */
export function testsOfReport(report) {
  const tests = [];
  for (const top of report.suites ?? []) {
    for (const test of testsOf(top)) {
      tests.push({
        file: top.file,
        project: test.projectName ?? "",
        ran: (test.results ?? []).length > 0,
        skipped: (test.results ?? []).at(-1)?.status === "skipped",
      });
    }
  }
  return tests;
}

export function testDirOf(report) {
  const { configFile, rootDir } = report.config ?? {};
  if (!(configFile && rootDir)) {
    throw new Error("the --list report has no config.configFile/rootDir");
  }
  return relative(dirname(configFile), rootDir).split("\\").join("/");
}

export function median(values) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

const byName = (a, b) => a.localeCompare(b, "en");

/**
 * The files to split, `[{ suite, file, ms, timed, weight }]`: each listed file with the sum of its times on the projects
 * it is listed for, or the median of the timed files when it has none; `weight` is `ms` over the workers of its suite.
 */
export function weighFiles(durations, lists, workers = {}) {
  const times = new Map();
  for (const entry of durations.entries ?? []) {
    const key = JSON.stringify([entry.suite, entry.file, entry.project]);
    times.set(key, (times.get(key) ?? 0) + entry.ms);
  }
  const files = [];
  for (const [suite, report] of Object.entries(lists)) {
    const projects = new Map();
    for (const test of testsOfReport(report)) {
      const set = projects.get(test.file) ?? new Set();
      set.add(test.project);
      projects.set(test.file, set);
    }
    for (const [file, set] of projects) {
      let ms = 0;
      let timed = false;
      for (const project of set) {
        const time = times.get(JSON.stringify([suite, file, project]));
        if (time !== undefined) {
          ms += time;
          timed = true;
        }
      }
      files.push({ file, ms, suite, timed });
      files.at(-1).workers = workersOf(suite, lists, workers);
    }
  }
  const fallback = median(files.filter((f) => f.timed).map((f) => f.ms));
  for (const file of files) {
    if (!file.timed) {
      file.ms = fallback;
    }
    file.weight = file.ms / file.workers;
  }
  return files.sort(
    (a, b) => byName(a.suite, b.suite) || byName(a.file, b.file)
  );
}

export function workersOf(suite, lists, workers = {}) {
  const value = workers[suite] ?? lists[suite]?.config?.workers ?? 1;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${suite}: workers must be a whole number from 1 up`);
  }
  return value;
}

/**
 * LPT: the heaviest file first, to the shard with the least weight so far (the lowest number on a tie). `estimatedMs` of a shard is
 * its estimated wall: the sum of the weights of its files.
 */
const fileCount = (shard) =>
  Object.values(shard.files).reduce((n, list) => n + list.length, 0);

export function planShards(files, count, testDirs = {}, scope = {}) {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error("the number of shards must be a whole number from 1 up");
  }
  const shards = Array.from({ length: count }, (_, index) => ({
    estimatedMs: 0,
    files: {},
    shard: index + 1,
  }));
  const order = [...files].sort(
    (a, b) =>
      b.weight - a.weight || byName(a.suite, b.suite) || byName(a.file, b.file)
  );
  for (const file of order) {
    let [target] = shards;
    for (const shard of shards) {
      if (
        shard.estimatedMs < target.estimatedMs ||
        (shard.estimatedMs === target.estimatedMs &&
          fileCount(shard) < fileCount(target))
      ) {
        target = shard;
      }
    }
    target.estimatedMs += file.weight;
    target.files[file.suite] = [...(target.files[file.suite] ?? []), file.file];
  }
  for (const shard of shards) {
    shard.estimatedMs = Math.round(shard.estimatedMs);
    for (const list of Object.values(shard.files)) {
      list.sort(byName);
    }
  }
  return {
    shards,
    testDirs,
    untimed: files
      .filter((f) => !f.timed)
      .map(({ file, suite }) => ({ file, suite })),
    version: 1,
    workers: Object.fromEntries(files.map((f) => [f.suite, f.workers])),
    ...(scope.selection ? { selection: scope.selection } : {}),
    ...(scope.repoDirs ? { repoDirs: scope.repoDirs } : {}),
  };
}

const fullBecause = (motivo) => ({ full: true, motivo, specs: [] });

/**
 * The selection of a pull request, from the JSON of `ci-select-specs.mjs`. Anything that is not `{ full: false, specs:
 * [strings] }` is the whole suite: the plan never narrows on a selection it cannot read.
 */
export function parseSelection(value) {
  if (
    value?.full === false &&
    Array.isArray(value.specs) &&
    value.specs.every((spec) => typeof spec === "string")
  ) {
    return {
      full: false,
      motivo: String(value.motivo ?? ""),
      specs: [...new Set(value.specs)].sort(),
    };
  }
  return fullBecause(
    value?.full === true
      ? String(value.motivo ?? "a suíte toda foi pedida")
      : "seleção em formato desconhecido: a suíte toda roda"
  );
}

export function readSelection(path) {
  if (!path) {
    return fullBecause("sem seleção: a suíte toda roda");
  }
  try {
    return parseSelection(readJson(path));
  } catch (error) {
    return fullBecause(
      `seleção ilegível (${error.message}): a suíte toda roda`
    );
  }
}

/** The folder of a suite's specs relative to the repository, as in the paths of the selector (`apps/web/e2e-pwa`). */
export function repoDirOf(report, repoRoot = process.cwd()) {
  const { rootDir } = report.config ?? {};
  if (!rootDir) {
    throw new Error("the --list report has no config.rootDir");
  }
  return relative(repoRoot, rootDir).split("\\").join("/");
}

const insideRepo = (dir) =>
  dir !== "" && !dir.startsWith("..") && !isAbsolute(dir);

/**
 * Whether a listed file runs in this plan. A plan without a narrowing selection, or without the folder of the suite,
 * takes every file: what the plan cannot place counts as selected, so the guard asks for it.
 */
export function isSelected(plan, suite, file) {
  const { repoDirs, selection } = plan;
  const dir = repoDirs?.[suite];
  if (selection?.full !== false || !dir) {
    return true;
  }
  return selection.specs.includes(`${dir}/${file}`);
}

/**
 * The selection and the folders a plan of these lists keeps: the given selection when every suite folder is inside
 * the repository, the whole suite otherwise.
 */
export function scopeOf(selection, lists, repoRoot = process.cwd()) {
  const repoDirs = Object.fromEntries(
    Object.entries(lists).map(([suite, report]) => [
      suite,
      repoDirOf(report, repoRoot),
    ])
  );
  const outside = Object.entries(repoDirs).find(([, dir]) => !insideRepo(dir));
  if (selection.full || !outside) {
    return { repoDirs, selection };
  }
  return {
    repoDirs,
    selection: fullBecause(
      `${outside[0]}: a pasta ${outside[1] || "(vazia)"} não está no repositório, a suíte toda roda`
    ),
  };
}

/** The files of `files` that the scope of the plan runs. */
export function selectedFiles(files, scope) {
  return files.filter((file) => isSelected(scope, file.suite, file.file));
}

/**
 * The selected specs that live in a suite folder and that no list has: a path the plan cannot place, which the guard
 * reports instead of letting the selection shrink to nothing.
 */
export function unlistedSelection(files, scope) {
  if (scope.selection?.full !== false) {
    return [];
  }
  const dirs = Object.values(scope.repoDirs ?? {});
  const listed = new Set(
    files.map((file) => `${scope.repoDirs[file.suite]}/${file.file}`)
  );
  return scope.selection.specs.filter(
    (spec) =>
      dirs.some((dir) => spec.startsWith(`${dir}/`)) && !listed.has(spec)
  );
}

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

export function filtersOf(plan, shardNumber, suite) {
  const shard = plan.shards.find((s) => s.shard === shardNumber);
  if (!shard) {
    throw new Error(`the plan has no shard ${shardNumber}`);
  }
  const testDir = plan.testDirs?.[suite];
  if (!testDir) {
    throw new Error(`the plan has no test folder for ${suite}`);
  }
  return (shard.files[suite] ?? []).map(
    (file) => `/${`/${testDir}/${file}`.replace(REGEX_SPECIAL, "\\$&")}$/`
  );
}

const minutes = (ms) => (ms / 60_000).toFixed(1).replace(".", ",");

export function plannedFileCount(plan) {
  return plan.shards.reduce((total, shard) => total + fileCount(shard), 0);
}

export function renderPlan(plan) {
  const times = plan.shards.map((s) => s.estimatedMs);
  const mid = median(times);
  const spread = Math.max(...times) - Math.min(...times);
  const lines = [
    "| Shard | Arquivos | Parede estimada: soma dos testes ÷ workers (min) |",
    "| --- | ---: | ---: |",
    ...plan.shards.map(
      (s) =>
        `| ${s.shard} | ${Object.values(s.files).reduce((n, l) => n + l.length, 0)} | ${minutes(s.estimatedMs)} |`
    ),
    "",
    `Mais lento − mais rápido: ${minutes(spread)} min, ${mid ? ((100 * spread) / mid).toFixed(1).replace(".", ",") : "-"}% da mediana (${minutes(mid)} min).`,
  ];
  if (plan.selection) {
    lines.push(
      plan.selection.full
        ? `Seleção: a suíte toda (${plan.selection.motivo}).`
        : `Seleção: ${plannedFileCount(plan)} de ${plan.listedFiles ?? "?"} arquivos (${plan.selection.motivo}).`
    );
  }
  if (plan.untimed.length > 0) {
    lines.push(
      `Sem tempo (contados pela mediana): ${plan.untimed.map((f) => `${f.suite}:${f.file}`).join(", ")}.`
    );
  }
  return `${lines.join("\n")}\n`;
}

export function readLists(pairs) {
  const lists = {};
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    if (at < 1) {
      throw new Error(`--list needs <suite>=<file>, got ${pair}`);
    }
    lists[pair.slice(0, at)] = readJson(pair.slice(at + 1));
  }
  return lists;
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function parseArgs(argv) {
  const options = { lists: [], workers: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      i += 1;
      if (argv[i] === undefined) {
        throw new Error(`${arg} needs a value`);
      }
      return argv[i];
    };
    if (arg === "--shards") {
      options.shards = Number(value());
    } else if (arg === "--durations") {
      options.durations = value();
    } else if (arg === "--list") {
      options.lists.push(value());
    } else if (arg === "--out") {
      options.out = value();
    } else if (arg === "--workers") {
      const [suite, count] = value().split("=");
      options.workers[suite] = Number(count);
    } else if (arg === "--filters") {
      options.filters = value();
    } else if (arg === "--shard") {
      options.shard = Number(value());
    } else if (arg === "--suite") {
      options.suite = value();
    } else if (arg === "--selection") {
      options.selection = value();
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  return options;
}

/**
 * The plan of the browser gate for these lists. A narrowing selection plans only its files and at most one shard per
 * file, so that no shard starts with nothing to run; the whole suite plans every file in `shards` shards.
 */
export function buildPlan({
  durations,
  lists,
  repoRoot,
  selection,
  shards,
  workers,
}) {
  const scope = scopeOf(selection, lists, repoRoot);
  const all = weighFiles(durations, lists, workers);
  const files = selectedFiles(all, scope);
  const testDirs = Object.fromEntries(
    Object.entries(lists).map(([suite, report]) => [suite, testDirOf(report)])
  );
  const count =
    scope.selection.full === false
      ? Math.max(1, Math.min(shards, files.length))
      : shards;
  return {
    ...planShards(files, count, testDirs, scope),
    listedFiles: all.length,
    unlisted: unlistedSelection(all, scope),
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.filters) {
    const plan = readJson(options.filters);
    for (const filter of filtersOf(plan, options.shard, options.suite)) {
      process.stdout.write(`${filter}\n`);
    }
    return;
  }
  if (options.lists.length === 0) {
    throw new Error("at least one --list <suite>=<file> is needed");
  }
  const lists = readLists(options.lists);
  for (const [suite, report] of Object.entries(lists)) {
    if (testsOfReport(report).length === 0) {
      throw new Error(`${suite}: the --list has no test`);
    }
  }
  const plan = buildPlan({
    durations: readJson(options.durations ?? DEFAULT_DURATIONS),
    lists,
    selection: readSelection(options.selection),
    shards: options.shards,
    workers: options.workers,
  });
  const text = `${JSON.stringify(plan, null, 2)}\n`;
  if (options.out) {
    writeFileSync(options.out, text);
  } else {
    process.stdout.write(text);
  }
  process.stderr.write(renderPlan(plan));
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
