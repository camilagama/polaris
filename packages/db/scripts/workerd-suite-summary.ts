/**
 * What the gates of the Workers harness ask of a Vitest run besides its exit code: that it ran as many tests as the gate
 * expects and that none was skipped or left as a todo. A green run that skipped half of the suite proves nothing.
 */
export interface SuiteExpectation {
  /** How many tests the suite has: a test added or removed changes it here, in the same change. */
  tests: number;
}

interface JsonAssertion {
  status?: string;
  title?: string;
}

interface JsonSuiteFile {
  assertionResults?: JsonAssertion[];
  name?: string;
}

/** Problems with the JSON report of `vitest --reporter=json`; empty when the run is what the gate expects. */
export function suiteSummaryProblems(
  reportText: string,
  expectation: SuiteExpectation
): string[] {
  let report: { testResults?: JsonSuiteFile[] };
  try {
    report = JSON.parse(reportText);
  } catch {
    return ["the Vitest JSON report is missing or unreadable"];
  }
  const assertions = (report.testResults ?? []).flatMap(
    (file) => file.assertionResults ?? []
  );
  const problems: string[] = [];
  const passed = assertions.filter(({ status }) => status === "passed").length;
  const notRun = assertions.filter(({ status }) => status !== "passed");
  for (const { status, title } of notRun) {
    problems.push(`test ${status ?? "without status"}: ${title ?? "?"}`);
  }
  if (passed !== expectation.tests) {
    problems.push(
      `the suite passed ${passed} tests and the gate expects ${expectation.tests}`
    );
  }
  return problems;
}
