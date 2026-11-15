import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { trackTree } from "./track-tree.mjs";
import { E2E_FIXED_DATES_LIST } from "./verify-e2e-fixed-dates.list.mjs";
import {
  ADVICE,
  checkRepository,
  countFixedDates,
  e2eFixedDateProblems,
  installsFixedClock,
} from "./verify-e2e-fixed-dates.mjs";

const REPOSITORY_WALK_TIMEOUT_MS = 20_000;

const BOMB = `export const TRIAL_PLAN = {
  accessEndsAt: "2026-11-11T03:00:00.000Z",
  nextCharge: { amount: "24.90", cycleMonths: 1, on: "2026-11-10" },
};
test("shows the trial", async ({ page }) => {
  await page.route("**/rpc/billing/readPlan", (route) => route.fulfill(json(TRIAL_PLAN)));
  await page.goto("/");
});
`;

const FIXED = `const NOW = new Date("2026-11-03T15:00:00.000Z");
const DAY = 86_400_000;
export const TRIAL_PLAN = {
  accessEndsAt: new Date(NOW.getTime() + 8 * DAY).toISOString(),
  nextCharge: { amount: "24.90", cycleMonths: 1, on: "2026-11-10" },
};
test("shows the trial", async ({ page }) => {
  await page.clock.setFixedTime(NOW);
  await page.goto("/");
});
`;

describe("what counts as a fixed date", () => {
  it("counts a string or template that starts with an ISO date", () => {
    expect(
      countFixedDates(
        `const a = "2026-11-11T03:00:00.000Z";\nconst b = '2026-11-10';\nconst c = \`2026-11-09T\${h}:00\`;\n`
      )
    ).toBe(3);
  });

  it("does not count a comment, a date inside prose, a date built from parts or a regular expression", () => {
    expect(
      countFixedDates(
        [
          '// "2026-11-11" is the end',
          '/* "2026-11-11" */',
          "const prose = \"vence em '2026-11-11'\";",
          ["const parts = `$", "{year}-11-11`;"].join(""),
          'const re = /"2026-11-11/;',
          'const id = "abc-2026-11-11";',
        ].join("\n")
      )
    ).toBe(0);
  });
});

describe("what counts as a fixed clock", () => {
  it.each([
    "await page.clock.setFixedTime(NOW);",
    "await context.clock.install({ time: NOW });",
    "await page.clock.setSystemTime(NOW);",
    "await page.clock.pauseAt(NOW);",
    "vi.useFakeTimers({ now: NOW, toFake: ['Date'] });",
  ])("%s", (line) => {
    expect(installsFixedClock(line)).toBe(true);
  });

  it.each([
    "await page.clock.install();",
    "await page.clock.install({ timezone: 'UTC' });",
    "vi.useFakeTimers();",
    "vi.useFakeTimers({ toFake: ['setTimeout'] });",
  ])("%s keeps the real clock running", (line) => {
    expect(installsFixedClock(line)).toBe(false);
  });

  it("ignores a clock named in a comment or in a string", () => {
    expect(
      installsFixedClock(
        '// page.clock.setFixedTime(NOW)\nconst s = "page.clock.install()";\n'
      )
    ).toBe(false);
  });
});

describe("the rule", () => {
  it("refuses a fixed date in a test that leaves the browser clock alone, and says how to fix it", () => {
    const problems = e2eFixedDateProblems(
      { "apps/web/e2e/shell-server.ts": BOMB },
      {}
    );
    expect(problems).toEqual([
      `apps/web/e2e/shell-server.ts: 2 data(s) ISO fixa(s) em teste de navegador sem relógio fixo. ${ADVICE}`,
    ]);
    expect(ADVICE).toContain("page.clock.setFixedTime(NOW)");
    expect(ADVICE).toContain("derive as datas");
  });

  it("accepts the same fixture when the file fixes the clock and derives its dates from NOW", () => {
    expect(
      e2eFixedDateProblems({ "apps/web/e2e/shell-server.ts": FIXED }, {})
    ).toEqual([]);
  });

  it("refuses a listed file that adds one more date, and asks to lower one that lost dates", () => {
    const entry = { count: 1, reason: "r" };
    expect(
      e2eFixedDateProblems(
        { "apps/web/e2e/old.e2e.ts": BOMB },
        {
          "apps/web/e2e/old.e2e.ts": entry,
        }
      )
    ).toHaveLength(1);
    expect(
      e2eFixedDateProblems(
        { "apps/web/e2e/old.e2e.ts": 'const a = "2026-11-11";' },
        { "apps/web/e2e/old.e2e.ts": { count: 2, reason: "r" } }
      )[0]
    ).toContain("Baixe a entrada para 1");
  });

  it("asks to drop a listed file that now fixes its clock", () => {
    expect(
      e2eFixedDateProblems(
        { "apps/web/e2e/old.e2e.ts": FIXED },
        { "apps/web/e2e/old.e2e.ts": { count: 1, reason: "r" } }
      )[0]
    ).toContain("sem nenhum uso");
  });

  it("walks a planted tree: Playwright code counts, a unit test, the source and build output do not", () => {
    const base = mkdtempSync(path.join(tmpdir(), "e2e-fixed-dates-"));
    try {
      for (const file of [
        "apps/web/e2e/a.e2e.ts",
        "apps/web/e2e-pwa/helper.ts",
        "apps/web/src/a.test.ts",
        "apps/web/src/a.ts",
        "apps/web/dist/e2e/b.e2e.ts",
        "apps/web/node_modules/c.e2e.ts",
      ]) {
        mkdirSync(path.dirname(path.join(base, file)), { recursive: true });
        writeFileSync(path.join(base, file), BOMB);
      }
      mkdirSync(path.join(base, "apps/web/e2e"), { recursive: true });
      writeFileSync(path.join(base, "apps/web/e2e/ok.e2e.ts"), FIXED);
      trackTree(base);
      expect(
        checkRepository(base, {}).map((problem) => problem.split(":")[0])
      ).toEqual(["apps/web/e2e-pwa/helper.ts", "apps/web/e2e/a.e2e.ts"]);
    } finally {
      rmSync(base, { force: true, recursive: true });
    }
  });

  it(
    "is exact for the repository: every entry matches the tree",
    () => {
      expect(checkRepository()).toEqual([]);
      expect(Object.keys(E2E_FIXED_DATES_LIST).length).toBeGreaterThan(0);
    },
    REPOSITORY_WALK_TIMEOUT_MS
  );
});
