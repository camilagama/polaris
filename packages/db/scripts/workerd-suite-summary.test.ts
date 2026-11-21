import { describe, expect, it } from "vitest";
import { runDigest, suiteSummaryProblems } from "./workerd-suite-summary";

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

describe("the digest of a Workers suite run", () => {
  const seed = ' Running tests with seed "1795222905413"';

  it("puts the shuffle seed first, before the failure lines that come earlier in the output", () => {
    const digest = runDigest(
      [" RUN v4", seed, " FAIL  a.test.ts > leaks", "AssertionError: x"],
      []
    );
    expect(digest[0]).toBe(seed);
    expect(digest).toContain(" FAIL  a.test.ts > leaks");
    expect(digest.filter((line) => line === seed)).toHaveLength(1);
  });

  it("keeps the seed when the failure lines are many and the oldest ones are cut", () => {
    const failures = Array.from({ length: 50 }, (_, index) => `FAIL ${index}`);
    const digest = runDigest([seed, ...failures], ["test failed: x"]);
    expect(digest[0]).toBe(seed);
    expect(digest).not.toContain("FAIL 0");
    expect(digest).toContain("FAIL 49");
    expect(digest.at(-1)).toBe("test failed: x");
  });

  it("has no seed line when the run did not shuffle", () => {
    expect(runDigest(["FAIL a"], [])).toEqual(["FAIL a"]);
  });
});
