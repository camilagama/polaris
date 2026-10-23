import type { PaymentProfileReadModel } from "@polaris/contracts";
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
  profileDraft,
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

describe("ruleInput, settlement", () => {
  it("sends no settlement for an empty or blank field, and the days otherwise", () => {
    for (const text of ["", "  "]) {
      expect(
        ruleInput({ ...blankRule(), expectedSettlementDays: text })
          .expectedSettlementDays
      ).toBeNull();
    }
    expect(
      ruleInput({ ...blankRule(), expectedSettlementDays: " 0 " })
        .expectedSettlementDays
    ).toBe(0);
  });
});

describe("the fixed amount of a fee", () => {
  const saved: PaymentProfileReadModel = {
    archivedAt: null,
    createdAt: "2026-10-01T12:00:00.000Z",
    id: "0199c2d0-0000-7000-8000-0000000000c1",
    name: "Maquininha",
    organizationId: "0199c2d0-0000-7000-8000-00000000a001",
    rules: [
      {
        anticipationFee: { fixedAmount: null, mode: "none", percentage: null },
        expectedSettlementDays: 1,
        id: "rule-1",
        installmentPlan: null,
        installments: null,
        method: "pix",
        processingFee: {
          fixedAmount: "0.50",
          mode: "fixed",
          percentage: null,
        },
      },
    ],
    status: "active",
    updatedAt: "2026-10-01T12:00:00.000Z",
    version: 1,
  };

  it("fills the field with the comma when a saved profile is edited, and sends the point back", () => {
    const draft = profileDraft(saved);
    const [rule] = draft.rules;
    expect(rule?.processingFee.fixedAmount).toBe("0,50");
    expect(rule && ruleInput(rule).processingFee.fixedAmount).toBe("0.50");
  });

  it("accepts what the person types with the comma, and sends it with the point", () => {
    const rule = blankRule();
    const typed = {
      ...rule,
      processingFee: {
        ...blankFee(),
        fixedAmount: "1,5",
        mode: "fixed" as const,
      },
    };
    expect(draftProblems(named("A", typed))).toEqual({});
    expect(ruleInput(typed).processingFee.fixedAmount).toBe("1.5");
  });

  it("does not take the thousands separator as the comma", () => {
    const rule = blankRule();
    const typed = {
      ...rule,
      processingFee: {
        ...blankFee(),
        fixedAmount: "1.500,50",
        mode: "fixed" as const,
      },
    };
    expect(draftProblems(named("A", typed))).toEqual({
      [ruleFieldId(rule, "processing-fixed")]: FIXED_RULE_TEXT,
    });
  });

  it("does not count an unedited profile as changed, and counts the fixed amount typed again with another value", () => {
    // the screen warns about unsent work by comparing the draft with the one the edit started from
    const base = profileDraftKey(profileDraft(saved));
    const typed = (fixedAmount: string) => {
      const draft = profileDraft(saved);
      const [rule] = draft.rules;
      if (rule) {
        rule.processingFee = { ...rule.processingFee, fixedAmount };
      }
      return profileDraftKey(draft);
    };
    // the same value typed by the person, with the comma, is what the field already showed
    expect(typed("0,50")).toBe(base);
    expect(typed("0,5")).not.toBe(base);
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
