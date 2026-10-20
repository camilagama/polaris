import { describe, expect, it } from "vitest";
import { suiteSummaryProblems } from "./workerd-suite-summary";

const report = (...statuses: string[]) =>
  JSON.stringify({
    testResults: [
      {
        assertionResults: statuses.map((status, index) => ({
          status,
          title: `test ${index}`,
        })),
      },
    ],
  });

describe("what a Workers suite run must show besides its exit code", () => {
  it("accepts the expected number of tests, all passed", () => {
    expect(
      suiteSummaryProblems(report("passed", "passed"), { tests: 2 })
    ).toEqual([]);
  });

  it("refuses a suite that ran fewer tests than the gate expects", () => {
    expect(
      suiteSummaryProblems(report("passed"), { tests: 2 }).join("\n")
    ).toContain("passed 1 tests and the gate expects 2");
  });

  it("refuses a skipped or todo test, naming it, even when the count would match", () => {
    for (const status of ["skipped", "pending", "todo", "failed"]) {
      const problems = suiteSummaryProblems(report("passed", status), {
        tests: 1,
      });
      expect(problems.join("\n"), status).toContain(`test ${status}: test 1`);
    }
  });

  it("refuses a report that is missing, empty or not JSON", () => {
    for (const text of ["", "not json", "{}"]) {
      expect(suiteSummaryProblems(text, { tests: 1 }), text).not.toEqual([]);
    }
  });
});
