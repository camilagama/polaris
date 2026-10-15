import type { ExpenseRuleReadModel } from "@polaris/contracts";
import {
  EARLIEST_EXPENSE_COMPETENCE,
  MAX_EXPENSE_COMPETENCE_DAYS_AHEAD,
  MAX_EXPENSE_DESCRIPTION_LENGTH,
  MAX_EXPENSE_PAYEE_LENGTH,
} from "@polaris/domain/expenses/expense";
import { isCalendarDate } from "../lib/dates";
import { moneyInputMessage, parseMoneyInput } from "./expense-model";

/**
 * Pure helpers of the recurring expense rules: what a person types to create
 * or change a rule, and how a rule is described on screen.
 */

export type RuleFrequency = ExpenseRuleReadModel["frequency"];

export const RULE_FREQUENCIES: ReadonlyArray<{
  key: RuleFrequency;
  label: string;
}> = [
  { key: "weekly", label: "Toda semana" },
  { key: "monthly", label: "Todo mês" },
  { key: "yearly", label: "Todo ano" },
];

export function isRuleFrequency(value: string): value is RuleFrequency {
  return RULE_FREQUENCIES.some((item) => item.key === value);
}

export function ruleFrequencyLabel(frequency: RuleFrequency): string {
  return (
    RULE_FREQUENCIES.find((item) => item.key === frequency)?.label ?? frequency
  );
}

export interface RuleDraft {
  amount: string;
  categoryId: string;
  description: string;
  /** Empty for a rule with no end date. */
  endsOn: string;
  frequency: RuleFrequency;
  payee: string;
  startsOn: string;
}

export type RuleDraftField = keyof RuleDraft;
export type RuleDraftErrors = Partial<
  Record<RuleDraftField, string | undefined>
>;

/** What the API takes to change a rule (frequency and start date are fixed). */
interface RuleTemplateInput {
  amount: string;
  categoryId: string;
  description: string;
  endsOn: string | null;
  payee: string | null;
}

/** What the API takes to create a rule. */
export interface RuleCreateInput extends RuleTemplateInput {
  frequency: RuleFrequency;
  startsOn: string;
}

/** Fields in the order they appear on the form, to focus the first wrong one. */
export const RULE_DRAFT_FIELDS: readonly RuleDraftField[] = [
  "amount",
  "categoryId",
  "frequency",
  "startsOn",
  "endsOn",
  "description",
  "payee",
];

export function newRuleDraft(today: string): RuleDraft {
  return {
    amount: "",
    categoryId: "",
    description: "",
    endsOn: "",
    frequency: "monthly",
    payee: "",
    startsOn: today,
  };
}

function addDays(day: string, days: number): string {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date + days))
    .toISOString()
    .slice(0, 10);
}

function startsOnError(startsOn: string, today: string): string | null {
  if (!isCalendarDate(startsOn)) {
    return "Informe uma data de início válida.";
  }
  if (startsOn < EARLIEST_EXPENSE_COMPETENCE) {
    return "A data de início não pode ser anterior a 2000.";
  }
  if (startsOn > addDays(today, MAX_EXPENSE_COMPETENCE_DAYS_AHEAD)) {
    return "A data de início pode ser no máximo um ano à frente.";
  }
  return null;
}

function endsOnError(
  endsOn: string,
  startsOn: string,
  startIsValid: boolean
): string | null {
  if (endsOn === "") {
    return null;
  }
  if (!isCalendarDate(endsOn)) {
    return "Informe uma data de término válida ou deixe em branco.";
  }
  if (startIsValid && endsOn < startsOn) {
    return "O término não pode ser antes do início.";
  }
  return null;
}

function textErrors(draft: RuleDraft): RuleDraftErrors {
  const errors: RuleDraftErrors = {};
  const description = draft.description.trim();
  if (description === "") {
    errors.description = "Descreva a despesa recorrente.";
  } else if ([...description].length > MAX_EXPENSE_DESCRIPTION_LENGTH) {
    errors.description = `Use no máximo ${MAX_EXPENSE_DESCRIPTION_LENGTH} caracteres.`;
  }
  if ([...draft.payee.trim()].length > MAX_EXPENSE_PAYEE_LENGTH) {
    errors.payee = `Use no máximo ${MAX_EXPENSE_PAYEE_LENGTH} caracteres.`;
  }
  return errors;
}

export interface RuleValidation {
  errors: RuleDraftErrors;
  /** Set only when nothing is wrong. */
  input: RuleCreateInput | null;
}

/**
 * Checks a draft the way the server will, so mistakes show next to the field
 * before anything is sent. When `fixedStart` is true (editing), the start date
 * is the stored one and is not checked against the creation window.
 */
export function validateRuleDraft(
  draft: RuleDraft,
  options: { fixedStart: boolean; today: string }
): RuleValidation {
  const errors: RuleDraftErrors = textErrors(draft);
  const amount = parseMoneyInput(draft.amount);
  if (!amount.ok) {
    errors.amount = moneyInputMessage(amount.error);
  }
  if (draft.categoryId === "") {
    errors.categoryId = "Escolha uma categoria.";
  }
  const startError = options.fixedStart
    ? null
    : startsOnError(draft.startsOn, options.today);
  if (startError) {
    errors.startsOn = startError;
  }
  const endError = endsOnError(
    draft.endsOn,
    draft.startsOn,
    startError === null
  );
  if (endError) {
    errors.endsOn = endError;
  }
  if (!amount.ok || Object.keys(errors).length > 0) {
    return { errors, input: null };
  }
  const payee = draft.payee.trim();
  return {
    errors,
    input: {
      amount: amount.value,
      categoryId: draft.categoryId,
      description: draft.description.trim(),
      endsOn: draft.endsOn === "" ? null : draft.endsOn,
      frequency: draft.frequency,
      payee: payee === "" ? null : payee,
      startsOn: draft.startsOn,
    },
  };
}
