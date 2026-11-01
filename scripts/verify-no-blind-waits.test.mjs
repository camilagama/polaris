import { describe, expect, it } from "vitest";
import { BLIND_WAITS_LIST } from "./verify-no-blind-waits.list.mjs";
import {
  ADVICE,
  blindWaitProblems,
  checkRepository,
  countBlindWaits,
  isPlaywrightFile,
} from "./verify-no-blind-waits.mjs";

describe("what counts as a blind wait", () => {
  it.each([
    ["page.waitForTimeout(250);", 1],
    ["await page\n  .waitForTimeout(250);", 1],
    ["await new Promise((resolve) => setTimeout(resolve, 1000));", 1],
    ["await new Promise(r => setTimeout(r, 40));", 1],
    ["await new Promise<void>((done) => { setTimeout(done, 10); });", 1],
    ["await new Promise((r) => globalThis.setTimeout(r, 10));", 1],
    ['import { setTimeout as sleep } from "node:timers/promises";', 1],
    ['const { setTimeout } = require("node:timers/promises");', 1],
  ])("counts %s", (source, count) => {
    expect(countBlindWaits(source)).toBe(count);
  });

  it.each([
    "// page.waitForTimeout(250) would hide the race",
    "/* await new Promise((r) => setTimeout(r, 10)) */",
    "await expect.poll(() => reads).toBe(2);",
    "await page.waitForResponse('**/rpc/**');",
    "setTimeout(() => controller.abort(), 100);",
  ])("does not count %s", (source) => {
    expect(countBlindWaits(source)).toBe(0);
  });
});

describe("which files are Playwright code", () => {
  it.each([
    ["apps/web/e2e/expenses.e2e.ts", true],
    ["apps/web/e2e-pwa/ui-screens.ts", true],
    ["apps/web/e2e-real/harness/stack.ts", true],
    ["apps/catalog/e2e/csp.e2e.ts", true],
    ["apps/web/src/other.e2e.ts", true],
    ["apps/web/src/sales/sale-form-model.test.ts", false],
    ["apps/web/e2e/types.d.ts", false],
    ["apps/web/e2e/README.md", false],
  ])("%s → %s", (file, expected) => {
    expect(isPlaywrightFile(file)).toBe(expected);
  });
});

describe("the list", () => {
  const sleep = "await page.waitForTimeout(250);\n";

  it("refuses a new file with a blind wait and says what to wait for", () => {
    const problems = blindWaitProblems(
      { "apps/web/e2e/new.e2e.ts": sleep },
      {}
    );
    expect(problems).toEqual([
      `apps/web/e2e/new.e2e.ts: 1 espera(s) por tempo fixo. ${ADVICE}`,
    ]);
    expect(ADVICE).toContain("expect.poll");
    expect(ADVICE).toContain("scripts/verify-no-blind-waits.list.mjs");
  });

  it("refuses a listed file that adds one more", () => {
    expect(
      blindWaitProblems(
        { "apps/web/e2e/old.e2e.ts": sleep + sleep },
        { "apps/web/e2e/old.e2e.ts": { count: 1, reason: "r" } }
      )
    ).toHaveLength(1);
  });

  it("is exact for the repository: every entry matches the tree", () => {
    expect(checkRepository()).toEqual([]);
    expect(Object.keys(BLIND_WAITS_LIST).length).toBeGreaterThan(0);
  });
});
