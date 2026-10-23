import { describe, expect, it } from "vitest";
import {
  blankDraft,
  blankFee,
  blankRule,
  decimalInputValue,
  draftProblems,
  FIXED_RULE_TEXT,
  hasRepeatedRules,
  INSTALLMENTS_RULE_TEXT,
  NAME_ID,
  NAME_REQUIRED,
  type ProfileDraft,
  profileDraftKey,
  type RuleDraft,
  ruleFieldId,
  ruleInput,
  SETTLEMENT_RULE_TEXT,
} from "./payment-profile-draft";

const named = (name: string, ...rules: Partial<RuleDraft>[]): ProfileDraft => ({
  name,
  rules: rules.map((changes) => ({ ...blankRule(), ...changes })),
});

describe("draftProblems", () => {
  it("accepts a named profile with a Pix rule and unknown fees", () => {
    expect(draftProblems(named("Maquininha", {}))).toEqual({});
  });

  it("asks for the name, even when it is only spaces", () => {
    expect(draftProblems(named("   ", {}))).toEqual({
      [NAME_ID]: NAME_REQUIRED,
    });
  });

  it("asks for whole installments, from 1, only for the credit card", () => {
    const rule = blankRule();
    for (const text of ["", "0", "1,5", "-2", "abc", "2147483648"]) {
      expect(
        draftProblems(
          named("A", { ...rule, installments: text, method: "credit_card" })
        )
      ).toEqual({
        [ruleFieldId(rule, "installments")]: INSTALLMENTS_RULE_TEXT,
      });
    }
    expect(
      draftProblems(named("A", { installments: "12", method: "credit_card" }))
    ).toEqual({});
    // a Pix rule does not use the installments: what is left in the field is not a problem
    expect(
      draftProblems(named("A", { installments: "0", method: "pix" }))
    ).toEqual({});
  });

  it("accepts the settlement empty or in whole days, 0 included", () => {
    const rule = blankRule();
    for (const text of ["", "0", "30"]) {
      expect(
        draftProblems(named("A", { ...rule, expectedSettlementDays: text }))
      ).toEqual({});
    }
    for (const text of ["1,5", "-1", "x"]) {
      expect(
        draftProblems(named("A", { ...rule, expectedSettlementDays: text }))
      ).toEqual({ [ruleFieldId(rule, "settlement")]: SETTLEMENT_RULE_TEXT });
    }
  });

  it("asks for the fixed amount only when the fee has one, and for a number that is not negative", () => {
    const rule = blankRule();
    const fixed = (fixedAmount: string) => ({
      ...rule,
      processingFee: { ...blankFee(), fixedAmount, mode: "fixed" as const },
    });
    for (const text of ["", "  ", "x", "-0.5"]) {
      expect(draftProblems(named("A", fixed(text)))).toEqual({
        [ruleFieldId(rule, "processing-fixed")]: FIXED_RULE_TEXT,
      });
    }
    expect(draftProblems(named("A", fixed("0.50")))).toEqual({});
    // a fee that does not use the fixed amount does not look at what is left in it
    expect(
      draftProblems(
        named("A", {
          ...rule,
          anticipationFee: { ...blankFee(), fixedAmount: "x", mode: "none" },
        })
      )
    ).toEqual({});
  });

  it("limits the percentage to 0 to 100 and names it, in the order of the form", () => {
    const first = blankRule();
    const second = blankRule();
    const percentage = (text: string) => ({
      ...blankFee(),
      mode: "percentage" as const,
      percentage: text,
    });
    const problems = draftProblems(
      named(
        "",
        { ...first, processingFee: percentage("150") },
        { ...second, anticipationFee: percentage("") }
      )
    );
    expect(Object.keys(problems)).toEqual([
      NAME_ID,
      ruleFieldId(first, "processing-percentage"),
      ruleFieldId(second, "anticipation-percentage"),
    ]);
    expect(problems[ruleFieldId(first, "processing-percentage")]).toBe(
      "Informe um percentual de 0 a 100, por exemplo 2,5."
    );
  });
});

describe("ruleInput", () => {
  it("sends installments and plan only for the credit card, and the fees by their mode", () => {
    const pix = ruleInput({
      ...blankRule(),
      installments: "9",
      method: "pix",
      processingFee: {
        fixedAmount: "1.00",
        mode: "percentage",
        percentage: " 2.5 ",
      },
    });
    expect(pix).toMatchObject({
      installmentPlan: null,
      installments: null,
      processingFee: {
        fixedAmount: null,
        mode: "percentage",
        percentage: "2.5",
      },
    });
    const credit = ruleInput({
      ...blankRule(),
      expectedSettlementDays: "30",
      installmentPlan: "issuer",
      installments: "3",
      method: "credit_card",
    });
    expect(credit).toMatchObject({
      expectedSettlementDays: 30,
      installmentPlan: "issuer",
      installments: 3,
    });
  });
});

describe("hasRepeatedRules", () => {
  it("is true for the same method, and for the same installments and plan of the credit card", () => {
    expect(hasRepeatedRules(named("A", {}, {}).rules)).toBe(true);
    expect(
      hasRepeatedRules(
        named(
          "A",
          { installments: "3", method: "credit_card" },
          { installments: "03", method: "credit_card" }
        ).rules
      )
    ).toBe(true);
  });

  it("is false for another method, installments or plan", () => {
    expect(
      hasRepeatedRules(named("A", { method: "pix" }, { method: "cash" }).rules)
    ).toBe(false);
    expect(
      hasRepeatedRules(
        named(
          "A",
          { installments: "1", method: "credit_card" },
          { installments: "2", method: "credit_card" },
          {
            installmentPlan: "issuer",
            installments: "1",
            method: "credit_card",
          }
        ).rules
      )
    ).toBe(false);
  });
});

describe("profileDraftKey and decimalInputValue", () => {
  it("ignores the ids the form makes up, so a copy of the same draft is not a change", () => {
    const draft = blankDraft();
    const copy = {
      ...draft,
      rules: draft.rules.map((rule) => ({ ...rule, draftId: "other" })),
    };
    expect(profileDraftKey(copy)).toBe(profileDraftKey(draft));
    expect(profileDraftKey({ ...draft, name: "x" })).not.toBe(
      profileDraftKey(draft)
    );
  });

  it("turns the comma of the keyboard into the point, unless the text has both", () => {
    expect(decimalInputValue("2,5")).toBe("2.5");
    expect(decimalInputValue("1.000,50")).toBe("1.000,50");
  });
});
