import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  billedMinutes,
  groupOf,
  percentile,
  renderMarkdown,
  reportsFromFolder,
  splitJob,
  sumDurations,
  summarize,
  unzip,
  wallOf,
} from "./ci-timing.mjs";

const at = (offsetSeconds) =>
  new Date(Date.UTC(2026, 0, 1, 12, 0, 0) + offsetSeconds * 1000).toISOString();

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
