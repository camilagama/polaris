import { readFileSync, writeFileSync } from "node:fs";
import { expect, runT0, test } from "../fixtures";
import { ensureRunEnvironment } from "../run-environment";

/**
 * T0 is the same in a retry (a new worker process): the first attempt records it and fails ON PURPOSE, the retry
 * compares. Its project retries once even with E2E_RETRIES=0, and the flaky report ignores it by the annotation.
 */
// biome-ignore lint/correctness/noEmptyPattern: Playwright needs the object pattern as first argument
// biome-ignore lint/suspicious/useAwait: Playwright test bodies are async by contract
test("T0 é o mesmo no retry", async ({}, testInfo) => {
  testInfo.annotations.push({
    description: "o retry é o objeto do teste",
    type: "retry-proposital",
  });
  const file = `test-results/e2e-real/t0-${ensureRunEnvironment().runId}.txt`;
  if (testInfo.retry === 0) {
    writeFileSync(file, `${process.pid} ${runT0()}`);
    throw new Error(
      "primeira tentativa: falha de propósito para o retry conferir T0 em outro processo"
    );
  }
  const [pid, t0] = readFileSync(file, "utf8").split(" ");
  expect(Number(pid)).not.toBe(process.pid);
  expect(Number(t0)).toBe(runT0());
});
