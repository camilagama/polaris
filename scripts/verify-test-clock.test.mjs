import { describe, expect, it } from "vitest";
import { TEST_CLOCK_LIST } from "./verify-test-clock.list.mjs";
import {
  ADVICE,
  checkRepository,
  isTestFile,
  OWN_RULE_FOLDER,
  testClockProblems,
} from "./verify-test-clock.mjs";

describe("which files are tests", () => {
  it.each([
    ["apps/web/src/expenses/expenses-model.test.ts", true],
    ["apps/web/src/ui/date-picker.test.tsx", true],
    ["scripts/test-datas.test.mjs", true],
    ["apps/web/e2e/expenses.e2e.ts", true],
    ["apps/web/src/expenses/expenses-model.ts", false],
    ["apps/web/e2e-pwa/ui-history-states.ts", false],
  ])("%s → %s", (file, expected) => {
    expect(isTestFile(file)).toBe(expected);
  });

  it("leaves the gates to their own rule, and only them", () => {
    expect(OWN_RULE_FOLDER).toBe("packages/db/scripts/");
    expect(isTestFile("packages/db/scripts/gate-loose-clock.test.ts")).toBe(
      false
    );
    expect(isTestFile("packages/db/src/sale-repository.test.ts")).toBe(true);
  });
});

describe("the list", () => {
  it("refuses a new test that reads the wall clock and says how to fix the clock", () => {
    const problems = testClockProblems(
      {
        "apps/web/src/new.test.ts":
          "const today = new Date();\nconst at = Date.now();\n",
      },
      {}
    );
    expect(problems).toEqual([
      `apps/web/src/new.test.ts: 2 leitura(s) do relógio real (Date.now() ou new Date() sem argumento). ${ADVICE}`,
    ]);
    expect(ADVICE).toContain("vi.useFakeTimers");
    expect(ADVICE).toContain("performance.now()");
  });

  it("does not count a date derived from a fixed instant, a comment or a string", () => {
    expect(
      testClockProblems(
        {
          "apps/web/src/fixed.test.ts":
            'const NOW = new Date("2026-10-31T02:59:00Z");\n// Date.now() is not read\nconst s = "new Date()";\nperformance.now();\n',
        },
        {}
      )
    ).toEqual([]);
  });

  it("refuses a listed test that adds one more read", () => {
    expect(
      testClockProblems(
        { "apps/web/src/old.test.ts": "Date.now(); Date.now();" },
        { "apps/web/src/old.test.ts": { count: 1, reason: "r" } }
      )
    ).toHaveLength(1);
  });

  it("is exact for the repository: every entry matches the tree", () => {
    expect(checkRepository()).toEqual([]);
    expect(Object.keys(TEST_CLOCK_LIST).length).toBeGreaterThan(0);
  });
});
