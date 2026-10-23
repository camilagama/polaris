import type {
  PaymentFeeConfigurationReadModel,
  PaymentProfileReadModel,
  PaymentProfileRuleInput,
} from "@polaris/contracts";
import { percentageFieldText, percentageProblem } from "./payment-fee-model";

/* The form of a payment profile as the person fills it: text in every field, converted to the contract only when
   the profile is saved. Pure functions, so what the form accepts is tested without a screen. */

export type FeeMode = PaymentFeeConfigurationReadModel["mode"];
export type Method = PaymentProfileRuleInput["method"];

export interface FeeDraft {
  fixedAmount: string;
  mode: FeeMode;
  percentage: string;
}
export interface RuleDraft {
  anticipationFee: FeeDraft;
  draftId: string;
  expectedSettlementDays: string;
  installmentPlan: "merchant" | "issuer";
  installments: string;
  method: Method;
  processingFee: FeeDraft;
}
export interface ProfileDraft {
  name: string;
  rules: RuleDraft[];
}

export const NAME_ID = "payment-profile-name";
export const NAME_REQUIRED = "Informe o nome do perfil.";
export const FIXED_RULE_TEXT = "Informe o valor fixo, por exemplo 0,50.";
export const INSTALLMENTS_RULE_TEXT =
  "Informe o número de parcelas: 1 ou mais, sem vírgula.";
export const SETTLEMENT_RULE_TEXT =
  "Informe os dias de prazo: 0 ou mais, sem vírgula. Ou deixe em branco.";
const MAX_INTEGER = 2_147_483_647;
const INTEGER_TEXT = /^\d+$/;

export const blankFee = (): FeeDraft => ({
  fixedAmount: "",
  mode: "unknown",
  percentage: "",
});
export const blankRule = (): RuleDraft => ({
  anticipationFee: blankFee(),
  draftId: crypto.randomUUID(),
  expectedSettlementDays: "",
  installmentPlan: "merchant",
  installments: "1",
  method: "pix",
  processingFee: blankFee(),
});
export const blankDraft = (): ProfileDraft => ({
  name: "",
  rules: [blankRule()],
});

export const hasFixed = (fee: FeeDraft) =>
  fee.mode === "fixed" || fee.mode === "fixed_and_percentage";
export const hasPercentage = (fee: FeeDraft) =>
  fee.mode === "percentage" || fee.mode === "fixed_and_percentage";

/** The keyboard types a comma; the server wants a point (unless the text has both, which is left to be refused). */
export function decimalInputValue(value: string): string {
  if (value.includes(",") && value.includes(".")) {
    return value;
  }
  return value.replace(",", ".");
}

function feeDraft(fee: PaymentFeeConfigurationReadModel): FeeDraft {
  return {
    fixedAmount: fee.fixedAmount ?? "",
    mode: fee.mode,
    percentage: percentageFieldText(fee.percentage),
  };
}

export function profileDraft(profile: PaymentProfileReadModel): ProfileDraft {
  return {
    name: profile.name,
    rules: profile.rules.map((rule) => ({
      anticipationFee: feeDraft(rule.anticipationFee),
      draftId: crypto.randomUUID(),
      expectedSettlementDays: rule.expectedSettlementDays?.toString() ?? "",
      installmentPlan: rule.installmentPlan ?? "merchant",
      installments: rule.installments?.toString() ?? "1",
      method: rule.method,
      processingFee: feeDraft(rule.processingFee),
    })),
  };
}

/** The draft without the ids the form makes up for its rows, to tell whether it was changed. */
export function profileDraftKey(draft: ProfileDraft): string {
  return JSON.stringify({
    name: draft.name,
    rules: draft.rules.map(({ draftId: _draftId, ...rule }) => rule),
  });
}

function feeInput(fee: FeeDraft): PaymentFeeConfigurationReadModel {
  return {
    fixedAmount:
      hasFixed(fee) && fee.fixedAmount.trim() ? fee.fixedAmount.trim() : null,
    mode: fee.mode,
    percentage:
      hasPercentage(fee) && fee.percentage.trim()
        ? fee.percentage.trim()
        : null,
  };
}

export function ruleInput(rule: RuleDraft): PaymentProfileRuleInput {
  const credit = rule.method === "credit_card";
  const days = rule.expectedSettlementDays.trim();
  return {
    anticipationFee: feeInput(rule.anticipationFee),
    expectedSettlementDays: days === "" ? null : Number(days),
    installmentPlan: credit ? rule.installmentPlan : null,
    installments: credit ? Number(rule.installments) : null,
    method: rule.method,
    processingFee: feeInput(rule.processingFee),
  };
}

export const ruleFieldId = (rule: RuleDraft, part: string) =>
  `payment-rule-${rule.draftId}-${part}`;

function wholeNumberProblem(text: string, minimum: number): boolean {
  const value = text.trim();
  return !(
    INTEGER_TEXT.test(value) &&
    Number(value) >= minimum &&
    Number(value) <= MAX_INTEGER
  );
}

function fixedProblem(text: string): boolean {
  const value = text.trim();
  return value === "" || !Number.isFinite(Number(value)) || Number(value) < 0;
}

function feeProblems(
  rule: RuleDraft,
  part: "processing" | "anticipation",
  fee: FeeDraft
): Record<string, string> {
  const problems: Record<string, string> = {};
  if (hasFixed(fee) && fixedProblem(fee.fixedAmount)) {
    problems[ruleFieldId(rule, `${part}-fixed`)] = FIXED_RULE_TEXT;
  }
  const percentage = hasPercentage(fee)
    ? percentageProblem(fee.percentage)
    : null;
  if (percentage) {
    problems[ruleFieldId(rule, `${part}-percentage`)] = percentage;
  }
  return problems;
}

/**
 * What cannot be saved, by the id of the field, in the order of the form (the first one takes the focus). Nothing
 * of this goes to the server: the field says what is wrong and what is accepted (U-29), and what was typed stays.
 */
export function draftProblems(draft: ProfileDraft): Record<string, string> {
  const problems: Record<string, string> = {};
  if (draft.name.trim() === "") {
    problems[NAME_ID] = NAME_REQUIRED;
  }
  for (const rule of draft.rules) {
    if (
      rule.method === "credit_card" &&
      wholeNumberProblem(rule.installments, 1)
    ) {
      problems[ruleFieldId(rule, "installments")] = INSTALLMENTS_RULE_TEXT;
    }
    const days = rule.expectedSettlementDays.trim();
    if (days !== "" && wholeNumberProblem(days, 0)) {
      problems[ruleFieldId(rule, "settlement")] = SETTLEMENT_RULE_TEXT;
    }
    Object.assign(
      problems,
      feeProblems(rule, "processing", rule.processingFee),
      feeProblems(rule, "anticipation", rule.anticipationFee)
    );
  }
  return problems;
}

/** Two rules for the same method and the same installments cannot both be in a profile. */
export function hasRepeatedRules(rules: RuleDraft[]): boolean {
  const keys = rules.map((rule) => {
    const credit = rule.method === "credit_card";
    return [
      rule.method,
      credit ? rule.installmentPlan : "",
      credit ? String(Number(rule.installments)) : "",
    ].join("|");
  });
  return new Set(keys).size !== keys.length;
}
