import type {
  ExpenseCategoryReadModel,
  ExpenseCategoryTotalReadModel,
} from "@polaris/contracts";
import {
  EARLIEST_EXPENSE_COMPETENCE,
  MAX_EXPENSE_COMPETENCE_DAYS_AHEAD,
} from "@polaris/domain/expenses/expense";
import { describe, expect, it } from "vitest";
import { formatDate } from "@/ui/date-values";
import {
  addDays,
  categoryFieldsDiffer,
  COMPETENCE_TOO_FAR_AHEAD_MESSAGE,
  categoryShareRows,
  EARLIEST_COMPETENCE_REASON,
  EARLIEST_EXPENSE_MONTH,
  EXPENSE_GROUP_ORDER,
  type ExpenseDraft,
  expenseGroupLabel,
  formatMonthLabel,
  groupByExpenseGroup,
  isExpenseDraftChanged,
  type MoneyInputError,
  moneyInputMessage,
  moneyInputText,
  monthBounds,
  monthOfDay,
  moveMonthCursor,
  parseMoneyInput,
  percentsByLargestRemainder,
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

  it("accepts only YYYY-MM", () => {
    for (const month of ["2026-13", "2026-00", "2026-1", "", "2026-10-01"]) {
      expect(monthBounds(month)).toBeNull();
    }
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

  it("moves the cursor of the month grid by key, across years, and stays at the edge of the calendar", () => {
    expect(moveMonthCursor("2026-10", "ArrowRight")).toBe("2026-11");
    expect(moveMonthCursor("2026-12", "ArrowRight")).toBe("2027-01");
    expect(moveMonthCursor("2026-01", "ArrowLeft")).toBe("2025-12");
    expect(moveMonthCursor("2026-11", "ArrowDown")).toBe("2027-02");
    expect(moveMonthCursor("2026-02", "ArrowUp")).toBe("2025-11");
    expect(moveMonthCursor("2026-10", "PageUp")).toBe("2025-10");
    expect(moveMonthCursor("2026-10", "PageDown")).toBe("2027-10");
    expect(moveMonthCursor("2026-10", "Home")).toBe("2026-01");
    expect(moveMonthCursor("2026-10", "End")).toBe("2026-12");
    expect(moveMonthCursor("2005-03", "Home")).toBe("2005-01");
    // the first month of the grid is January 2000 (the floor of the Data de competência): it is reached, not passed
    expect(moveMonthCursor("2000-02", "ArrowLeft")).toBe("2000-01");
    expect(moveMonthCursor("2000-04", "ArrowUp")).toBe("2000-01");
    expect(moveMonthCursor("2001-01", "ArrowLeft")).toBe("2000-12");
    expect(moveMonthCursor("2001-03", "PageUp")).toBe("2000-03");
    expect(moveMonthCursor("2000-06", "Home")).toBe("2000-01");
    // the edges: the key is the grid's, so it is taken, and the cursor stays
    expect(moveMonthCursor("2000-01", "ArrowLeft")).toBe("2000-01");
    expect(moveMonthCursor("2000-03", "ArrowUp")).toBe("2000-03");
    expect(moveMonthCursor("2000-03", "PageUp")).toBe("2000-03");
    // a month the arrows beside the picker reached before 2000 stays where it is going back, and still moves forward
    expect(moveMonthCursor("1999-06", "PageUp")).toBe("1999-06");
    expect(moveMonthCursor("1999-06", "Home")).toBe("1999-06");
    expect(moveMonthCursor("1999-06", "ArrowLeft")).toBe("1999-06");
    expect(moveMonthCursor("1999-06", "ArrowRight")).toBe("1999-07");
    expect(moveMonthCursor("1999-06", "PageDown")).toBe("2000-06");
    expect(moveMonthCursor("1999-12", "End")).toBe("1999-12");
    expect(moveMonthCursor("0000-01", "ArrowLeft")).toBe("0000-01");
    // the future is free, up to the end of the calendar
    expect(moveMonthCursor("2026-10", "PageDown")).toBe("2027-10");
    expect(moveMonthCursor("9999-12", "ArrowRight")).toBe("9999-12");
    expect(moveMonthCursor("9999-11", "ArrowDown")).toBe("9999-11");
    expect(moveMonthCursor("9999-02", "PageDown")).toBe("9999-02");
    expect(EARLIEST_EXPENSE_MONTH).toBe("2000-01");
    // not a key of the grid, and not a month
    expect(moveMonthCursor("2026-10", "Enter")).toBeNull();
    expect(moveMonthCursor("x", "ArrowRight")).toBeNull();
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

  const today = "2026-11-27";

  function check(
    value: ExpenseDraft,
    saved: string | null = null
  ): ReturnType<typeof validateExpenseDraft> {
    return validateExpenseDraft(value, today, saved);
  }

  it("builds the API input from a good draft", () => {
    expect(check(draft)).toEqual({
      errors: {},
      input: {
        amount: "1500.50",
        categoryId: draft.categoryId,
        competenceOn: "2026-10-13",
        description: "Aluguel da loja",
        payee: null,
      },
    });
    expect(check({ ...draft, payee: " Imobiliária " }).input?.payee).toBe(
      "Imobiliária"
    );
  });

  it("points at every wrong field", () => {
    const result = check({
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
      check({ ...draft, competenceOn: "2026-02-30" }).errors.competenceOn
    ).toBeDefined();
    expect(
      check({ ...draft, competenceOn: "1999-12-31" }).errors.competenceOn
    ).toContain("2000");
    expect(
      check({ ...draft, competenceOn: "2000-01-01" }).input
    ).not.toBeNull();
  });

  it("limits the description to 200 characters and the payee to 120", () => {
    expect(
      check({ ...draft, description: "d".repeat(200) }).input
    ).not.toBeNull();
    expect(
      check({ ...draft, description: "d".repeat(201) }).errors.description
    ).toContain("200");
    expect(check({ ...draft, payee: "p".repeat(120) }).input).not.toBeNull();
  });

  it("takes the competence up to today plus the domain window and refuses the next day", () => {
    const last = addDays(today, MAX_EXPENSE_COMPETENCE_DAYS_AHEAD);
    expect(last).toBe("2027-11-28");
    expect(check({ ...draft, competenceOn: last }).input).not.toBeNull();
    const result = check({ ...draft, competenceOn: addDays(last, 1) });
    expect(result.input).toBeNull();
    expect(result.errors.competenceOn).toBe(COMPETENCE_TOO_FAR_AHEAD_MESSAGE);
    expect(COMPETENCE_TOO_FAR_AHEAD_MESSAGE).toBe(
      "A data de competência pode ser no máximo um ano à frente."
    );
  });

  it("counts the window from the organization's day, across a leap day", () => {
    const leap = (competenceOn: string) =>
      validateExpenseDraft({ ...draft, competenceOn }, "2027-12-31", null);
    expect(leap("2028-12-31").input).not.toBeNull();
    expect(leap("2029-01-01").errors.competenceOn).toBe(
      COMPETENCE_TOO_FAR_AHEAD_MESSAGE
    );
  });

  it("keeps the format message first and the lower limit unchanged", () => {
    expect(
      check({ ...draft, competenceOn: "2099-02-30" }).errors.competenceOn
    ).toBe("Informe uma data de competência válida.");
    expect(
      check({ ...draft, competenceOn: "1999-12-31" }).errors.competenceOn
    ).toBe("A data de competência não pode ser anterior a 2000.");
  });

  it("does not punish an edit that leaves the saved date alone", () => {
    const saved = "2028-06-15";
    expect(
      check({ ...draft, competenceOn: saved }, saved).input
    ).not.toBeNull();
    expect(
      check({ ...draft, competenceOn: "2028-06-16" }, saved).errors.competenceOn
    ).toBe(COMPETENCE_TOO_FAR_AHEAD_MESSAGE);
    expect(
      check({ ...draft, competenceOn: saved }, "2026-10-13").errors.competenceOn
    ).toBe(COMPETENCE_TOO_FAR_AHEAD_MESSAGE);
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

describe("EARLIEST_COMPETENCE_REASON", () => {
  it("diz o piso da competência a partir da constante do domínio", () => {
    expect(EARLIEST_COMPETENCE_REASON).toBe(
      `Só a partir de ${formatDate(EARLIEST_EXPENSE_COMPETENCE)}`
    );
    expect(EARLIEST_COMPETENCE_REASON).toBe("Só a partir de 01/01/2000");
  });
});

function category(index: number, name: string): ExpenseCategoryReadModel {
  return {
    archivedAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    groupKey: "other",
    id: `0199c2d0-0000-7000-8000-00000000c${String(index).padStart(3, "0")}`,
    name,
    organizationId: "org",
    status: "active",
    systemKey: null,
    updatedAt: "2026-10-01T00:00:00.000Z",
    version: 1,
  };
}

const CATEGORIES = [
  "Aluguel",
  "Embalagem",
  "Frete",
  "Imposto",
  "Marketing",
  "Software",
  "Taxas",
].map((name, index) => category(index, name));

function totalsOf(...amounts: string[]): ExpenseCategoryTotalReadModel[] {
  return amounts.map((total, index) => ({
    categoryId: (CATEGORIES[index] as ExpenseCategoryReadModel).id,
    count: 1,
    total,
  }));
}

function sumCents(amounts: string[]): string {
  const cents = amounts.reduce(
    (sum, amount) => sum + BigInt(amount.replace(".", "")),
    0n
  );
  const digits = cents.toString().padStart(3, "0");
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

describe("percentsByLargestRemainder", () => {
  it.each([
    [
      [1, 1, 1],
      [34, 33, 33],
    ],
    [
      [1, 1],
      [50, 50],
    ],
    [
      [200, 100],
      [67, 33],
    ],
    [
      [5, 995],
      [1, 99],
    ],
    [
      [0, 0],
      [0, 0],
    ],
  ])("splits %j into %j, adding up to 100", (parts, expected) => {
    const result = percentsByLargestRemainder(parts.map(BigInt));
    expect(result).toEqual(expected);
    if (parts.some((part) => part > 0)) {
      expect(result.reduce((sum, value) => sum + value, 0)).toBe(100);
    }
  });
});

describe("categoryShareRows", () => {
  it("lists the categories from the largest down, the longest bar filling the track, the shares adding up to 100", () => {
    const amounts = ["300.00", "1200.50", "99.99"];
    const rows = categoryShareRows(
      totalsOf(...amounts),
      CATEGORIES,
      sumCents(amounts)
    );
    expect(rows?.map((row) => row.name)).toEqual([
      "Embalagem",
      "Aluguel",
      "Frete",
    ]);
    expect(rows?.map((row) => row.amount)).toEqual([
      "1200.50",
      "300.00",
      "99.99",
    ]);
    expect(rows?.[0]?.width).toBe(100);
    expect(rows?.[1]?.width).toBeCloseTo(24.99, 1);
    expect(rows?.reduce((sum, row) => sum + row.percent, 0)).toBe(100);
  });

  it("keeps the five largest and adds the rest up in Outras (N), at the end, with no category to filter by", () => {
    const amounts = [
      "500.00",
      "400.00",
      "300.00",
      "200.00",
      "100.00",
      "60.00",
      "40.00",
    ];
    const rows = categoryShareRows(
      totalsOf(...amounts),
      CATEGORIES,
      sumCents(amounts)
    );
    expect(rows).toHaveLength(6);
    expect(rows?.at(-1)).toMatchObject({
      amount: "100.00",
      categoryId: null,
      name: "Outras (2)",
    });
    const sum = rows?.reduce(
      (total, row) => total + BigInt(row.amount.replace(".", "")),
      0n
    );
    expect(sum).toBe(160_000n);
  });

  it("lets Outras take the whole track when the rest is larger than any category", () => {
    const amounts = [
      "100.00",
      "90.00",
      "80.00",
      "70.00",
      "60.00",
      "50.00",
      "50.00",
    ];
    const rows = categoryShareRows(
      totalsOf(...amounts),
      CATEGORIES,
      sumCents(amounts)
    );
    expect(rows?.at(-1)?.name).toBe("Outras (2)");
    expect(rows?.at(-1)?.width).toBe(100);
    expect(rows?.[0]?.width).toBe(100);
  });

  it("breaks a tie by name", () => {
    const rows = categoryShareRows(
      totalsOf("100.00", "100.00"),
      CATEGORIES,
      "200.00"
    );
    expect(rows?.map((row) => row.name)).toEqual(["Aluguel", "Embalagem"]);
  });

  it("writes the ids this screen does not know as one Sem categoria", () => {
    const rows = categoryShareRows(
      [
        ...totalsOf("100.00"),
        {
          categoryId: "0199c2d0-0000-7000-8000-0000000000f1",
          count: 1,
          total: "30.00",
        },
        {
          categoryId: "0199c2d0-0000-7000-8000-0000000000f2",
          count: 1,
          total: "20.00",
        },
      ],
      CATEGORIES,
      "150.00"
    );
    expect(rows?.at(-1)).toMatchObject({
      amount: "50.00",
      categoryId: null,
      name: "Sem categoria",
    });
  });

  it("writes the name the server sent for a category this screen has not read yet, never Sem categoria", () => {
    const rows = categoryShareRows(
      [
        ...totalsOf("100.00"),
        {
          categoryId: "0199c2d0-0000-7000-8000-0000000000f1",
          categoryName: "Brindes",
          count: 1,
          total: "30.00",
        },
        {
          categoryArchived: true,
          categoryId: "0199c2d0-0000-7000-8000-0000000000f2",
          categoryName: "Feira",
          count: 1,
          total: "20.00",
        },
      ],
      CATEGORIES,
      "150.00"
    );
    expect(rows?.map((row) => [row.name, row.categoryId])).toEqual([
      ["Aluguel", CATEGORIES[0]?.id],
      ["Brindes", null],
      ["Feira (arquivada)", null],
    ]);
    expect(rows?.map((row) => row.name)).not.toContain("Sem categoria");
  });

  it("writes the name the server sent for a category renamed elsewhere and keeps its filter", () => {
    const rows = categoryShareRows(
      [
        {
          categoryId: CATEGORIES[0]?.id as string,
          categoryName: "Nome do servidor",
          count: 1,
          total: "100.00",
        },
        {
          categoryId: "0199c2d0-0000-7000-8000-0000000000f1",
          categoryName: "Brindes",
          count: 1,
          total: "30.00",
        },
      ],
      CATEGORIES,
      "130.00"
    );
    expect(rows?.[0]).toMatchObject({
      categoryId: CATEGORIES[0]?.id,
      name: "Nome do servidor",
    });
    expect(rows?.map((row) => row.name)).not.toContain("Aluguel");
  });

  it("falls back to the local name when the server sent none", () => {
    const rows = categoryShareRows(
      [
        {
          categoryId: CATEGORIES[0]?.id as string,
          count: 1,
          total: "100.00",
        },
        {
          categoryId: CATEGORIES[1]?.id as string,
          count: 1,
          total: "30.00",
        },
      ],
      CATEGORIES,
      "130.00"
    );
    expect(rows?.[0]).toMatchObject({
      categoryId: CATEGORIES[0]?.id,
      name: "Aluguel",
    });
  });

  it("marks a renamed category archived by the server flag, or by the local status when the flag is absent", () => {
    const archived = CATEGORIES.map((item, index) =>
      index === 1 ? { ...item, status: "archived" as const } : item
    );
    const rows = categoryShareRows(
      [
        {
          categoryArchived: true,
          categoryId: CATEGORIES[0]?.id as string,
          categoryName: "Novo A",
          count: 1,
          total: "100.00",
        },
        {
          categoryId: CATEGORIES[1]?.id as string,
          categoryName: "Novo B",
          count: 1,
          total: "30.00",
        },
      ],
      archived,
      "130.00"
    );
    expect(rows?.map((row) => row.name)).toEqual([
      "Novo A (arquivada)",
      "Novo B (arquivada)",
    ]);
  });

  it.each([
    ["an answer with no split", undefined, "100.00"],
    ["a single category", totalsOf("100.00"), "100.00"],
    [
      "lines that do not add up to the total",
      totalsOf("100.00", "50.00"),
      "150.01",
    ],
    ["an amount that is not a decimal", totalsOf("100.00", "abc"), "100.00"],
  ])("leaves the block out for %s", (_name, totals, total) => {
    expect(categoryShareRows(totals, CATEGORIES, total)).toBeNull();
  });

  it("stays exact with sums that do not fit a float", () => {
    const amounts = ["999999999999999999.99", "999999999999999999.99"];
    const rows = categoryShareRows(
      totalsOf(...amounts),
      CATEGORIES,
      sumCents(amounts)
    );
    expect(rows?.map((row) => row.percent)).toEqual([50, 50]);
    expect(rows?.[0]?.amount).toBe("999999999999999999.99");
  });
});

describe("categoryFieldsDiffer", () => {
  const aluguel = CATEGORIES[0] as ExpenseCategoryReadModel;

  function entry(
    categoryId: string,
    categoryName?: string,
    categoryArchived?: boolean
  ): ExpenseCategoryTotalReadModel {
    return {
      categoryId,
      count: 1,
      total: "10.00",
      ...(categoryName === undefined ? {} : { categoryName }),
      ...(categoryArchived === undefined ? {} : { categoryArchived }),
    };
  }

  it("is false when the names are the same", () => {
    expect(
      categoryFieldsDiffer([entry(aluguel.id, aluguel.name)], CATEGORIES)
    ).toBe(false);
  });

  it("is true when the server name of a category read here is another", () => {
    expect(
      categoryFieldsDiffer([entry(aluguel.id, "Aluguel do galpão")], CATEGORIES)
    ).toBe(true);
  });

  it("is true when the server archived flag of a category read here is another", () => {
    expect(
      categoryFieldsDiffer(
        [entry(aluguel.id, aluguel.name, true)],
        [{ ...aluguel, status: "active" }]
      )
    ).toBe(true);
    expect(
      categoryFieldsDiffer(
        [entry(aluguel.id, aluguel.name, false)],
        [{ ...aluguel, status: "archived" }]
      )
    ).toBe(true);
  });

  it("is false when the archived flag agrees or the server sent none", () => {
    expect(
      categoryFieldsDiffer(
        [entry(aluguel.id, aluguel.name, true)],
        [{ ...aluguel, status: "archived" }]
      )
    ).toBe(false);
    expect(
      categoryFieldsDiffer(
        [entry(aluguel.id, aluguel.name, false)],
        [{ ...aluguel, status: "active" }]
      )
    ).toBe(false);
    expect(
      categoryFieldsDiffer(
        [entry(aluguel.id, aluguel.name)],
        [{ ...aluguel, status: "archived" }]
      )
    ).toBe(false);
  });

  it("is false for a category this screen has not read", () => {
    expect(
      categoryFieldsDiffer(
        [entry("00000000-0000-4000-8000-00000000ffff", "Outro nome")],
        CATEGORIES
      )
    ).toBe(false);
  });

  it("is false when the server sent no name, or no split", () => {
    expect(categoryFieldsDiffer([entry(aluguel.id)], CATEGORIES)).toBe(false);
    expect(categoryFieldsDiffer(undefined, CATEGORIES)).toBe(false);
  });
});
