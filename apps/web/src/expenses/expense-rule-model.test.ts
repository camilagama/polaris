import { describe, expect, it } from "vitest";
import {
  newRuleDraft,
  type RuleDraft,
  ruleFrequencyLabel,
  validateRuleDraft,
} from "./expense-rule-model";

const TODAY = "2026-10-14";
const CATEGORY = "0199c2d0-0000-7000-8000-000000000001";

function draft(overrides: Partial<RuleDraft> = {}): RuleDraft {
  return {
    ...newRuleDraft(TODAY),
    amount: "1.500,50",
    categoryId: CATEGORY,
    description: "  Aluguel  ",
    ...overrides,
  };
}

describe("ruleFrequencyLabel", () => {
  it("names each frequency in Portuguese", () => {
    expect(ruleFrequencyLabel("weekly")).toBe("Toda semana");
    expect(ruleFrequencyLabel("monthly")).toBe("Todo mês");
    expect(ruleFrequencyLabel("yearly")).toBe("Todo ano");
  });
});

describe("validateRuleDraft", () => {
  it("starts a new rule today, monthly, with no end", () => {
    expect(newRuleDraft(TODAY)).toMatchObject({
      endsOn: "",
      frequency: "monthly",
      startsOn: TODAY,
    });
  });

  it("returns the exact input for a valid draft", () => {
    const result = validateRuleDraft(draft({ payee: " Imobiliária " }), {
      fixedStart: false,
      today: TODAY,
    });
    expect(result.errors).toEqual({});
    expect(result.input).toEqual({
      amount: "1500.50",
      categoryId: CATEGORY,
      description: "Aluguel",
      endsOn: null,
      frequency: "monthly",
      payee: "Imobiliária",
      startsOn: TODAY,
    });
  });

  it("reports the amount, category and description next to their fields", () => {
    const result = validateRuleDraft(
      draft({ amount: "10,505", categoryId: "", description: " " }),
      { fixedStart: false, today: TODAY }
    );
    expect(result.input).toBeNull();
    expect(Object.keys(result.errors).sort()).toEqual([
      "amount",
      "categoryId",
      "description",
    ]);
  });

  it("refuses an end date before the start", () => {
    const result = validateRuleDraft(
      draft({ endsOn: "2026-10-13", startsOn: TODAY }),
      { fixedStart: false, today: TODAY }
    );
    expect(result.errors.endsOn).toBeDefined();
    expect(result.input).toBeNull();
  });

  it("accepts an end date equal to the start", () => {
    const result = validateRuleDraft(draft({ endsOn: TODAY }), {
      fixedStart: false,
      today: TODAY,
    });
    expect(result.input?.endsOn).toBe(TODAY);
  });

  it("keeps the start date inside the window a new rule may use", () => {
    const options = { fixedStart: false, today: TODAY };
    expect(
      validateRuleDraft(draft({ startsOn: "1999-12-31" }), options).errors
        .startsOn
    ).toBeDefined();
    expect(
      validateRuleDraft(draft({ startsOn: "2027-10-16" }), options).errors
        .startsOn
    ).toBeDefined();
    expect(
      validateRuleDraft(draft({ startsOn: "2027-10-15" }), options).errors
        .startsOn
    ).toBeUndefined();
    expect(
      validateRuleDraft(draft({ startsOn: "2026-02-30" }), options).errors
        .startsOn
    ).toBeDefined();
  });

  it("does not re-check the stored start date when editing", () => {
    const result = validateRuleDraft(draft({ startsOn: "2001-01-31" }), {
      fixedStart: true,
      today: TODAY,
    });
    expect(result.errors.startsOn).toBeUndefined();
    expect(result.input).not.toBeNull();
  });

  it("counts code points, not UTF-16 units, in the text limits", () => {
    const result = validateRuleDraft(
      draft({ description: "😀".repeat(200), payee: "😀".repeat(120) }),
      { fixedStart: false, today: TODAY }
    );
    expect(result.errors.description).toBeUndefined();
    expect(result.errors.payee).toBeUndefined();
    const tooLong = validateRuleDraft(
      draft({ description: "a".repeat(201), payee: "b".repeat(121) }),
      { fixedStart: false, today: TODAY }
    );
    expect(tooLong.errors.description).toBeDefined();
    expect(tooLong.errors.payee).toBeDefined();
  });
});
