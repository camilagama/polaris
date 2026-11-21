import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkCoverage, reportsFromFolder } from "./ci-shard-coverage.mjs";

const D = "chromium-desktop";
const M = "chromium-mobile-emulated";

/**
 * A Playwright JSON report: `files` is `{ file: { project: tests } }`. With `ran`, each test has one result (as in a run;
 * a test skipped by a modifier has one too); without it, none (as in `--list`, or a test the run never reached).
 */
function report(files, { ran = false } = {}) {
  return {
    config: {
      configFile: "/r/apps/web/x.config.ts",
      rootDir: "/r/apps/web/e2e",
    },
    suites: Object.entries(files).map(([file, projects]) => ({
      file,
      specs: Object.entries(projects).map(([projectName, count]) => ({
        tests: Array.from({ length: count }, () => ({
          projectName,
          results: ran ? [{ duration: 10, status: "passed" }] : [],
        })),
      })),
    })),
  };
}

const LISTS = {
  "offline-poc": report({
    "a.e2e.ts": { [D]: 3, [M]: 3 },
    "home/b.e2e.ts": { [D]: 2, [M]: 2 },
  }),
  pwa: report({ "c.e2e.ts": { [D]: 4 }, "d.e2e.ts": { [D]: 1, [M]: 1 } }),
};

const PLAN = {
  shards: [
    {
      files: { "offline-poc": ["a.e2e.ts"], pwa: ["d.e2e.ts"] },
      estimatedMs: 1,
      shard: 1,
    },
    {
      files: { "offline-poc": ["home/b.e2e.ts"], pwa: ["c.e2e.ts"] },
      estimatedMs: 1,
      shard: 2,
    },
  ],
  testDirs: { "offline-poc": "e2e", pwa: "e2e-pwa" },
};

const greenReports = () => [
  {
    report: report({ "a.e2e.ts": { [D]: 3, [M]: 3 } }, { ran: true }),
    shard: 1,
    suite: "offline-poc",
  },
  {
    report: report({ "d.e2e.ts": { [D]: 1, [M]: 1 } }, { ran: true }),
    shard: 1,
    suite: "pwa",
  },
  {
    report: report({ "home/b.e2e.ts": { [D]: 2, [M]: 2 } }, { ran: true }),
    shard: 2,
    suite: "offline-poc",
  },
  {
    report: report({ "c.e2e.ts": { [D]: 4 } }, { ran: true }),
    shard: 2,
    suite: "pwa",
  },
];

const without = (plan, suite, file) => ({
  ...plan,
  shards: plan.shards.map((s) => ({
    ...s,
    files: {
      ...s.files,
      [suite]: (s.files[suite] ?? []).filter((f) => f !== file),
    },
  })),
});

describe("checkCoverage", () => {
  it("passes when every listed file is planned once and every listed test ran", () => {
    const result = checkCoverage({
      lists: LISTS,
      plan: PLAN,
      reports: greenReports(),
    });
    expect(result.problems).toEqual([]);
    expect(result.totals).toEqual({
      "offline-poc": { listed: 10, ran: 10, skipped: 0 },
      pwa: { listed: 6, ran: 6, skipped: 0 },
    });
  });

  it("fails a plan with one file less, naming the file (the sabotage of the guard)", () => {
    const plan = without(PLAN, "offline-poc", "home/b.e2e.ts");
    const reports = greenReports().filter(
      (r) => !(r.shard === 2 && r.suite === "offline-poc")
    );
    const { problems } = checkCoverage({ lists: LISTS, plan, reports });
    expect(problems).toContain(
      "fora do plano: offline-poc home/b.e2e.ts está no --list e em nenhum shard"
    );
    expect(problems).toContain(
      "offline-poc home/b.e2e.ts [chromium-desktop]: 2 no --list, 0 executados"
    );
    expect(problems).toContain(
      "offline-poc: 10 testes no --list, 6 executados"
    );
  });

  it("fails a planned file the list no longer has", () => {
    const plan = structuredClone(PLAN);
    plan.shards[0].files.pwa.push("apagado.e2e.ts");
    const { problems } = checkCoverage({
      lists: LISTS,
      plan,
      reports: greenReports(),
    });
    expect(problems).toEqual([
      "fora da lista: pwa apagado.e2e.ts está no plano e não no --list",
    ]);
  });

  it("fails a file planned in two shards", () => {
    const plan = structuredClone(PLAN);
    plan.shards[1].files.pwa.push("d.e2e.ts");
    const { problems } = checkCoverage({
      lists: LISTS,
      plan,
      reports: greenReports(),
    });
    expect(problems).toContain("em mais de um shard: pwa d.e2e.ts (1, 2)");
  });

  it("fails a test the run never reached, naming file, project and counts", () => {
    const reports = greenReports();
    reports[3] = {
      ...reports[3],
      report: {
        suites: [
          {
            file: "c.e2e.ts",
            specs: [
              {
                tests: [
                  ...report({ "c.e2e.ts": { [D]: 3 } }, { ran: true }).suites[0]
                    .specs[0].tests,
                  { projectName: D, results: [] },
                ],
              },
            ],
          },
        ],
      },
    };
    const { problems } = checkCoverage({ lists: LISTS, plan: PLAN, reports });
    expect(problems).toEqual([
      "pwa c.e2e.ts [chromium-desktop]: 4 no --list, 3 executados",
      "pwa: 6 testes no --list, 5 executados",
    ]);
  });

  it("fails a shard with no report for a suite it had files of", () => {
    const reports = greenReports().filter(
      (r) => !(r.shard === 1 && r.suite === "pwa")
    );
    const { problems } = checkCoverage({ lists: LISTS, plan: PLAN, reports });
    expect(problems).toContain(
      "shard 1: sem timings-pwa.json (1 arquivos planejados sem relatório)"
    );
  });

  it("fails a shard that ran a file of another shard, and the double count", () => {
    const reports = greenReports();
    reports.push({
      report: report({ "c.e2e.ts": { [D]: 4 } }, { ran: true }),
      shard: 1,
      suite: "pwa",
    });
    const { problems } = checkCoverage({ lists: LISTS, plan: PLAN, reports });
    expect(problems).toContain(
      "shard 1 rodou pwa c.e2e.ts, que o plano não pôs nele"
    );
    expect(problems).toContain(
      "pwa c.e2e.ts [chromium-desktop]: 4 no --list, 8 executados"
    );
  });

  it("fails a suite whose --list is empty, even with an empty plan and no report", () => {
    const lists = { ...LISTS, pwa: report({}) };
    const plan = without(without(PLAN, "pwa", "c.e2e.ts"), "pwa", "d.e2e.ts");
    const reports = greenReports().filter((r) => r.suite !== "pwa");
    const { problems } = checkCoverage({ lists, plan, reports });
    expect(problems).toEqual(["pwa: o --list não tem nenhum teste"]);
  });

  it("counts the skipped among the run, apart", () => {
    const reports = greenReports();
    reports[3].report.suites[0].specs[0].tests[0].results = [
      { duration: 0, status: "skipped" },
    ];
    const { problems, totals } = checkCoverage({
      lists: LISTS,
      plan: PLAN,
      reports,
    });
    expect(problems).toEqual([]);
    expect(totals.pwa).toEqual({ listed: 6, ran: 6, skipped: 1 });
  });

  it("fails a test that ran on a project the list does not have", () => {
    const reports = greenReports();
    reports[1] = {
      ...reports[1],
      report: report(
        { "d.e2e.ts": { [D]: 1, [M]: 1, "chromium-celular": 1 } },
        { ran: true }
      ),
    };
    const { problems } = checkCoverage({ lists: LISTS, plan: PLAN, reports });
    expect(problems).toContain(
      "pwa d.e2e.ts [chromium-celular]: 0 no --list, 1 executados"
    );
  });
});

describe("checkCoverage com seleção do PR", () => {
  const selection = (...specs) => ({ full: false, motivo: "m", specs });
  const repoDirs = { "offline-poc": "apps/web/e2e", pwa: "apps/web/e2e-pwa" };
  const narrowPlan = {
    shards: [
      { files: { "offline-poc": ["a.e2e.ts"] }, estimatedMs: 1, shard: 1 },
      { files: { pwa: ["d.e2e.ts"] }, estimatedMs: 1, shard: 2 },
    ],
    testDirs: PLAN.testDirs,
    repoDirs,
    selection: selection("apps/web/e2e/a.e2e.ts", "apps/web/e2e-pwa/d.e2e.ts"),
    unlisted: [],
  };
  const narrowReports = () => [
    {
      report: report({ "a.e2e.ts": { [D]: 3, [M]: 3 } }, { ran: true }),
      shard: 1,
      suite: "offline-poc",
    },
    {
      report: report({ "d.e2e.ts": { [D]: 1, [M]: 1 } }, { ran: true }),
      shard: 2,
      suite: "pwa",
    },
  ];

  it("compares with the selected files only: the others need neither plan nor run", () => {
    const result = checkCoverage({
      lists: LISTS,
      plan: narrowPlan,
      reports: narrowReports(),
    });
    expect(result.problems).toEqual([]);
    expect(result.totals).toEqual({
      "offline-poc": { listed: 6, ran: 6, skipped: 0 },
      pwa: { listed: 2, ran: 2, skipped: 0 },
    });
  });

  it("fails a selected file left out of the plan, naming it", () => {
    const plan = without(narrowPlan, "pwa", "d.e2e.ts");
    const { problems } = checkCoverage({
      lists: LISTS,
      plan,
      reports: narrowReports().filter((r) => r.suite !== "pwa"),
    });
    expect(problems).toContain(
      "fora do plano: pwa d.e2e.ts está no --list e em nenhum shard"
    );
  });

  it("fails a file planned that the selection does not ask for", () => {
    const plan = structuredClone(narrowPlan);
    plan.shards[0].files.pwa = ["c.e2e.ts"];
    const { problems } = checkCoverage({
      lists: LISTS,
      plan,
      reports: narrowReports(),
    });
    expect(problems).toContain(
      "fora da seleção: pwa c.e2e.ts está no plano e a seleção do PR não o pede"
    );
  });

  it("fails a selected file that a shard did not run", () => {
    const reports = narrowReports();
    reports[0] = {
      report: report({ "a.e2e.ts": { [D]: 3, [M]: 0 } }, { ran: true }),
      shard: 1,
      suite: "offline-poc",
    };
    const { problems } = checkCoverage({
      lists: LISTS,
      plan: narrowPlan,
      reports,
    });
    expect(problems).toContain(
      "offline-poc a.e2e.ts [chromium-mobile-emulated]: 3 no --list, 0 executados"
    );
  });

  it("fails a shard that ran a file the selection left out", () => {
    const reports = [
      ...narrowReports(),
      {
        report: report({ "c.e2e.ts": { [D]: 4 } }, { ran: true }),
        shard: 2,
        suite: "pwa",
      },
    ];
    const { problems } = checkCoverage({
      lists: LISTS,
      plan: narrowPlan,
      reports,
    });
    expect(problems).toContain(
      "shard 2 rodou pwa c.e2e.ts, que o plano não pôs nele"
    );
    expect(problems).toContain(
      "pwa c.e2e.ts [chromium-desktop]: 0 no --list, 4 executados"
    );
  });

  it("fails a selected spec of a suite folder that no list has", () => {
    const { problems } = checkCoverage({
      lists: LISTS,
      plan: { ...narrowPlan, unlisted: ["apps/web/e2e/sumiu.e2e.ts"] },
      reports: narrowReports(),
    });
    expect(problems).toContain(
      "selecionado e fora do --list: apps/web/e2e/sumiu.e2e.ts está na seleção e em nenhuma lista"
    );
  });

  it("passes an empty selection with no shard report, and still fails an empty --list", () => {
    const empty = {
      ...narrowPlan,
      shards: [{ files: {}, estimatedMs: 0, shard: 1 }],
      selection: selection(),
    };
    expect(
      checkCoverage({ lists: LISTS, plan: empty, reports: [] }).problems
    ).toEqual([]);
    expect(
      checkCoverage({
        lists: { ...LISTS, pwa: report({}) },
        plan: empty,
        reports: [],
      }).problems
    ).toContain("pwa: o --list não tem nenhum teste");
  });

  it("takes a full selection as the whole list", () => {
    const plan = {
      ...PLAN,
      selection: { full: true, motivo: "m", specs: [] },
      repoDirs,
    };
    expect(
      checkCoverage({ lists: LISTS, plan, reports: greenReports() }).problems
    ).toEqual([]);
    const { problems } = checkCoverage({
      lists: LISTS,
      plan: without(plan, "pwa", "c.e2e.ts"),
      reports: greenReports().filter(
        (r) => !(r.suite === "pwa" && r.shard === 2)
      ),
    });
    expect(problems).toContain(
      "fora do plano: pwa c.e2e.ts está no --list e em nenhum shard"
    );
  });
});

describe("reportsFromFolder", () => {
  it("is empty for a folder that does not exist (a run with no shard)", () => {
    expect(reportsFromFolder(join(tmpdir(), "t1517-nao-existe"))).toEqual([]);
  });

  let folder;
  afterEach(() => {
    if (folder) {
      rmSync(folder, { force: true, recursive: true });
    }
  });

  it("reads timings-<suite>.json of each playwright-timings-shard-<n> folder", () => {
    folder = mkdtempSync(join(tmpdir(), "shard-coverage-"));
    for (const [shard, suite] of [
      [1, "pwa"],
      [12, "offline-poc"],
    ]) {
      const dir = join(folder, `playwright-timings-shard-${shard}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `timings-${suite}.json`),
        JSON.stringify(report({}))
      );
    }
    mkdirSync(join(folder, "outra-coisa"));
    writeFileSync(join(folder, "outra-coisa", "timings-pwa.json"), "{}");
    const found = reportsFromFolder(folder)
      .map(({ shard, suite }) => ({ shard, suite }))
      .sort((a, b) => a.shard - b.shard);
    expect(found).toEqual([
      { shard: 1, suite: "pwa" },
      { shard: 12, suite: "offline-poc" },
    ]);
  });
});
