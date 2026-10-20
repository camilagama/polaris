import { describe, expect, it } from "vitest";
import {
  EXPENSE_GROUP_ORDER,
  type ExpenseDraft,
  expenseGroupLabel,
  formatMonthLabel,
  groupByExpenseGroup,
  isExpenseDraftChanged,
  isMonthValue,
  type MoneyInputError,
  monthBounds,
  monthOfDay,
  moneyInputMessage,
  moneyInputText,
  parseMoneyInput,
  shiftMonth,
  validateExpenseDraft,
} from "./expense-model";

function accepted(raw: string): string | null {
  const result = parseMoneyInput(raw);
  return result.ok ? result.value : null;
}

function refusal(raw: string): MoneyInputError | null {
  const result = parseMoneyInput(raw);
  return result.ok ? null : result.error;
}

describe("parseMoneyInput", () => {
  it("accepts the ways people type an amount", () => {
    expect(accepted("1500")).toBe("1500.00");
    expect(accepted("1.500,50")).toBe("1500.50");
    expect(accepted("1500,5")).toBe("1500.50");
    expect(accepted("1500.50")).toBe("1500.50");
    expect(accepted("1,500.50")).toBe("1500.50");
    expect(accepted("0,99")).toBe("0.99");
    expect(accepted(",5")).toBe("0.50");
    expect(accepted("0.05")).toBe("0.05");
    expect(accepted("  12,30  ")).toBe("12.30");
    expect(accepted("R$ 1.500,50")).toBe("1500.50");
    expect(accepted("r$1500")).toBe("1500.00");
  });

  it("reads one dot and three digits as thousands, like pt-BR", () => {
    expect(accepted("1.500")).toBe("1500.00");
    expect(accepted("12.345")).toBe("12345.00");
    expect(accepted("10.999")).toBe("10999.00");
    expect(accepted("1.234.567")).toBe("1234567.00");
    expect(accepted("1.5")).toBe("1.50");
    expect(accepted("1.55")).toBe("1.55");
  });

  it("drops leading zeros and pads to two decimals", () => {
    expect(accepted("007")).toBe("7.00");
    expect(accepted("0001500,1")).toBe("1500.10");
  });

  it("keeps exact digits for large amounts, without floating point", () => {
    expect(accepted("123456789012,99")).toBe("123456789012.99");
    expect(accepted("0,07")).toBe("0.07");
    expect(refusal("9007199254740993,00")).toBe("too_large");
  });

  it("refuses empty input", () => {
    expect(refusal("")).toBe("empty");
    expect(refusal("   ")).toBe("empty");
    expect(refusal("R$")).toBe("empty");
  });

  it("refuses negative amounts", () => {
    expect(refusal("-10")).toBe("negative");
    expect(refusal("-0,50")).toBe("negative");
    expect(refusal("−10")).toBe("negative");
  });

  it("refuses zero", () => {
    expect(refusal("0")).toBe("not_positive");
    expect(refusal("0,00")).toBe("not_positive");
    expect(refusal("000.0")).toBe("not_positive");
  });

  it("refuses more than two decimals", () => {
    expect(refusal("10,123")).toBe("too_many_decimals");
    expect(refusal("10.1234")).toBe("too_many_decimals");
  });

  it("refuses a comma with three digits after it, which is a decimal mark", () => {
    expect(refusal("1,500")).toBe("too_many_decimals");
    expect(refusal("0.500")).toBe("too_many_decimals");
  });

  it("refuses text that is not an amount", () => {
    for (const raw of [
      "abc",
      "10 reais",
      "1 500",
      "1e3",
      "+10",
      "1,5,0",
      "1.500.00",
      "1.5,5",
      "1500,",
      "1500.",
      ",",
      ".",
      "1..5",
      "R$ R$ 1",
      "10%",
    ]) {
      expect(refusal(raw)).toBe("invalid");
    }
  });

  it("refuses an amount beyond the screen's limit", () => {
    expect(refusal("1234567890123")).toBe("too_large");
  });

  it("gives every refusal a message in Portuguese", () => {
    const errors: MoneyInputError[] = [
      "empty",
      "invalid",
      "negative",
      "not_positive",
      "too_large",
      "too_many_decimals",
    ];
    const messages = errors.map(moneyInputMessage);
    expect(new Set(messages).size).toBe(errors.length);
    expect(moneyInputMessage("too_many_decimals")).toContain("duas casas");
  });
});

describe("moneyInputText", () => {
  it("shows an exact decimal with a decimal comma, and it parses back", () => {
    expect(moneyInputText("1500.50")).toBe("1500,50");
    expect(accepted(moneyInputText("1500.50"))).toBe("1500.50");
  });
});

describe("months", () => {
  it("recognizes only YYYY-MM", () => {
    expect(isMonthValue("2026-10")).toBe(true);
    expect(isMonthValue("2026-13")).toBe(false);
    expect(isMonthValue("2026-00")).toBe(false);
    expect(isMonthValue("2026-1")).toBe(false);
    expect(isMonthValue("")).toBe(false);
    expect(isMonthValue("2026-10-01")).toBe(false);
  });

  it("takes the month of a calendar day", () => {
    expect(monthOfDay("2026-10-13")).toBe("2026-10");
  });

  it("finds the first and last day of a month", () => {
    expect(monthBounds("2026-10")).toEqual({
      from: "2026-10-01",
      to: "2026-10-31",
    });
    expect(monthBounds("2026-04")).toEqual({
      from: "2026-04-01",
      to: "2026-04-30",
    });
    expect(monthBounds("2026-02")?.to).toBe("2026-02-28");
    expect(monthBounds("2028-02")?.to).toBe("2028-02-29");
    expect(monthBounds("2100-02")?.to).toBe("2100-02-28");
    expect(monthBounds("2000-02")?.to).toBe("2000-02-29");
    expect(monthBounds("2026-12")?.to).toBe("2026-12-31");
    expect(monthBounds("nope")).toBeNull();
  });

  it("moves to the previous and next month across years", () => {
    expect(shiftMonth("2026-10", 1)).toBe("2026-11");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-03", -14)).toBe("2025-01");
    expect(shiftMonth("2026-10", 0)).toBe("2026-10");
    expect(shiftMonth("x", 1)).toBeNull();
    expect(shiftMonth("9999-12", 1)).toBeNull();
    expect(shiftMonth("0000-01", -1)).toBeNull();
  });

  it("writes the month in Portuguese", () => {
    expect(formatMonthLabel("2026-10")).toBe("outubro de 2026");
    expect(formatMonthLabel("2026-03")).toBe("março de 2026");
    expect(formatMonthLabel("bad")).toBe("bad");
  });
});

describe("groups", () => {
  it("lists the five groups in the fixed order", () => {
    expect(EXPENSE_GROUP_ORDER.map((group) => group.key)).toEqual([
      "commercial",
      "operational",
      "financial",
      "taxes",
      "other",
    ]);
    expect(EXPENSE_GROUP_ORDER.map((group) => group.label)).toEqual([
      "Comercial",
      "Operacional/Administrativa",
      "Financeira",
      "Impostos",
      "Outras",
    ]);
    expect(expenseGroupLabel("taxes")).toBe("Impostos");
  });

  it("groups items by group order, keeps item order, and skips empty groups", () => {
    const items = [
      { group: "other", name: "a" },
      { group: "commercial", name: "b" },
      { group: "other", name: "c" },
      { group: "taxes", name: "d" },
      { group: "commercial", name: "e" },
    ] as const;
    const sections = groupByExpenseGroup(items, (item) => item.group);
    expect(sections.map((section) => section.key)).toEqual([
      "commercial",
      "taxes",
      "other",
    ]);
    expect(
      sections.map((section) => section.items.map((item) => item.name))
    ).toEqual([["b", "e"], ["d"], ["a", "c"]]);
    expect(sections[0]?.label).toBe("Comercial");
    expect(groupByExpenseGroup([], () => "other")).toEqual([]);
  });
});

describe("validateExpenseDraft", () => {
  const draft: ExpenseDraft = {
    amount: "1.500,5",
    categoryId: "0198e0a0-0000-7000-8000-000000000001",
    competenceOn: "2026-10-13",
    description: "  Aluguel da loja ",
    payee: "  ",
  };

  it("builds the API input from a good draft", () => {
    expect(validateExpenseDraft(draft)).toEqual({
      errors: {},
      input: {
        amount: "1500.50",
        categoryId: draft.categoryId,
        competenceOn: "2026-10-13",
        description: "Aluguel da loja",
        payee: null,
      },
    });
    expect(
      validateExpenseDraft({ ...draft, payee: " Imobiliária " }).input?.payee
    ).toBe("Imobiliária");
  });

  it("points at every wrong field", () => {
    const result = validateExpenseDraft({
      amount: "abc",
      categoryId: "",
      competenceOn: "",
      description: "   ",
      payee: "x".repeat(121),
    });
    expect(result.input).toBeNull();
    expect(Object.keys(result.errors).sort()).toEqual([
      "amount",
      "categoryId",
      "competenceOn",
      "description",
      "payee",
    ]);
  });

  it("refuses an impossible or too old competence date", () => {
    expect(
      validateExpenseDraft({ ...draft, competenceOn: "2026-02-30" }).errors
        .competenceOn
    ).toBeDefined();
    expect(
      validateExpenseDraft({ ...draft, competenceOn: "1999-12-31" }).errors
        .competenceOn
    ).toContain("2000");
    expect(
      validateExpenseDraft({ ...draft, competenceOn: "2000-01-01" }).input
    ).not.toBeNull();
  });

  it("limits the description to 200 characters and the payee to 120", () => {
    expect(
      validateExpenseDraft({ ...draft, description: "d".repeat(200) }).input
    ).not.toBeNull();
    expect(
      validateExpenseDraft({ ...draft, description: "d".repeat(201) }).errors
        .description
    ).toContain("200");
    expect(
      validateExpenseDraft({ ...draft, payee: "p".repeat(120) }).input
    ).not.toBeNull();
  });
});

describe("isExpenseDraftChanged (the sign that the session notice warns about)", () => {
  const initial: ExpenseDraft = {
    amount: "",
    categoryId: "",
    competenceOn: "2026-10-19",
    description: "",
    payee: "",
  };

  it("does not count a form that still has its starting values, today's date included", () => {
    expect(isExpenseDraftChanged({ ...initial }, initial)).toBe(false);
  });

  it("counts a typed or picked field, and not one put back", () => {
    expect(
      isExpenseDraftChanged({ ...initial, amount: "12,00" }, initial)
    ).toBe(true);
    expect(
      isExpenseDraftChanged({ ...initial, categoryId: "category-1" }, initial)
    ).toBe(true);
    expect(isExpenseDraftChanged({ ...initial, payee: "" }, initial)).toBe(
      false
    );
  });

  it("compares an edit with the expense it opened, not with an empty form", () => {
    const opened = { ...initial, amount: "12,00", description: "Aluguel" };
    expect(isExpenseDraftChanged({ ...opened }, opened)).toBe(false);
    expect(isExpenseDraftChanged({ ...opened, amount: "13,00" }, opened)).toBe(
      true
    );
  });
});
