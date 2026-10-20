import { describe, expect, it } from "vitest";
import { flakyReport, summary } from "./e2e-flaky-report.mjs";

const result = (status, message) => ({ error: message ? { message } : undefined, status });
const spec = (file, title, projectName, status, extra = {}) => ({
  file,
  tests: [
    {
      projectName,
      results: status === "flaky" ? [result("failed", "Error: boom\n at x"), result("passed")] : [result("passed")],
      status,
      ...extra,
    },
  ],
  title,
});
const report = (...specs) => ({ suites: [{ file: "x", specs, suites: [] }] });

describe("the flaky report of the e2e journeys", () => {
  it("passes with no flaky test and with one outside the money journeys", () => {
    expect(flakyReport(report(spec("jornadas/cliente.e2e.ts", "cliente", "online", "expected"))).failed).toBe(false);
    const one = flakyReport(report(spec("jornadas/cliente.e2e.ts", "cliente", "online", "flaky")));
    expect(one.failed).toBe(false);
    expect(one.flaky).toEqual([
      { error: "Error: boom", file: "jornadas/cliente.e2e.ts", money: false, project: "online", title: "cliente" },
    ]);
    expect(summary(one)).toContain("| jornadas/cliente.e2e.ts | online | cliente | Error: boom |");
  });

  it("fails with two flaky tests", () => {
    const two = flakyReport(
      report(
        spec("jornadas/cliente.e2e.ts", "cliente", "online", "flaky"),
        spec("jornadas/despesa.e2e.ts", "despesa", "online", "flaky")
      )
    );
    expect(two.failed).toBe(true);
    expect(summary(two)).toContain("**Reprovado:** 2 tests passed only on the retry");
  });

  it("fails with one flaky money journey (sale, return/cancellation, stock)", () => {
    for (const file of ["jornadas/venda.e2e.ts", "jornadas/devolucao.e2e.ts", "jornadas/estoque.e2e.ts"]) {
      expect(flakyReport(report(spec(file, "x", "runtime-ligado", "flaky"))).failed, file).toBe(true);
    }
  });

  it("ignores the test whose retry is on purpose", () => {
    const purposeful = spec("harness/relogio-retry.e2e.ts", "T0", "relogio-retry", "flaky", {
      annotations: [{ type: "retry-proposital" }],
    });
    const other = spec("jornadas/cliente.e2e.ts", "cliente", "online", "flaky");
    const verdict = flakyReport(report(purposeful, other));
    expect(verdict.flaky).toHaveLength(1);
    expect(verdict.failed).toBe(false);
  });

  it("reads nested suites", () => {
    const nested = { suites: [{ file: "jornadas/venda.e2e.ts", specs: [], suites: [{ specs: [spec(undefined, "venda", "online", "flaky")] }] }] };
    expect(flakyReport(nested).flaky[0]).toMatchObject({ file: "jornadas/venda.e2e.ts", money: true });
  });
});
