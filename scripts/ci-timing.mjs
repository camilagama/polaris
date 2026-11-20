import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";

/**
 * Where the minutes of the CI go. Reads the green runs of `ci.yml` from the GitHub REST API and splits every job into
 * the wait for a runner (`created_at` to `started_at`), the preparation (start of the job to the end of the last
 * step of the opening sequence: pulling the container image, checkout, Node, Bun, cache, `bun install`, `playwright install`,
 * the read of the Playwright version and the check of it against the image tag) and the execution (the rest). With
 * `--durations`, sums the time per test file from the JSON reports the browser shards upload.
 *
 * Usage:
 *   GITHUB_TOKEN=... node scripts/ci-timing.mjs [--runs 25] [--json out.json] [--repo owner/name]
 *   node scripts/ci-timing.mjs --durations <folder | run id> [--out ci/test-durations.json]
 */

const DEFAULT_RUNS = 25;
const DEFAULT_REPO = "camilagama/polaris";
const WORKFLOW = "ci.yml";
export const EVENTS = ["pull_request", "workflow_dispatch"];
const JOB_SETUP_STEP = "Set up job";
const IMAGE_PULL_STEP = "Initialize containers";
const REQUEST_BATCH = 5;
const BROWSER_GATE = "Offline browser gate";
const SHARD_SUFFIX = /^(.*?)\s*\(shard (\d+\/\d+)\)\s*$/;
const RUN_ID = /^\d+$/;
const TIMINGS_ARTIFACT = /^playwright-timings-/;
const TIMINGS_FILE = /^timings-(.+)\.json$/;
const INSTALL_STEP = new RegExp(
  [
    "^Run (actions/(checkout|setup-node|cache)@|oven-sh/setup-bun@|(bun|npm|pnpm) install|(bunx|npx) playwright install)",
    "^Run version=.*@playwright/test",
    String.raw`^Run test "\$\((bunx|npx) playwright --version\)"`,
    "^Install Chromium$",
  ].join("|")
);

const seconds = (iso) => Date.parse(iso) / 1000;

/** Percentile by linear interpolation between the closest ranks; `p` from 0 to 100. */
export function percentile(values, p) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = ((sorted.length - 1) * p) / 100;
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

/** `Offline browser gate (shard 2/4)` is the group `Offline browser gate`, shard `2/4`. */
export function groupOf(name) {
  const match = SHARD_SUFFIX.exec(name);
  return match ? { group: match[1], shard: match[2] } : { group: name };
}

/** The wait, preparation and execution of one job, in seconds; a job that never ran has no split. */
export function splitJob(job) {
  if (job.conclusion === "skipped" || !job.started_at || !job.completed_at) {
    return null;
  }
  const created = seconds(job.created_at);
  const started = seconds(job.started_at);
  const completed = seconds(job.completed_at);
  let prepEnd = started;
  for (const step of job.steps ?? []) {
    if (step.name === JOB_SETUP_STEP) {
      continue;
    }
    if (step.name !== IMAGE_PULL_STEP && !INSTALL_STEP.test(step.name)) {
      break;
    }
    if (!step.completed_at) {
      continue;
    }
    prepEnd = Math.min(seconds(step.completed_at), completed);
  }
  return {
    execution: completed - prepEnd,
    preparation: prepEnd - started,
    wait: Math.max(0, started - created),
  };
}

/** GitHub bills each job on its own, rounded up to the whole minute. */
export function billedMinutes(job) {
  if (job.conclusion === "skipped" || !job.started_at || !job.completed_at) {
    return 0;
  }
  return Math.ceil((seconds(job.completed_at) - seconds(job.started_at)) / 60);
}

/** The wall of a run: from its start to the end of the last job. */
export function wallOf(run, jobs) {
  const ends = jobs
    .filter((j) => j.completed_at)
    .map((j) => seconds(j.completed_at));
  if (ends.length === 0) {
    return null;
  }
  return Math.max(...ends) - seconds(run.run_started_at ?? run.created_at);
}

const stats = (values) => ({
  n: values.length,
  p50: percentile(values, 50),
  p95: percentile(values, 95),
});

/** The numbers of one event: `entries` is a list of `{ run, jobs }`. */
export function summarize(entries) {
  const groups = new Map();
  const walls = [];
  const gatedWalls = [];
  const minutes = [];
  for (const { run, jobs } of entries) {
    const wall = wallOf(run, jobs);
    if (wall !== null) {
      walls.push(wall);
      if (
        jobs.some(
          (job) =>
            groupOf(job.name).group === BROWSER_GATE &&
            job.conclusion !== "skipped"
        )
      ) {
        gatedWalls.push(wall);
      }
    }
    minutes.push(jobs.reduce((sum, job) => sum + billedMinutes(job), 0));
    for (const job of jobs) {
      const parts = splitJob(job);
      if (!parts) {
        continue;
      }
      const { group, shard } = groupOf(job.name);
      const bucket = groups.get(group) ?? {
        execution: [],
        minutes: [],
        preparation: [],
        shards: new Map(),
        total: [],
        wait: [],
      };
      bucket.execution.push(parts.execution);
      bucket.preparation.push(parts.preparation);
      bucket.wait.push(parts.wait);
      const total = parts.preparation + parts.execution;
      bucket.total.push(total);
      bucket.minutes.push(billedMinutes(job));
      if (shard) {
        bucket.shards.set(shard, [...(bucket.shards.get(shard) ?? []), total]);
      }
      groups.set(group, bucket);
    }
  }
  const jobs = [...groups.entries()]
    .map(([name, bucket]) => ({
      execution: stats(bucket.execution),
      minutes: bucket.minutes.reduce((a, b) => a + b, 0),
      name,
      preparation: stats(bucket.preparation),
      shards: [...bucket.shards.entries()]
        .map(([shard, totals]) => ({ shard, ...stats(totals) }))
        .sort((a, b) =>
          a.shard.localeCompare(b.shard, "en", { numeric: true })
        ),
      total: stats(bucket.total),
      wait: stats(bucket.wait),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
  return {
    jobs,
    minutesPerRun: stats(minutes),
    runIds: entries.map((entry) => entry.run.id),
    runs: entries.length,
    wall: stats(walls),
    wallWithBrowserGate: stats(gatedWalls),
  };
}

const minutesText = (value) =>
  value === null ? "-" : (value / 60).toFixed(1).replace(".", ",");

export function renderMarkdown(byEvent) {
  const lines = [];
  for (const [event, data] of Object.entries(byEvent)) {
    lines.push(`### ${event} (${data.runs} execuções verdes)`, "");
    if (data.runs === 0) {
      lines.push("Nenhuma execução verde encontrada.", "");
      continue;
    }
    const gated = data.wallWithBrowserGate;
    lines.push(
      `Parede (início → fim do último job): p50 **${minutesText(data.wall.p50)} min**, p95 ${minutesText(data.wall.p95)} min.`,
      `Só as execuções em que o gate de navegador rodou (${gated.n} de ${data.runs}): p50 **${minutesText(gated.p50)} min**, p95 ${minutesText(gated.p95)} min.`,
      `Minutos faturados por execução: p50 ${minutesText(data.minutesPerRun.p50 * 60)}, p95 ${minutesText(data.minutesPerRun.p95 * 60)}.`,
      "",
      "| Job | n | Espera p50 (s) | Espera p95 (s) | Preparação p50 (min) | Preparação p95 (min) | Execução p50 (min) | Execução p95 (min) | Total p50 (min) | Minutos somados |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
    );
    for (const job of data.jobs) {
      lines.push(
        `| ${job.name} | ${job.total.n} | ${job.wait.p50.toFixed(0)} | ${job.wait.p95.toFixed(0)} | ${minutesText(job.preparation.p50)} | ${minutesText(job.preparation.p95)} | ${minutesText(job.execution.p50)} | ${minutesText(job.execution.p95)} | ${minutesText(job.total.p50)} | ${job.minutes} |`
      );
    }
    for (const job of data.jobs.filter((j) => j.shards.length > 0)) {
      lines.push(
        "",
        `Shards de ${job.name} (preparação + execução):`,
        "",
        "| Shard | n | p50 (min) | p95 (min) |",
        "| --- | ---: | ---: | ---: |"
      );
      for (const shard of job.shards) {
        lines.push(
          `| ${shard.shard} | ${shard.n} | ${minutesText(shard.p50)} | ${minutesText(shard.p95)} |`
        );
      }
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function* specsOf(suite) {
  for (const spec of suite.specs ?? []) {
    yield spec;
  }
  for (const child of suite.suites ?? []) {
    yield* specsOf(child);
  }
}

/**
 * The time per test file and project of Playwright JSON reports, `[{ name, report }]` (`name` is the `<name>` of
 * `timings-<name>.json`). A test belongs to the file of its top suite, the one `--shard` hands out, and not to the
 * `spec.file` where `test()` was called: a helper such as `reflow.ts` creates tests for many spec files. Every attempt counts: a retry also took the shard's time. Sorted by suite, file and project,
 * with no clock in it, so the same reports always give the same file.
 */
export function sumDurations(reports) {
  const totals = new Map();
  for (const { name, report } of reports) {
    for (const top of report.suites ?? []) {
      for (const spec of specsOf(top)) {
        for (const test of spec.tests ?? []) {
          const file = top.file ?? spec.file;
          const key = JSON.stringify([name, file, test.projectName ?? ""]);
          const entry = totals.get(key) ?? { ms: 0, tests: 0 };
          entry.ms += (test.results ?? []).reduce(
            (sum, result) => sum + (result.duration ?? 0),
            0
          );
          entry.tests += 1;
          totals.set(key, entry);
        }
      }
    }
  }
  const entries = [...totals.entries()].map(([key, value]) => {
    const [suite, file, project] = JSON.parse(key);
    return {
      file,
      ms: Math.round(value.ms),
      project,
      suite,
      tests: value.tests,
    };
  });
  const order = (a, b) => a.localeCompare(b, "en");
  entries.sort(
    (a, b) =>
      order(a.suite, b.suite) ||
      order(a.file, b.file) ||
      order(a.project, b.project)
  );
  return { entries, unit: "ms", version: 1 };
}

/** The files of a zip, `{ name, data }`, read through the central directory (stored and deflated entries). */
export function unzip(buffer) {
  const END = 0x06_05_4b_50;
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== END) {
    end -= 1;
  }
  if (end < 0) {
    throw new Error("not a zip file: no end of central directory");
  }
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const files = [];
  for (let i = 0; i < count; i += 1) {
    const method = buffer.readUInt16LE(at + 10);
    const size = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString("utf8", at + 46, at + 46 + nameLength);
    const dataStart =
      local +
      30 +
      buffer.readUInt16LE(local + 26) +
      buffer.readUInt16LE(local + 28);
    const raw = buffer.subarray(dataStart, dataStart + size);
    if (method !== 0 && method !== 8) {
      throw new Error(`zip entry ${name}: unsupported method ${method}`);
    }
    if (name.startsWith("/") || name.split("/").includes("..")) {
      throw new Error(`zip entry ${name}: path leaves the folder`);
    }
    if (!name.endsWith("/")) {
      files.push({ data: method === 0 ? raw : inflateRawSync(raw), name });
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

function jsonFilesIn(folder) {
  const found = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) {
      found.push(...jsonFilesIn(path));
    } else if (TIMINGS_FILE.test(entry.name)) {
      found.push(path);
    }
  }
  return found.sort();
}

export function reportsFromFolder(folder) {
  const files = jsonFilesIn(folder);
  if (files.length === 0) {
    throw new Error(`no timings-<name>.json in ${folder}`);
  }
  return files.map((path) => ({
    name: TIMINGS_FILE.exec(path.split("/").pop())[1],
    report: JSON.parse(readFileSync(path, "utf8")),
  }));
}

function parseArgs(argv) {
  const options = { runs: DEFAULT_RUNS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      i += 1;
      if (argv[i] === undefined) {
        throw new Error(`${arg} needs a value`);
      }
      return argv[i];
    };
    if (arg === "--runs") {
      options.runs = Number(value());
    } else if (arg === "--json") {
      options.json = value();
    } else if (arg === "--repo") {
      options.repo = value();
    } else if (arg === "--durations") {
      options.durations = value();
    } else if (arg === "--out") {
      options.out = value();
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  if (
    !Number.isInteger(options.runs) ||
    options.runs < 1 ||
    options.runs > 100
  ) {
    throw new Error("--runs must be a whole number from 1 to 100");
  }
  return options;
}

function client(repo) {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN is not set");
  }
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
  };
  const base = `https://api.github.com/repos/${repo}`;
  return {
    async binary(path) {
      const response = await fetch(`${base}${path}`, { headers });
      if (!response.ok) {
        throw new Error(`GET ${path}: ${response.status}`);
      }
      return Buffer.from(await response.arrayBuffer());
    },
    async json(path) {
      const response = await fetch(`${base}${path}`, { headers });
      if (!response.ok) {
        throw new Error(`GET ${path}: ${response.status}`);
      }
      return response.json();
    },
  };
}

async function greenRuns(api, event, wanted) {
  const runs = [];
  for (let page = 1; runs.length < wanted; page += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: pages are read one after the other, to stop at the number wanted
    const body = await api.json(
      `/actions/workflows/${WORKFLOW}/runs?event=${event}&status=success&per_page=50&page=${page}`
    );
    runs.push(
      ...body.workflow_runs.filter((run) => run.conclusion === "success")
    );
    if (body.workflow_runs.length < 50) {
      break;
    }
  }
  return runs.slice(0, wanted);
}

async function jobsOf(api, run) {
  const jobs = [];
  for (let page = 1; ; page += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: pages are read one after the other, until a short page
    const body = await api.json(
      `/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`
    );
    jobs.push(...body.jobs);
    if (body.jobs.length < 100) {
      return jobs;
    }
  }
}

async function measure(options) {
  const api = client(options.repo);
  const measured = [];
  for (const event of EVENTS) {
    // biome-ignore lint/performance/noAwaitInLoops: the two events one after the other, to keep the requests in flight few
    const runs = await greenRuns(api, event, options.runs);
    const entries = [];
    for (let at = 0; at < runs.length; at += REQUEST_BATCH) {
      // biome-ignore lint/performance/noAwaitInLoops: batches of runs, one after the other
      const batch = await Promise.all(
        runs.slice(at, at + REQUEST_BATCH).map(async (run) => ({
          jobs: await jobsOf(api, run),
          run,
        }))
      );
      entries.push(...batch);
    }
    measured.push([event, summarize(entries)]);
  }
  const byEvent = Object.fromEntries(measured);
  process.stdout.write(renderMarkdown(byEvent));
  if (options.json) {
    writeFileSync(options.json, `${JSON.stringify(byEvent, null, 2)}\n`);
  }
}

async function reportsFromRun(options, runId) {
  const api = client(options.repo);
  const { artifacts } = await api.json(
    `/actions/runs/${runId}/artifacts?per_page=100`
  );
  const wanted = artifacts.filter(
    (artifact) => TIMINGS_ARTIFACT.test(artifact.name) && !artifact.expired
  );
  if (wanted.length === 0) {
    throw new Error(`run ${runId} has no playwright-timings-* artifact`);
  }
  const folder = mkdtempSync(join(tmpdir(), "ci-timing-"));
  try {
    await Promise.all(
      wanted.map(async (artifact) => {
        const zip = await api.binary(`/actions/artifacts/${artifact.id}/zip`);
        for (const file of unzip(zip)) {
          const target = join(folder, artifact.name, file.name);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, file.data);
        }
      })
    );
    return reportsFromFolder(folder);
  } finally {
    rmSync(folder, { force: true, recursive: true });
  }
}

async function durations(options) {
  const reports = RUN_ID.test(options.durations)
    ? await reportsFromRun(options, options.durations)
    : reportsFromFolder(options.durations);
  const out = options.out ?? "ci/test-durations.json";
  mkdirSync(dirname(out), { recursive: true });
  const sums = sumDurations(reports);
  writeFileSync(out, `${JSON.stringify(sums, null, 2)}\n`);
  console.log(`${out}: ${sums.entries.length} arquivo × projeto`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  options.repo ??= process.env.GITHUB_REPOSITORY ?? DEFAULT_REPO;
  await (options.durations ? durations(options) : measure(options));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
