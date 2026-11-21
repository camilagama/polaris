import { describe, expect, it } from "vitest";
import {
  filtersOf,
  median,
  parseArgs,
  planShards,
  renderPlan,
  testDirOf,
  testsOfReport,
  weighFiles,
} from "./ci-shard-plan.mjs";

/** A `--list` report: `files` is `{ file: { project: tests } }`; the tests have no results, as in `--list`. */
function listReport(files, { workers = 1, testDir = "e2e" } = {}) {
  return {
    config: {
      configFile: "/repo/apps/web/playwright.x.config.ts",
      rootDir: `/repo/apps/web/${testDir}`,
      workers,
    },
    suites: Object.entries(files).map(([file, projects]) => ({
      file,
      specs: [],
      suites: [
        {
          specs: Object.entries(projects).map(([projectName, count]) => ({
            tests: Array.from({ length: count }, () => ({
              projectName,
              results: [],
            })),
          })),
        },
      ],
    })),
  };
}

const durations = (entries) => ({
  entries: entries.map(([suite, file, project, ms]) => ({
    file,
    ms,
    project,
    suite,
    tests: 1,
  })),
  unit: "ms",
  version: 1,
});

const D = "chromium-desktop";
const M = "chromium-mobile-emulated";

describe("testsOfReport", () => {
  it("gives each test the file of its top suite and its project", () => {
    const tests = testsOfReport(listReport({ "a.e2e.ts": { [D]: 2, [M]: 1 } }));
    expect(tests).toEqual([
      { file: "a.e2e.ts", project: D, ran: false, skipped: false },
      { file: "a.e2e.ts", project: D, ran: false, skipped: false },
      { file: "a.e2e.ts", project: M, ran: false, skipped: false },
    ]);
  });
});

describe("weighFiles", () => {
  it("sums the times of the projects a file is listed for and divides by the workers of its suite", () => {
    const files = weighFiles(
      durations([
        ["pwa", "a.e2e.ts", D, 600],
        ["pwa", "a.e2e.ts", M, 300],
        ["pwa", "a.e2e.ts", "chromium-celular", 5000],
      ]),
      { pwa: listReport({ "a.e2e.ts": { [D]: 1, [M]: 1 } }, { workers: 3 }) }
    );
    expect(files).toEqual([
      {
        file: "a.e2e.ts",
        ms: 900,
        suite: "pwa",
        timed: true,
        weight: 300,
        workers: 3,
      },
    ]);
  });

  it("gives a listed file without a time the median of the timed files", () => {
    const files = weighFiles(
      durations([
        ["pwa", "a.e2e.ts", D, 100],
        ["pwa", "b.e2e.ts", D, 300],
        ["pwa", "c.e2e.ts", D, 900],
      ]),
      {
        pwa: listReport({
          "a.e2e.ts": { [D]: 1 },
          "b.e2e.ts": { [D]: 1 },
          "c.e2e.ts": { [D]: 1 },
          "novo.e2e.ts": { [D]: 4 },
        }),
      }
    );
    expect(files.find((f) => f.file === "novo.e2e.ts")).toMatchObject({
      ms: 300,
      timed: false,
    });
  });

  it("leaves out a timed file the list no longer has", () => {
    const files = weighFiles(
      durations([
        ["pwa", "a.e2e.ts", D, 100],
        ["pwa", "apagado.e2e.ts", D, 99_999],
        ["offline-poc", "a.e2e.ts", D, 7],
      ]),
      { pwa: listReport({ "a.e2e.ts": { [D]: 1 } }) }
    );
    expect(files.map((f) => `${f.suite}:${f.file}`)).toEqual(["pwa:a.e2e.ts"]);
  });

  it("takes the workers from the override before the list", () => {
    const [file] = weighFiles(
      durations([["pwa", "a.e2e.ts", D, 800]]),
      { pwa: listReport({ "a.e2e.ts": { [D]: 1 } }, { workers: 2 }) },
      { pwa: 4 }
    );
    expect(file.weight).toBe(200);
  });
});

describe("median", () => {
  it("is the middle value, or the mean of the two middle ones", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

const weighed = (suite, name, weight) => ({
  file: name,
  ms: weight,
  suite,
  timed: true,
  weight,
  workers: 1,
});

describe("planShards", () => {
  it("hands out the heaviest file first to the lightest shard (LPT)", () => {
    const plan = planShards(
      [
        weighed("pwa", "a", 7),
        weighed("pwa", "b", 6),
        weighed("pwa", "c", 5),
        weighed("pwa", "d", 4),
        weighed("pwa", "e", 3),
        weighed("pwa", "f", 2),
      ],
      3
    );
    expect(plan.shards).toEqual([
      { files: { pwa: ["a", "f"] }, estimatedMs: 9, shard: 1 },
      { files: { pwa: ["b", "e"] }, estimatedMs: 9, shard: 2 },
      { files: { pwa: ["c", "d"] }, estimatedMs: 9, shard: 3 },
    ]);
  });

  it("spreads files of no weight by count instead of piling them on shard 1", () => {
    const plan = planShards(
      ["a", "b", "c", "d"].map((name) => weighed("pwa", name, 0)),
      2
    );
    expect(plan.shards.map((s) => s.files.pwa)).toEqual([
      ["a", "c"],
      ["b", "d"],
    ]);
  });

  it("is the same whatever the order of the input", () => {
    const files = [
      weighed("pwa", "a", 5),
      weighed("offline-poc", "a", 5),
      weighed("pwa", "b", 3),
      weighed("offline-poc", "c", 1),
      weighed("pwa", "d", 1),
    ];
    expect(planShards([...files].reverse(), 2)).toEqual(planShards(files, 2));
  });

  it("puts every file in exactly one shard", () => {
    const files = Array.from({ length: 37 }, (_, i) =>
      weighed(i % 2 ? "pwa" : "offline-poc", `f${i}.e2e.ts`, (i * 7919) % 101)
    );
    const plan = planShards(files, 4);
    const planned = plan.shards.flatMap((s) =>
      Object.entries(s.files).flatMap(([suite, list]) =>
        list.map((name) => `${suite}:${name}`)
      )
    );
    expect(planned).toHaveLength(files.length);
    expect(new Set(planned)).toEqual(
      new Set(files.map((f) => `${f.suite}:${f.file}`))
    );
  });

  it("lists the files that got the median", () => {
    const plan = planShards(
      [weighed("pwa", "a", 2), { ...weighed("pwa", "novo", 2), timed: false }],
      1
    );
    expect(plan.untimed).toEqual([{ file: "novo", suite: "pwa" }]);
  });

  it("refuses a number of shards that is not a whole number from 1 up", () => {
    expect(() => planShards([], 0)).toThrow("whole number");
    expect(() => planShards([], Number.NaN)).toThrow("whole number");
  });
});

describe("filtersOf", () => {
  const plan = {
    shards: [
      {
        files: { pwa: ["home.e2e.ts", "ui-guardrails/telas-01.e2e.ts"] },
        shard: 1,
      },
    ],
    testDirs: { pwa: "e2e-pwa" },
  };

  it("anchors each file at the test folder and at the end, with the dots escaped", () => {
    expect(filtersOf(plan, 1, "pwa")).toEqual([
      "//e2e-pwa/home\\.e2e\\.ts$/",
      "//e2e-pwa/ui-guardrails/telas-01\\.e2e\\.ts$/",
    ]);
  });

  it("matches the file and not one whose name ends the same", () => {
    const [filter] = filtersOf(plan, 1, "pwa");
    const regex = new RegExp(filter.slice(1, -1));
    expect(regex.test("/repo/apps/web/e2e-pwa/home.e2e.ts")).toBe(true);
    expect(regex.test("/repo/apps/web/e2e-pwa/dashboard-home.e2e.ts")).toBe(
      false
    );
    expect(regex.test("/repo/apps/web/e2e-pwa/sub/home.e2e.ts")).toBe(false);
    expect(regex.test("/repo/apps/web/e2e-pwa/homeXe2e.ts")).toBe(false);
  });

  it("gives nothing for a suite with no file in the shard, and refuses an unknown shard", () => {
    expect(
      filtersOf({ ...plan, testDirs: { ...plan.testDirs, x: "e2e" } }, 1, "x")
    ).toEqual([]);
    expect(() => filtersOf(plan, 2, "pwa")).toThrow("no shard 2");
  });
});

describe("testDirOf", () => {
  it("is the test folder relative to the config file", () => {
    expect(testDirOf(listReport({}, { testDir: "e2e-pwa" }))).toBe("e2e-pwa");
  });
});

describe("renderPlan", () => {
  it("shows the spread between the slowest and the fastest shard against the median", () => {
    const text = renderPlan({
      shards: [
        { files: { pwa: ["a"] }, estimatedMs: 600_000, shard: 1 },
        { files: { pwa: ["b", "c"] }, estimatedMs: 660_000, shard: 2 },
      ],
      untimed: [],
    });
    expect(text).toContain("| 2 | 2 | 11,0 |");
    expect(text).toContain("1,0 min, 9,5% da mediana (10,5 min)");
  });
});

describe("parseArgs", () => {
  it("reads lists, workers and the filter form", () => {
    expect(
      parseArgs(["--shards", "4", "--list", "pwa=x.json", "--workers", "pwa=4"])
    ).toMatchObject({ lists: ["pwa=x.json"], shards: 4, workers: { pwa: 4 } });
    expect(() => parseArgs(["--nada"])).toThrow("unknown argument");
  });
});
