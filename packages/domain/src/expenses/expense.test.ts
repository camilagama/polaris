import { describe, expect, it } from "vitest";
import {
  assertExpenseCompetenceInRange,
  DEFAULT_EXPENSE_CATEGORIES,
  deriveExpenseLifecycle,
  EXPENSE_GROUP_KEYS,
  EXPENSE_GROUPS,
  ExpenseCompetenceOutOfRangeError,
  InvalidExpenseCategoryError,
  InvalidExpenseError,
  isExpenseGroupKey,
  normalizeExpense,
  normalizeExpenseCategoryName,
  transitionExpenseLifecycle,
} from "./expense";

describe("expense groups and default categories", () => {
  it("has the five fixed groups", () => {
    expect(EXPENSE_GROUPS.map((group) => group.label)).toEqual([
      "Comercial",
      "Operacional/Administrativa",
      "Financeira",
      "Impostos",
      "Outras",
    ]);
    expect(EXPENSE_GROUPS.map((group) => group.key)).toEqual([
      ...EXPENSE_GROUP_KEYS,
    ]);
    expect(isExpenseGroupKey("taxes")).toBe(true);
    expect(isExpenseGroupKey("marketing")).toBe(false);
  });

  it("starts every group with a category, with unique names and system keys", () => {
    const groups = new Set(DEFAULT_EXPENSE_CATEGORIES.map((c) => c.group));
    expect([...groups].sort()).toEqual(
      EXPENSE_GROUPS.map((group) => group.key).sort()
    );
    const names = DEFAULT_EXPENSE_CATEGORIES.map((c) => c.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    const keys = DEFAULT_EXPENSE_CATEGORIES.map((c) => c.systemKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("normalizeExpenseCategoryName", () => {
  it("trims, and refuses blank or over 100 characters", () => {
    expect(normalizeExpenseCategoryName("  Marketing  ")).toBe("Marketing");
    expect(() => normalizeExpenseCategoryName("   ")).toThrow(
      InvalidExpenseCategoryError
    );
    expect(() => normalizeExpenseCategoryName("x".repeat(101))).toThrow(
      InvalidExpenseCategoryError
    );
    expect(normalizeExpenseCategoryName("é".repeat(100))).toHaveLength(100);
  });
});

describe("normalizeExpense", () => {
  const base = {
    amount: "1500.00",
    competenceOn: "2026-10-01",
    description: "Aluguel de outubro",
  };

  it("keeps the exact amount with two decimals and trims text", () => {
    expect(
      normalizeExpense({
        ...base,
        amount: " 1500 ",
        description: "  Aluguel  ",
        payee: "  Imobiliária X ",
      })
    ).toEqual({
      amount: "1500.00",
      competenceOn: "2026-10-01",
      description: "Aluguel",
      payee: "Imobiliária X",
    });
    expect(
      normalizeExpense({ ...base, amount: "0.01", payee: "  " })
    ).toMatchObject({ amount: "0.01", payee: null });
  });

  it.each([
    ["zero", { amount: "0" }],
    ["negative", { amount: "-5.00" }],
    ["three decimals", { amount: "1.005" }],
    ["not a number", { amount: "abc" }],
    ["an exponent", { amount: "1e3" }],
    ["too many digits", { amount: "1".repeat(19) }],
    ["blank description", { description: "   " }],
    ["long description", { description: "d".repeat(201) }],
    ["long payee", { payee: "p".repeat(121) }],
    ["impossible date", { competenceOn: "2026-02-30" }],
    ["badly formatted date", { competenceOn: "01/10/2026" }],
  ])("refuses %s", (_label, override) => {
    expect(() => normalizeExpense({ ...base, ...override })).toThrow(
      InvalidExpenseError
    );
  });

  it("refuses amounts in floating point shapes instead of rounding them", () => {
    for (const amount of ["10.999", "0.001", "1,50"]) {
      expect(() => normalizeExpense({ ...base, amount })).toThrow(
        InvalidExpenseError
      );
    }
  });
});

describe("assertExpenseCompetenceInRange", () => {
  const today = "2026-10-14";

  it("accepts the past, today and up to 366 days ahead", () => {
    for (const date of ["2000-01-01", "2026-10-14", "2027-10-15"]) {
      expect(() => assertExpenseCompetenceInRange(date, today)).not.toThrow();
    }
  });

  it("refuses before 2000 and more than 366 days ahead", () => {
    for (const date of ["1999-12-31", "2027-10-16"]) {
      expect(() => assertExpenseCompetenceInRange(date, today)).toThrow(
        ExpenseCompetenceOutOfRangeError
      );
    }
  });

  it("counts the leap day", () => {
    // `2027-02-28` + 366 days = `2028-02-29` (2028 is a leap year)
    expect(() =>
      assertExpenseCompetenceInRange("2028-02-29", "2027-02-28")
    ).not.toThrow();
    expect(() =>
      assertExpenseCompetenceInRange("2028-03-01", "2027-02-28")
    ).toThrow(ExpenseCompetenceOutOfRangeError);
  });
});

describe("expense lifecycle", () => {
  const at = new Date("2026-10-14T12:00:00.000Z");

  it("voids and restores, and repeating either changes nothing", () => {
    const voided = transitionExpenseLifecycle(null, "void", at);
    expect(voided).toEqual({
      changed: true,
      lifecycle: "voided",
      voidedAt: at,
    });
    expect(transitionExpenseLifecycle(at, "void")).toEqual({
      changed: false,
      lifecycle: "voided",
      voidedAt: at,
    });
    expect(transitionExpenseLifecycle(at, "restore")).toEqual({
      changed: true,
      lifecycle: "active",
      voidedAt: null,
    });
    expect(transitionExpenseLifecycle(null, "restore")).toEqual({
      changed: false,
      lifecycle: "active",
      voidedAt: null,
    });
    expect(deriveExpenseLifecycle(at)).toBe("voided");
  });
});
