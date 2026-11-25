import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  billedMinutes,
  budgetExitCode,
  databaseWallOf,
  groupOf,
  overBudget,
  percentile,
  readBudgets,
  renderBudget,
  renderMarkdown,
  reportsFromFolder,
  splitJob,
  sumDurations,
  summarize,
  unmeasured,
  unzip,
  wallOf,
} from "./ci-timing.mjs";

const at = (offsetSeconds) =>
  new Date(Date.UTC(2026, 0, 1, 12, 0, 0) + offsetSeconds * 1000).toISOString();

const SPEC_FILE = /\.(e2e|spec)\.ts$/;

const step = (name, from, to) => ({
  completed_at: at(to),
  name,
  started_at: at(from),
});

/** A job created at 0 s, picked up at `started`, with the install steps ending at `installEnd` and the job at `end`. */
function job(name, { started, installEnd, end, conclusion = "success" }) {
  return {
    completed_at: at(end),
    conclusion,
    created_at: at(0),
    name,
    started_at: at(started),
    steps: [
      step("Set up job", started, started + 2),
      step("Run actions/checkout@abc", started + 2, started + 10),
      step("Run actions/setup-node@abc", started + 10, started + 20),
      step("Run oven-sh/setup-bun@abc", started + 20, started + 25),
      step("Run actions/cache@abc", started + 25, started + 40),
      step("Run bun install --frozen-lockfile", started + 40, installEnd - 30),
      step(
        "Run bunx playwright install --with-deps chromium",
        installEnd - 30,
        installEnd
      ),
      step("Run bun run test", installEnd, end - 5),
      step("Run bunx playwright install chromium", end - 5, end - 4),
      step("Post Run actions/checkout@abc", end - 4, end),
    ],
  };
}

const CHROMIUM_STEP_NAME = "Chromium (cache da main, sem apt)";
const CHROMIUM_ACTION = "./.github/actions/chromium";
const QUOTES = /^(["'])(.*)\1$/;
const STEP_START = /^ {6}- /;
const STEP_NAME = /^(?: {6}- | {8})name:\s*(.+?)\s*(?:\s#.*)?$/;
const STEP_USES = /^(?: {6}- | {8})uses:\s*(\S+)/;

/** The steps of a job that runs the opening sequence, a Chromium step called `chromiumName` ending at `start + 90`, and the tests. */
function chromiumJobSteps(chromiumName, start) {
  return [
    step("Set up job", start, start + 2),
    step("Run actions/checkout@abc", start + 2, start + 10),
    step("Run actions/setup-node@abc", start + 10, start + 20),
    step("Run oven-sh/setup-bun@abc", start + 20, start + 25),
    step("Run actions/cache@abc", start + 25, start + 40),
    step("Run bun install --frozen-lockfile", start + 40, start + 60),
    step(chromiumName, start + 60, start + 85),
    step("Run bun run test", start + 85, 695),
    step("Post Run actions/cache@abc", 695, 699),
  ];
}

/** The `name` of each step of a workflow that uses the Chromium composite action; steps without a name are skipped. */
function namedChromiumSteps(workflow) {
  const names = [];
  let current = null;
  const flush = () => {
    if (current?.name && current.action === CHROMIUM_ACTION) {
      names.push(current.name.replace(QUOTES, "$2"));
    }
  };
  for (const line of workflow.split("\n")) {
    if (STEP_START.test(line)) {
      flush();
      current = {};
    }
    if (!current) {
      continue;
    }
    current.name ??= STEP_NAME.exec(line)?.[1];
    current.action ??= STEP_USES.exec(line)?.[1];
  }
  flush();
  return names;
}

const JOB_KEY = /^ {2}([\w-]+):\s*(?:#.*)?$/;
const STEPS_KEY = /^ {4}steps:\s*$/;
const STEP_RUN = /^(?: {6}- | {8})run:\s*(.*?)\s*$/;
const BLOCK_SCALAR = /^[|>][+-]?\d*$/;

/** The name the Actions API gives a step: its `name`, else `Run <uses>`, else `Run <first line of run>`. */
function apiStepName(raw) {
  if (raw.name) {
    return raw.name.replace(QUOTES, "$2");
  }
  if (raw.uses) {
    return `Run ${raw.uses}`;
  }
  return `Run ${raw.run}`;
}

/** The jobs of a workflow as `{ id, steps: [{ name, uses }] }`, with each step named as the API returns it. */
function workflowJobs(workflow) {
  const jobs = [];
  let current = null;
  let raw = null;
  let inSteps = false;
  let readingRun = false;
  const flush = () => {
    if (raw && current) {
      current.steps.push({ name: apiStepName(raw), uses: raw.uses });
    }
    raw = null;
  };
  for (const line of workflow.split("\n")) {
    const key = JOB_KEY.exec(line);
    if (key) {
      flush();
      current = { id: key[1], steps: [] };
      jobs.push(current);
      inSteps = false;
      continue;
    }
    if (STEPS_KEY.test(line)) {
      inSteps = true;
      continue;
    }
    if (!(inSteps && current)) {
      continue;
    }
    if (STEP_START.test(line)) {
      flush();
      raw = {};
      readingRun = false;
    }
    if (!raw) {
      continue;
    }
    if (readingRun && raw.run === undefined && line.trim() !== "") {
      raw.run = line.trim();
      readingRun = false;
    }
    raw.name ??= STEP_NAME.exec(line)?.[1];
    raw.uses ??= STEP_USES.exec(line)?.[1];
    const run = STEP_RUN.exec(line)?.[1];
    if (run !== undefined && raw.run === undefined) {
      if (BLOCK_SCALAR.test(run)) {
        readingRun = true;
      } else {
        raw.run = run;
      }
    }
  }
  flush();
  return jobs;
}

describe("percentile", () => {
  it("interpolates between ranks", () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(25);
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentile([0, 100], 95)).toBe(95);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBeNull();
  });

  it("does not depend on the order of the input", () => {
    expect(percentile([40, 10, 30, 20], 50)).toBe(25);
  });
});

describe("groupOf", () => {
  it("takes the shard suffix off the name", () => {
    expect(groupOf("Offline browser gate (shard 2/4)")).toEqual({
      group: "Offline browser gate",
      shard: "2/4",
    });
    expect(groupOf("PostgreSQL 18 gates")).toEqual({
      group: "PostgreSQL 18 gates",
    });
  });
});

describe("splitJob", () => {
  it("splits wait, preparation and execution", () => {
    const parts = splitJob(job("x", { end: 900, installEnd: 120, started: 6 }));
    expect(parts).toEqual({ execution: 780, preparation: 114, wait: 6 });
  });

  it("ends the preparation at the opening sequence, not at a later install step", () => {
    const parts = splitJob(job("x", { end: 900, installEnd: 120, started: 6 }));
    expect(parts.preparation).toBe(120 - 6);
  });

  it("counts the container step as part of the setup and a job with no install as all execution", () => {
    const withContainers = job("x", { end: 300, installEnd: 100, started: 4 });
    withContainers.steps.splice(1, 0, step("Initialize containers", 6, 20));
    expect(splitJob(withContainers).preparation).toBe(96);
    const none = {
      completed_at: at(40),
      conclusion: "success",
      created_at: at(0),
      name: "Changed areas",
      started_at: at(3),
      steps: [
        step("Set up job", 3, 4),
        step("Run node scripts/ci-changed.mjs", 4, 39),
      ],
    };
    expect(splitJob(none)).toEqual({ execution: 37, preparation: 0, wait: 3 });
  });

  it("counts the image pull, the Playwright version steps and the Chromium cache of each browser variant", () => {
    const cache = {
      completed_at: at(900),
      conclusion: "success",
      created_at: at(0),
      name: "Catalog CSP browser test",
      started_at: at(6),
      steps: [
        step("Set up job", 6, 8),
        step("Run actions/checkout@abc", 8, 16),
        step("Run actions/setup-node@abc", 16, 26),
        step("Run oven-sh/setup-bun@abc", 26, 31),
        step("Run actions/cache@abc", 31, 46),
        step("Run bun install --frozen-lockfile", 46, 60),
        step(
          'Run version=$(grep -oP \'"@playwright/test": \\["@playwright/test@\\K[0-9][0-9.]*\' bun.lock | head -n 1)',
          60,
          62
        ),
        step("Run actions/cache@abc", 62, 75),
        step("Run bunx playwright install-deps chromium", 75, 85),
        step("Run bunx playwright install --with-deps chromium", 85, 85),
        step("Run bun run test", 85, 895),
        step("Post Run actions/cache@abc", 895, 899),
      ],
    };
    expect(splitJob(cache)).toEqual({
      execution: 815,
      preparation: 79,
      wait: 6,
    });

    const image = {
      completed_at: at(400),
      conclusion: "success",
      created_at: at(0),
      name: "Lighthouse (mobile, simulated)",
      started_at: at(4),
      steps: [
        step("Set up job", 4, 6),
        step("Initialize containers", 6, 46),
        step("Run actions/checkout@abc", 46, 50),
        step("Run actions/setup-node@abc", 50, 58),
        step('Run npm install --global "bun@$(cat .bun-version)"', 58, 62),
        step("Run actions/cache@abc", 62, 70),
        step("Run bun install --frozen-lockfile", 70, 74),
        step(
          'Run test "$(bunx playwright --version)" = "Version 1.63.0" || { echo "The image tag and @playwright/test in bun.lock differ."; exit 1; }',
          74,
          76
        ),
        step("Run bun run --filter @polaris/web test:lighthouse", 76, 395),
        step("Post Run actions/cache@abc", 395, 400),
      ],
    };
    expect(splitJob(image)).toEqual({
      execution: 324,
      preparation: 72,
      wait: 4,
    });
  });

  it("counts the image pull of a container job that installs nothing", () => {
    const pullOnly = {
      completed_at: at(100),
      conclusion: "success",
      created_at: at(0),
      name: "Job with only a service container",
      started_at: at(2),
      steps: [
        step("Set up job", 2, 3),
        step("Initialize containers", 3, 25),
        step("Run bun run gates", 25, 99),
      ],
    };
    expect(splitJob(pullOnly)).toEqual({
      execution: 75,
      preparation: 23,
      wait: 2,
    });
  });

  it("ends the preparation at the Chromium step of the ci.yml, not at the test step", () => {
    const chromium = {
      completed_at: at(700),
      conclusion: "success",
      created_at: at(0),
      name: "Offline browser gate (shard 1/4)",
      started_at: at(5),
      steps: chromiumJobSteps(CHROMIUM_STEP_NAME, 5),
    };
    expect(splitJob(chromium)).toEqual({
      execution: 700 - 90,
      preparation: 90 - 5,
      wait: 5,
    });
  });

  it("counts every named Chromium step of the real ci.yml as preparation", () => {
    const text = readFileSync(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf8"
    );
    const names = namedChromiumSteps(text);
    expect(names.length).toBeGreaterThanOrEqual(4);
    for (const name of new Set(names)) {
      const parts = splitJob({
        completed_at: at(700),
        conclusion: "success",
        created_at: at(0),
        name: "Job of the ci.yml",
        started_at: at(5),
        steps: chromiumJobSteps(name, 5),
      });
      expect(
        parts.preparation,
        `o passo "${name}" do ci.yml não entra na preparação: ajuste INSTALL_STEP em ci-timing.mjs`
      ).toBe(90 - 5);
    }
  });

  it("counts every step before the Chromium step of each job of the real ci.yml as preparation, the cache restore and the conditional install included", () => {
    const text = readFileSync(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf8"
    );
    const withChromium = workflowJobs(text).filter((workflowJob) =>
      workflowJob.steps.some(
        (s) => s.uses === CHROMIUM_ACTION && s.name !== `Run ${CHROMIUM_ACTION}`
      )
    );
    expect(withChromium.length).toBeGreaterThanOrEqual(4);
    for (const workflowJob of withChromium) {
      const end = workflowJob.steps.findIndex(
        (s) => s.uses === CHROMIUM_ACTION
      );
      const names = workflowJob.steps.slice(0, end + 1).map((s) => s.name);
      const steps = [
        step("Set up job", 0, 2),
        ...names.map((name, index) =>
          step(name, 2 + index * 10, 12 + index * 10)
        ),
        step("Run bun run test", 2 + names.length * 10, 695),
      ];
      const parts = splitJob({
        completed_at: at(700),
        conclusion: "success",
        created_at: at(0),
        name: workflowJob.id,
        started_at: at(0),
        steps,
      });
      expect(
        parts.preparation,
        `o job ${workflowJob.id} do ci.yml tem passo de preparação fora de INSTALL_STEP (ajuste-o ou dê name ao passo): ${names.join(" | ")}`
      ).toBe(2 + names.length * 10);
    }
  });

  it("gives no split to a skipped job", () => {
    const skipped = {
      ...job("x", { end: 0, installEnd: 0, started: 0 }),
      conclusion: "skipped",
    };
    expect(splitJob(skipped)).toBeNull();
    expect(billedMinutes(skipped)).toBe(0);
  });
});

describe("billedMinutes and wallOf", () => {
  it("rounds each job up to the whole minute", () => {
    expect(
      billedMinutes(job("x", { end: 61 + 3, installEnd: 40, started: 3 }))
    ).toBe(2);
    expect(
      billedMinutes(job("x", { end: 60 + 3, installEnd: 40, started: 3 }))
    ).toBe(1);
  });

  it("measures from the start of the run to the end of the last job", () => {
    const jobs = [
      job("a", { end: 100, installEnd: 50, started: 3 }),
      job("b", { end: 500, installEnd: 50, started: 3 }),
    ];
    expect(wallOf({ run_started_at: at(-20) }, jobs)).toBe(520);
  });
});

describe("databaseWallOf", () => {
  const gates = (name, started, end, conclusion = "success") => ({
    ...job(name, { end, installEnd: started + 50, started }),
    conclusion,
  });

  it("is the one job's own time before the split", () => {
    expect(
      databaseWallOf([
        job("Checks", { end: 400, installEnd: 60, started: 3 }),
        gates("PostgreSQL 18 gates", 10, 310),
      ])
    ).toBe(300);
  });

  it("runs from the start of the first part to the end of the last, and leaves the collecting job out", () => {
    expect(
      databaseWallOf([
        gates("PostgreSQL 18 gates (definer-hardening)", 40, 250),
        gates("PostgreSQL 18 gates (main)", 12, 230),
        gates("PostgreSQL 18 gates", 260, 275),
      ])
    ).toBe(238);
  });

  it("leaves out a cancelled job, which has times but no result", () => {
    expect(
      databaseWallOf([
        gates("PostgreSQL 18 gates (main)", 12, 230),
        gates("PostgreSQL 18 gates (definer-hardening)", 40, 900, "cancelled"),
      ])
    ).toBe(218);
  });

  it("skips a skipped job and gives null when none ran", () => {
    expect(
      databaseWallOf([
        gates("PostgreSQL 18 gates (main)", 12, 230, "skipped"),
        gates("PostgreSQL 18 gates", 12, 230, "skipped"),
      ])
    ).toBeNull();
    expect(
      databaseWallOf([job("Checks", { end: 9, installEnd: 5, started: 1 })])
    ).toBeNull();
  });

  it("reaches the summary and the markdown", () => {
    const text = renderMarkdown({
      pull_request: summarize([
        {
          jobs: [
            gates("PostgreSQL 18 gates (main)", 12, 230),
            gates("PostgreSQL 18 gates (definer-hardening)", 40, 250),
          ],
          run: { id: 1, run_started_at: at(0) },
        },
      ]),
    });
    expect(text).toContain("Parede dos gates de PostgreSQL");
    expect(text).toContain("p50 **4,0 min**");
    expect(text).toContain("sem a espera do primeiro job");
    expect(text).toContain("subestima a parede");
    expect(text).not.toContain("sem a espera por runner");
  });

  it("is worded the same way in the runbook", () => {
    const runbook = readFileSync(
      new URL("../docs/runbooks/medir-o-ci.md", import.meta.url),
      "utf8"
    );
    expect(runbook).toContain("sem a espera do primeiro job");
    expect(runbook).toContain("subestima a parede");
    expect(runbook).not.toContain("sem a espera por runner");
  });
});

describe("summarize", () => {
  const run = (id, shardEnds, gate = true) => ({
    jobs: [
      job("Checks", { end: 200, installEnd: 60, started: 3 }),
      ...(gate
        ? shardEnds.map((end, index) =>
            job(
              `Offline browser gate (shard ${index + 1}/${shardEnds.length})`,
              {
                end,
                installEnd: 100,
                started: 3,
              }
            )
          )
        : [
            {
              ...job("Offline browser gate (shard 1/2)", {
                end: 3,
                installEnd: 3,
                started: 3,
              }),
              conclusion: "skipped",
            },
          ]),
    ],
    run: { id, run_started_at: at(0) },
  });

  const result = summarize([
    run(1, [1000, 2000]),
    run(2, [1200, 2200]),
    run(3, [], false),
  ]);

  it("groups the shards under the name without the suffix", () => {
    expect(result.jobs.map((entry) => entry.name)).toEqual([
      "Checks",
      "Offline browser gate",
    ]);
    const gate = result.jobs.find(
      (entry) => entry.name === "Offline browser gate"
    );
    expect(gate.total.n).toBe(4);
    expect(gate.shards.map((entry) => entry.shard)).toEqual(["1/2", "2/2"]);
    expect(gate.shards[0].p50).toBe(1097);
  });

  it("takes p50 and p95 of each part from every job of the group", () => {
    const gate = result.jobs.find(
      (entry) => entry.name === "Offline browser gate"
    );
    expect(gate.preparation.p50).toBe(97);
    expect(gate.execution.p50).toBe(1500);
    expect(gate.execution.p95).toBeCloseTo(
      percentile([900, 1900, 1100, 2100], 95)
    );
    expect(gate.wait.p50).toBe(3);
  });

  it("counts the minutes of every job and skips the skipped ones", () => {
    const gate = result.jobs.find(
      (entry) => entry.name === "Offline browser gate"
    );
    expect(gate.minutes).toBe(17 + 34 + 20 + 37);
    expect(result.minutesPerRun.n).toBe(3);
  });

  it("gives the wall of all runs and of those that ran the browser gate", () => {
    expect(result.wall.n).toBe(3);
    expect(result.wall.p50).toBe(2000);
    expect(result.wallWithBrowserGate.n).toBe(2);
    expect(result.wallWithBrowserGate.p50).toBe(2100);
    expect(result.runIds).toEqual([1, 2, 3]);
  });

  it("writes the markdown table", () => {
    const text = renderMarkdown({ pull_request: result });
    expect(text).toContain("### pull_request (3 execuções verdes)");
    expect(text).toContain("| Offline browser gate | 4 |");
    expect(text).toContain(
      "Só as execuções em que o gate de navegador rodou (2 de 3)"
    );
    expect(text).toContain("| 1/2 | 2 |");
  });

  it("says so when there is no green run", () => {
    expect(renderMarkdown({ workflow_dispatch: summarize([]) })).toContain(
      "Nenhuma execução verde encontrada."
    );
  });
});

const spec = (file, ...tests) => ({ file, tests, title: file });
const testOf = (projectName, ...durations) => ({
  projectName,
  results: durations.map((duration) => ({ duration })),
});

describe("sumDurations", () => {
  const report = {
    suites: [
      {
        file: "a.e2e.ts",
        specs: [spec("a.e2e.ts", testOf("chromium-desktop", 1000.4))],
        suites: [
          {
            file: "a.e2e.ts",
            specs: [
              spec(
                "a.e2e.ts",
                testOf("chromium-desktop", 500),
                testOf("chromium-mobile-emulated", 300, 400)
              ),
            ],
          },
        ],
      },
      {
        file: "b.e2e.ts",
        specs: [spec("b.e2e.ts", testOf("chromium-desktop", 50))],
      },
    ],
  };

  it("sums per file and project, retries included, sorted", () => {
    expect(sumDurations([{ name: "offline-poc", report }])).toEqual({
      entries: [
        {
          file: "a.e2e.ts",
          ms: 1500,
          project: "chromium-desktop",
          suite: "offline-poc",
          tests: 2,
        },
        {
          file: "a.e2e.ts",
          ms: 700,
          project: "chromium-mobile-emulated",
          suite: "offline-poc",
          tests: 1,
        },
        {
          file: "b.e2e.ts",
          ms: 50,
          project: "chromium-desktop",
          suite: "offline-poc",
          tests: 1,
        },
      ],
      unit: "ms",
      version: 1,
    });
  });

  it("gives a test made by a helper to the spec file of its top suite", () => {
    const helperReport = {
      suites: [
        {
          file: "x.e2e.ts",
          specs: [spec("reflow.ts", testOf("chromium-desktop", 400))],
          suites: [
            {
              file: "x.e2e.ts",
              specs: [spec("reflow.ts", testOf("chromium-desktop", 100))],
            },
          ],
        },
        {
          file: "y.e2e.ts",
          specs: [spec("reflow.ts", testOf("chromium-desktop", 30))],
        },
      ],
    };
    const { entries } = sumDurations([
      { name: "offline-poc", report: helperReport },
    ]);
    expect(entries.map((e) => [e.file, e.ms, e.tests])).toEqual([
      ["x.e2e.ts", 500, 2],
      ["y.e2e.ts", 30, 1],
    ]);
    expect(entries.every((e) => SPEC_FILE.test(e.file))).toBe(true);
  });

  it("falls back to the file of the spec when the top suite has none", () => {
    const { entries } = sumDurations([
      {
        name: "pwa",
        report: { suites: [{ specs: [spec("w.e2e.ts", testOf("p", 9))] }] },
      },
    ]);
    expect(entries.map((e) => [e.file, e.ms])).toEqual([["w.e2e.ts", 9]]);
  });

  it("adds the shards of the same suite and keeps the suites apart", () => {
    const shard = {
      suites: [
        {
          file: "a.e2e.ts",
          specs: [spec("a.e2e.ts", testOf("chromium-desktop", 10))],
        },
      ],
    };
    const { entries } = sumDurations([
      { name: "pwa", report: shard },
      { name: "pwa", report: shard },
      { name: "offline-poc", report: shard },
    ]);
    expect(entries.map((e) => [e.suite, e.ms])).toEqual([
      ["offline-poc", 10],
      ["pwa", 20],
    ]);
  });

  it("gives the same text whatever the order of the reports", () => {
    const one = {
      suites: [{ file: "z.e2e.ts", specs: [spec("z.e2e.ts", testOf("p", 5))] }],
    };
    const two = {
      suites: [{ file: "a.e2e.ts", specs: [spec("a.e2e.ts", testOf("p", 7))] }],
    };
    expect(
      JSON.stringify(
        sumDurations([
          { name: "pwa", report: one },
          { name: "pwa", report: two },
        ])
      )
    ).toBe(
      JSON.stringify(
        sumDurations([
          { name: "pwa", report: two },
          { name: "pwa", report: one },
        ])
      )
    );
  });
});

function zipOf(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, deflate } of files) {
    const nameBuffer = Buffer.from(name);
    const body = deflate ? deflateRawSync(data) : data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04_03_4b_50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02_01_4b_50, 0);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuffer, body);
    centrals.push(central, nameBuffer);
    offset += 30 + nameBuffer.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06_05_4b_50, 0);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

describe("unzip", () => {
  it("reads stored and deflated entries", () => {
    const zip = zipOf([
      { data: Buffer.from("guardado"), name: "a.json" },
      {
        data: Buffer.from("comprimido ".repeat(40)),
        deflate: true,
        name: "pasta/b.json",
      },
    ]);
    const files = unzip(zip);
    expect(files.map((f) => f.name)).toEqual(["a.json", "pasta/b.json"]);
    expect(files[0].data.toString()).toBe("guardado");
    expect(files[1].data.toString()).toBe("comprimido ".repeat(40));
  });

  it("refuses an entry that would leave the folder", () => {
    for (const name of ["../x.json", "a/../../x.json", "/etc/x.json"]) {
      const zip = zipOf([{ data: Buffer.from("{}"), name }]);
      expect(() => unzip(zip)).toThrow("path leaves the folder");
    }
  });

  it("refuses what is not a zip", () => {
    expect(() => unzip(Buffer.from("nope"))).toThrow("not a zip");
  });
});

describe("reportsFromFolder", () => {
  const folders = [];
  afterEach(() => {
    for (const folder of folders.splice(0)) {
      rmSync(folder, { force: true, recursive: true });
    }
  });

  it("finds timings-<name>.json at any depth and ignores the rest", () => {
    const folder = mkdtempSync(join(tmpdir(), "ci-timing-test-"));
    folders.push(folder);
    mkdirSync(join(folder, "shard-1"));
    writeFileSync(
      join(folder, "shard-1", "timings-pwa.json"),
      JSON.stringify({ suites: [] })
    );
    writeFileSync(
      join(folder, "timings-offline-poc.json"),
      JSON.stringify({ suites: [] })
    );
    writeFileSync(join(folder, "other.json"), "{}");
    expect(
      reportsFromFolder(folder)
        .map((r) => r.name)
        .sort()
    ).toEqual(["offline-poc", "pwa"]);
  });

  it("fails when the folder has no report", () => {
    const folder = mkdtempSync(join(tmpdir(), "ci-timing-test-"));
    folders.push(folder);
    expect(() => reportsFromFolder(folder)).toThrow("no timings-");
  });
});

const WORKFLOW_FIXTURE = `name: CI
env:
  NAME: x
jobs:
  # a comment between jobs
  checks:
    name: Checks (lint, types)
    runs-on: ubuntu-24.04
    timeout-minutes: 6
    steps:
      - name: Lint
        timeout-minutes: 99
  database:
    name: "PostgreSQL 18 gates (main)"
    timeout-minutes: 4 # 3 min at the 95th percentile
  nameless:
    runs-on: ubuntu-24.04
    timeout-minutes: 3
  shards:
    name: Browser gate (shard \${{ matrix.shard }}/\${{ needs.plan.outputs.count }})
    timeout-minutes: 21
    strategy:
      matrix:
        shard: [1, 2]
  unbudgeted:
    name: No timeout here
    runs-on: ubuntu-24.04
  dynamic:
    name: \${{ matrix.name }}
    timeout-minutes: 9
other:
  late:
    name: Not a job
    timeout-minutes: 1
`;

describe("readBudgets", () => {
  it("reads the timeout of each job under the group name the report uses", () => {
    expect([...readBudgets(WORKFLOW_FIXTURE)]).toEqual([
      ["Checks (lint, types)", 6],
      ["PostgreSQL 18 gates (main)", 4],
      ["nameless", 3],
      ["Browser gate", 21],
    ]);
  });

  it("takes the shard suffix off only when it is a shard number or an expression", () => {
    const text = [
      "jobs:",
      "  a:",
      "    name: Gate (shard coverage)",
      "    timeout-minutes: 5",
      "  b:",
      "    name: Gate (shard 2/4)",
      "    timeout-minutes: 9",
    ].join("\n");
    expect([...readBudgets(text)]).toEqual([
      ["Gate (shard coverage)", 5],
      ["Gate", 9],
    ]);
  });

  it("keeps the largest when two jobs share a group", () => {
    const text = [
      "jobs:",
      "  a:",
      "    name: Gate (shard 1/2)",
      "    timeout-minutes: 7",
      "  b:",
      "    name: Gate",
      "    timeout-minutes: 12",
    ].join("\n");
    expect(readBudgets(text).get("Gate")).toBe(12);
  });

  it("finds a budget for exactly the jobs of the real ci.yml that have a timeout", () => {
    const text = readFileSync(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf8"
    );
    const budgets = readBudgets(text);
    expect([...budgets.keys()].sort()).toEqual([
      "Catalog CSP browser test",
      "Changed areas",
      "Checks (lint, types, knip, build, tests)",
      "Chromium cache (main)",
      "Dependency audit",
      "Lighthouse (mobile, simulated)",
      "Offline browser gate",
      "Offline browser gate (plan)",
      "Offline browser gate (shard coverage)",
      "Offline persistence browser gate",
      "PostgreSQL 18 gates",
      "PostgreSQL 18 gates (definer-hardening)",
      "PostgreSQL 18 gates (main)",
      "e2e journeys on the real local stack",
    ]);
    for (const minutes of budgets.values()) {
      expect(minutes).toBeGreaterThan(0);
    }
  });

  it("keeps reading the jobs after a comment in the first column", () => {
    const text = [
      "jobs:",
      "# a comment at the margin",
      "  a:",
      "    name: A # a note",
      "    timeout-minutes: 3",
      "# another",
      "  b:",
      "    timeout-minutes: 4",
    ].join("\n");
    expect([...readBudgets(text)]).toEqual([
      ["A", 3],
      ["b", 4],
    ]);
  });
});

describe("overBudget", () => {
  const budgets = new Map([
    ["Checks", 10],
    ["Browser gate", 20],
  ]);
  const limitOfChecks = (10 * 60) / 1.3;
  const run = (id, ...jobs) => ({ jobs, run: { id } });
  const checks = (seconds) =>
    job("Checks", { end: seconds, installEnd: 60, started: 0 });
  const shard = (n, seconds) =>
    job(`Browser gate (shard ${n}/2)`, {
      end: seconds,
      installEnd: 60,
      started: 0,
    });

  it("flags a job whose p95 passed 1/1.3 of the budget in two runs or more", () => {
    const slow = Math.ceil(limitOfChecks) + 30;
    const entries = [
      run(1, checks(slow)),
      run(2, checks(slow)),
      run(3, checks(200)),
    ];
    const rows = overBudget(entries, budgets);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      n: 3,
      name: "Checks",
      slowRuns: 2,
      timeout: 10,
    });
    expect(rows[0].p95).toBeGreaterThan(limitOfChecks);
    expect(rows[0].limit).toBeCloseTo(limitOfChecks, 5);
  });

  it("does not flag a single slow run, however slow", () => {
    const entries = [
      run(1, checks(590)),
      run(2, checks(200)),
      run(3, checks(200)),
    ];
    expect(overBudget(entries, budgets)).toEqual([]);
  });

  it("does not flag a job at the limit", () => {
    const entries = [1, 2, 3].map((id) =>
      run(id, checks(Math.floor(limitOfChecks)))
    );
    expect(overBudget(entries, budgets)).toEqual([]);
  });

  it("counts a run once even when two shards of it are slow, and groups the shards", () => {
    const slow = 20 * 60;
    const one = overBudget(
      [
        run(1, shard(1, slow), shard(2, slow)),
        run(2, shard(1, 300), shard(2, 300)),
      ],
      budgets
    );
    expect(one).toEqual([]);
    const two = overBudget(
      [
        run(1, shard(1, slow), shard(2, slow)),
        run(2, shard(1, 300), shard(2, slow)),
      ],
      budgets
    );
    expect(two).toHaveLength(1);
    expect(two[0]).toMatchObject({ n: 4, name: "Browser gate", slowRuns: 2 });
  });

  it("ignores skipped jobs and jobs with no budget", () => {
    const skipped = { ...checks(590), conclusion: "skipped" };
    const unknown = job("Not in the workflow", {
      end: 3000,
      installEnd: 60,
      started: 0,
    });
    const entries = [1, 2, 3].map((id) => run(id, skipped, unknown));
    expect(overBudget(entries, budgets)).toEqual([]);
  });
});

describe("unmeasured", () => {
  it("lists the budgeted groups that never ran in the sample", () => {
    const budgets = new Map([
      ["Checks", 10],
      ["Browser gate", 20],
      ["Audit", 10],
    ]);
    const skipped = {
      ...job("Audit", { end: 30, installEnd: 20, started: 0 }),
      conclusion: "skipped",
    };
    const entries = [
      {
        jobs: [
          job("Checks", { end: 100, installEnd: 60, started: 0 }),
          job("Browser gate (shard 1/2)", {
            end: 100,
            installEnd: 60,
            started: 0,
          }),
          skipped,
        ],
        run: { id: 1 },
      },
    ];
    expect(unmeasured(entries, budgets)).toEqual(["Audit"]);
    expect(unmeasured([], budgets)).toEqual([
      "Audit",
      "Browser gate",
      "Checks",
    ]);
  });
});

describe("budget report", () => {
  const row = {
    limit: 461.5,
    n: 25,
    name: "Checks",
    p95: 540,
    slowRuns: 3,
    timeout: 10,
  };
  const clean = { over: [], unmeasured: [] };

  it("exits 1 when any event has a job over budget and 0 when none", () => {
    expect(
      budgetExitCode({ pull_request: clean, workflow_dispatch: clean })
    ).toBe(0);
    expect(
      budgetExitCode({
        pull_request: clean,
        workflow_dispatch: { over: [row], unmeasured: [] },
      })
    ).toBe(1);
  });

  it("does not turn a group with no execution into a failure, but says it", () => {
    const byEvent = {
      pull_request: { over: [], unmeasured: ["Dependency audit"] },
    };
    expect(budgetExitCode(byEvent)).toBe(0);
    expect(renderBudget(byEvent)).toContain(
      "Sem execução na amostra, portanto sem vigia neste evento: Dependency audit."
    );
  });

  it("tables the jobs over budget by event", () => {
    const text = renderBudget({
      pull_request: { over: [row], unmeasured: [] },
      workflow_dispatch: clean,
    });
    expect(text).toContain("### pull_request");
    expect(text).toContain("| Checks | 25 | 9,0 | 7,7 | 10 | 3 |");
    expect(text).toContain("Nenhum job passou de 1/1,3");
  });
});
