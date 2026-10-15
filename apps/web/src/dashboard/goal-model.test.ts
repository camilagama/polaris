import type { GoalReadModel } from "@polaris/contracts";
import { describe, expect, it } from "vitest";
import {
  defaultGoalPeriod,
  formatGoalDate,
  formatGoalPercent,
  formatGoalValue,
  type GoalDraft,
  goalFinalDate,
  goalKindLabel,
  goalNotStarted,
  goalPeriodText,
  goalProgressWidth,
  goalStatusClass,
  goalStatusLabel,
  goalTargetInputText,
  goalTitle,
  groupGoals,
  newGoalDraft,
  parseGoalTarget,
  validateGoalDraft,
  validateGoalEdit,
} from "./goal-model";

function goal(overrides: Partial<GoalReadModel> = {}): GoalReadModel {
  return {
    achievedValue: null,
    createdAt: "2026-10-01T12:00:00.000Z",
    endsOn: "2026-10-31",
    id: "00000000-0000-4000-8000-000000000001",
    kind: "net_sales",
    name: null,
    organizationId: "org-1",
    progress: null,
    settledAt: null,
    startsOn: "2026-10-01",
    status: "active",
    target: "1000.00",
    updatedAt: "2026-10-01T12:00:00.000Z",
    version: 1,
    ...overrides,
  };
}

function draft(overrides: Partial<GoalDraft> = {}): GoalDraft {
  return { ...newGoalDraft("2026-10"), target: "1.500,50", ...overrides };
}

describe("labels", () => {
  it("names each measure and each status", () => {
    expect(goalKindLabel("net_sales")).toBe("Vendas líquidas");
    expect(goalKindLabel("operating_result")).toBe(
      "Resultado operacional estimado"
    );
    expect(goalKindLabel("sale_count")).toBe("Número de vendas");
    expect(goalStatusLabel("active")).toBe("Em andamento");
    expect(goalStatusLabel("completed")).toBe("Concluída");
    expect(goalStatusLabel("missed")).toBe("Não atingida");
    expect(goalStatusLabel("cancelled")).toBe("Cancelada");
  });

  it("styles a status without leaning on color alone", () => {
    expect(goalStatusClass("active")).toBe("status-active");
    expect(goalStatusClass("completed")).toBe("status-active");
    expect(goalStatusClass("missed")).toBe("status-archived");
    expect(goalStatusClass("cancelled")).toBe("status-deleted");
  });

  it("titles a goal by its name, or by what it measures", () => {
    expect(goalTitle(goal({ name: "Meta de outubro" }))).toBe(
      "Meta de outubro"
    );
    expect(goalTitle(goal({ kind: "sale_count" }))).toBe("Número de vendas");
  });
});

describe("formatGoalValue", () => {
  it("formats money goals as BRL and counts as whole numbers", () => {
    expect(formatGoalValue("net_sales", "1500.50")).toBe("R$ 1.500,50");
    expect(formatGoalValue("operating_result", "-12.30")).toBe("-R$ 12,30");
    expect(formatGoalValue("sale_count", "12345")).toBe("12.345");
    expect(formatGoalValue("sale_count", "3")).toBe("3");
  });
});

describe("goalProgressWidth", () => {
  it("reads the percent text as a bar between empty and full", () => {
    expect(goalProgressWidth("0.0")).toBe(0);
    expect(goalProgressWidth("37.5")).toBe(37.5);
    expect(goalProgressWidth("100.0")).toBe(100);
    expect(goalProgressWidth("100")).toBe(100);
  });

  it("caps what went past the target", () => {
    expect(goalProgressWidth("250.7")).toBe(100);
    expect(goalProgressWidth("100.1")).toBe(100);
  });

  it("shows an empty bar for no percent, a negative one or text it cannot read", () => {
    expect(goalProgressWidth(null)).toBe(0);
    expect(goalProgressWidth("-12.5")).toBe(0);
    expect(goalProgressWidth("abc")).toBe(0);
    expect(goalProgressWidth("")).toBe(0);
  });
});

describe("formatGoalPercent", () => {
  it("writes the percent with a decimal comma", () => {
    expect(formatGoalPercent("37.5")).toBe("37,5%");
    expect(formatGoalPercent("100.0")).toBe("100,0%");
    expect(formatGoalPercent("45")).toBe("45%");
  });

  it("reads 0% for a progress that is not positive", () => {
    expect(formatGoalPercent(null)).toBe("0%");
    expect(formatGoalPercent("-3.2")).toBe("0%");
    expect(formatGoalPercent("abc")).toBe("0%");
  });
});

describe("period and dates", () => {
  it("writes the period and tells a goal that has not started", () => {
    expect(goalPeriodText(goal())).toBe("01/10/2026 a 31/10/2026");
    expect(goalNotStarted(goal({ startsOn: "2026-10-15" }), "2026-10-14")).toBe(
      true
    );
    expect(goalNotStarted(goal({ startsOn: "2026-10-14" }), "2026-10-14")).toBe(
      false
    );
  });

  it("writes the date of an instant on the organization's calendar", () => {
    const instant = "2026-10-14T01:30:00.000Z";
    expect(formatGoalDate(instant, "America/Sao_Paulo")).toBe("13/10/2026");
    expect(formatGoalDate(instant, "UTC")).toBe("14/10/2026");
    expect(formatGoalDate("not a date", "UTC")).toBe("not a date");
  });

  it("dates a final goal by when it settled, or when it was cancelled", () => {
    expect(
      goalFinalDate(
        {
          settledAt: "2026-10-20T12:00:00.000Z",
          updatedAt: "2026-10-21T12:00:00.000Z",
        },
        "UTC"
      )
    ).toBe("20/10/2026");
    expect(
      goalFinalDate(
        { settledAt: null, updatedAt: "2026-10-21T12:00:00.000Z" },
        "UTC"
      )
    ).toBe("21/10/2026");
  });

  it("starts from the month on screen", () => {
    expect(defaultGoalPeriod("2026-02")).toEqual({
      endsOn: "2026-02-28",
      startsOn: "2026-02-01",
    });
    expect(defaultGoalPeriod("nope")).toEqual({ endsOn: "", startsOn: "" });
  });
});

describe("groupGoals", () => {
  it("puts the active goals first by end date, then the final ones, latest first", () => {
    const late = goal({ endsOn: "2026-12-31", id: "a" });
    const soon = goal({ endsOn: "2026-10-31", id: "b" });
    const old = goal({
      id: "c",
      settledAt: "2026-09-30T12:00:00.000Z",
      status: "missed",
    });
    const recent = goal({
      id: "d",
      settledAt: "2026-10-10T12:00:00.000Z",
      status: "completed",
    });
    const cancelled = goal({
      id: "e",
      status: "cancelled",
      updatedAt: "2026-10-12T12:00:00.000Z",
    });
    const groups = groupGoals([old, late, recent, cancelled, soon]);
    expect(groups.active.map(({ id }) => id)).toEqual(["b", "a"]);
    expect(groups.settled.map(({ id }) => id)).toEqual(["e", "d", "c"]);
  });
});

describe("parseGoalTarget", () => {
  it("reads money the way a person types it", () => {
    expect(parseGoalTarget("net_sales", "1.500,50")).toEqual({
      ok: true,
      value: "1500.50",
    });
    expect(parseGoalTarget("operating_result", "800")).toEqual({
      ok: true,
      value: "800.00",
    });
  });

  it("refuses a money target that is empty, zero or not a number", () => {
    expect(parseGoalTarget("net_sales", "")).toEqual({
      error: "Informe o alvo da meta.",
      ok: false,
    });
    expect(parseGoalTarget("net_sales", "0")).toMatchObject({ ok: false });
    expect(parseGoalTarget("net_sales", "abc")).toMatchObject({ ok: false });
    expect(parseGoalTarget("net_sales", "10,001")).toMatchObject({ ok: false });
  });

  it("takes only whole numbers, at least one, for a count", () => {
    expect(parseGoalTarget("sale_count", " 50 ")).toEqual({
      ok: true,
      value: "50",
    });
    expect(parseGoalTarget("sale_count", "007")).toEqual({
      ok: true,
      value: "7",
    });
    for (const text of ["", "0", "1,5", "1.5", "-3", "abc", "1.000"]) {
      expect(parseGoalTarget("sale_count", text)).toMatchObject({ ok: false });
    }
    expect(parseGoalTarget("sale_count", "1000001")).toMatchObject({
      ok: false,
    });
    expect(parseGoalTarget("sale_count", "1000000")).toMatchObject({
      ok: true,
    });
  });

  it("fills the field the way a person types it", () => {
    expect(goalTargetInputText(goal({ target: "1500.50" }))).toBe("1500,50");
    expect(
      goalTargetInputText(goal({ kind: "sale_count", target: "50" }))
    ).toBe("50");
  });
});

describe("validateGoalDraft", () => {
  it("starts on the month on screen", () => {
    expect(newGoalDraft("2026-10")).toEqual({
      endsOn: "2026-10-31",
      kind: "net_sales",
      name: "",
      startsOn: "2026-10-01",
      target: "",
    });
  });

  it("builds the input for a valid goal, with the name trimmed or absent", () => {
    expect(validateGoalDraft(draft({ name: "  Meta de outubro  " }))).toEqual({
      errors: {},
      input: {
        endsOn: "2026-10-31",
        kind: "net_sales",
        name: "Meta de outubro",
        startsOn: "2026-10-01",
        target: "1500.50",
      },
    });
    expect(validateGoalDraft(draft({ name: "   " })).input?.name).toBeNull();
    expect(
      validateGoalDraft(draft({ kind: "sale_count", target: "40" })).input
    ).toMatchObject({ kind: "sale_count", target: "40" });
  });

  it("refuses a name longer than 100 characters, counted by code point", () => {
    expect(
      validateGoalDraft(draft({ name: "😀".repeat(100) })).input
    ).not.toBeNull();
    const result = validateGoalDraft(draft({ name: "😀".repeat(101) }));
    expect(result.input).toBeNull();
    expect(result.errors.name).toContain("100");
  });

  it("refuses a bad target", () => {
    const result = validateGoalDraft(draft({ target: "" }));
    expect(result.input).toBeNull();
    expect(result.errors.target).toBeDefined();
  });

  it("refuses dates that are not dates, before 2000, or reversed", () => {
    expect(
      validateGoalDraft(draft({ startsOn: "" })).errors.startsOn
    ).toBeDefined();
    expect(
      validateGoalDraft(draft({ endsOn: "2026-02-30" })).errors.endsOn
    ).toBeDefined();
    expect(
      validateGoalDraft(draft({ endsOn: "1999-12-31", startsOn: "1999-12-01" }))
        .errors.startsOn
    ).toContain("2000");
    const reversed = validateGoalDraft(
      draft({ endsOn: "2026-10-01", startsOn: "2026-10-31" })
    );
    expect(reversed.errors.endsOn).toContain("antes do início");
    expect(reversed.input).toBeNull();
  });

  it("allows a single day and 366 days, and refuses 367", () => {
    expect(
      validateGoalDraft(draft({ endsOn: "2026-10-01", startsOn: "2026-10-01" }))
        .input
    ).not.toBeNull();
    expect(
      validateGoalDraft(draft({ endsOn: "2027-12-31", startsOn: "2027-01-01" }))
        .input
    ).not.toBeNull();
    // 2028 is a leap year: 366 days
    expect(
      validateGoalDraft(draft({ endsOn: "2028-12-31", startsOn: "2028-01-01" }))
        .input
    ).not.toBeNull();
    const tooLong = validateGoalDraft(
      draft({ endsOn: "2029-01-01", startsOn: "2028-01-01" })
    );
    expect(tooLong.errors.endsOn).toContain("366");
    expect(tooLong.input).toBeNull();
  });
});

describe("validateGoalEdit", () => {
  it("checks the name and the target of an active goal", () => {
    expect(
      validateGoalEdit("net_sales", { name: " Nova ", target: "2.000" })
    ).toEqual({ errors: {}, input: { name: "Nova", target: "2000.00" } });
    expect(
      validateGoalEdit("sale_count", { name: "", target: "5" }).input
    ).toEqual({ name: null, target: "5" });
    const wrong = validateGoalEdit("sale_count", {
      name: "x".repeat(101),
      target: "1,5",
    });
    expect(wrong.input).toBeNull();
    expect(wrong.errors.name).toBeDefined();
    expect(wrong.errors.target).toBeDefined();
  });
});
