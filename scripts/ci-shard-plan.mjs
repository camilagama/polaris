import { readFileSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
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
 * Usage:
 *   node scripts/ci-shard-plan.mjs --shards 4 --list offline-poc=list-offline-poc.json --list pwa=list-pwa.json
 *     [--durations ci/test-durations.json] [--workers <suite>=<n>] [--out plan.json]
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

export function planShards(files, count, testDirs = {}) {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error("the number of shards must be a whole number from 1 up");
  }
  const shards = Array.from({ length: count }, (_, index) => ({
    files: {},
    estimatedMs: 0,
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
    workers: Object.fromEntries(files.map((f) => [f.suite, f.workers])),
    untimed: files
      .filter((f) => !f.timed)
      .map(({ file, suite }) => ({ file, suite })),
    version: 1,
  };
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
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  return options;
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
  const durations = readJson(options.durations ?? DEFAULT_DURATIONS);
  const testDirs = Object.fromEntries(
    Object.entries(lists).map(([suite, report]) => [suite, testDirOf(report)])
  );
  const plan = planShards(
    weighFiles(durations, lists, options.workers),
    options.shards,
    testDirs
  );
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
