import { describe, expect, it } from "vitest";
import {
  CLS_EXCEPTIONS,
  CLS_LIMIT,
  CLS_SCENARIOS,
  clsProblem,
  exceptionListProblems,
  sessionWindowCls,
} from "./layout-shift.list";

const LISTED = { "/sales com-vendas frio": { reason: "a lista inline" } };

describe("the exception list of the layout shift check", () => {
  it("names only measured scenarios, each once and with a reason", () => {
    expect(exceptionListProblems()).toEqual([]);
    expect(new Set(CLS_SCENARIOS).size).toBe(CLS_SCENARIOS.length);
    expect(CLS_LIMIT).toBe(0.05);
  });

  it("fails a scenario over the limit that is not in the list, and says what to do", () => {
    const problem = clsProblem("/ com-vendas frio", 0.118, LISTED);
    expect(problem).toContain("acima do limite de 0.05");
    expect(problem).toContain("Reserve o espaço");
  });

  it("fails a listed scenario that is already under the limit, so its line goes out", () => {
    const problem = clsProblem("/sales com-vendas frio", 0.01, LISTED);
    expect(problem).toContain("Tire a entrada no mesmo PR");
  });

  it("accepts a listed scenario still over the limit and an unlisted one under it", () => {
    expect(clsProblem("/sales com-vendas frio", 0.12, LISTED)).toBeNull();
    expect(clsProblem("/ com-vendas frio", 0.05, LISTED)).toBeNull();
    expect(clsProblem("/ com-vendas frio", 0, {})).toBeNull();
  });

  it("fails an entry that names no scenario or has no reason", () => {
    expect(
      exceptionListProblems(
        {
          "/sales com-vendas frio": { reason: " " },
          "/vender frio": { reason: "nome antigo" },
        },
        CLS_SCENARIOS
      )
    ).toEqual([
      "/sales com-vendas frio: a entrada da lista precisa de um motivo.",
      "/vender frio: na lista de exceções e não é um cenário medido. Tire a entrada ou corrija o nome.",
    ]);
  });

  it("every entry of the real list is a measured scenario", () => {
    for (const scenario of Object.keys(CLS_EXCEPTIONS)) {
      expect(CLS_SCENARIOS).toContain(scenario);
    }
  });
});

describe("sessionWindowCls", () => {
  it("is the largest burst: shifts under 1 s apart add up, a pause of 1 s starts a new one", () => {
    expect(sessionWindowCls([])).toBe(0);
    expect(
      sessionWindowCls([
        { t: 100, value: 0.02 },
        { t: 900, value: 0.03 },
        { t: 2000, value: 0.04 },
      ])
    ).toBeCloseTo(0.05);
  });

  it("closes a burst after 5 s even without a pause", () => {
    const steady = Array.from({ length: 12 }, (_, index) => ({
      t: index * 500,
      value: 0.01,
    }));
    expect(sessionWindowCls(steady)).toBeCloseTo(0.1);
  });
});
