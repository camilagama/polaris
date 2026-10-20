import type {
  ExpenseCategoryReadModel,
  ExpenseReadModel,
} from "@polaris/contracts";
import {
  EARLIEST_EXPENSE_COMPETENCE,
  MAX_EXPENSE_DESCRIPTION_LENGTH,
  MAX_EXPENSE_PAYEE_LENGTH,
} from "@polaris/domain/expenses/expense";
import { isCalendarDate } from "../lib/dates";
import { isDraftChanged } from "../lib/unsent-work";

/**
 * Pure helpers of the expenses screen: money typed by a person, calendar
 * months and the five fixed expense groups. Money is only ever text or BigInt
 * here, never a floating point number.
 */

export type ExpenseGroupKey = ExpenseReadModel["categoryGroup"];

/** The five fixed groups, in the order the screen shows them. */
export const EXPENSE_GROUP_ORDER: ReadonlyArray<{
  key: ExpenseGroupKey;
  label: string;
}> = [
  { key: "commercial", label: "Comercial" },
  { key: "operational", label: "Operacional/Administrativa" },
  { key: "financial", label: "Financeira" },
  { key: "taxes", label: "Impostos" },
  { key: "other", label: "Outras" },
];

export function expenseGroupLabel(key: ExpenseGroupKey): string {
  return EXPENSE_GROUP_ORDER.find((group) => group.key === key)?.label ?? key;
}

export interface ExpenseGroupSection<T> {
  items: T[];
  key: ExpenseGroupKey;
  label: string;
}

/**
 * Splits items by group, in the fixed group order. Groups with no item are
 * left out, and the order of the items inside a group is kept.
 */
export function groupByExpenseGroup<T>(
  items: readonly T[],
  groupOf: (item: T) => ExpenseGroupKey
): ExpenseGroupSection<T>[] {
  const sections: ExpenseGroupSection<T>[] = [];
  for (const group of EXPENSE_GROUP_ORDER) {
    const inGroup = items.filter((item) => groupOf(item) === group.key);
    if (inGroup.length > 0) {
      sections.push({ items: inGroup, key: group.key, label: group.label });
    }
  }
  return sections;
}

export function groupCategories(
  categories: readonly ExpenseCategoryReadModel[]
): ExpenseGroupSection<ExpenseCategoryReadModel>[] {
  return groupByExpenseGroup(categories, (category) => category.groupKey);
}

// ---------------------------------------------------------------- money input

export type MoneyInputError =
  | "empty"
  | "invalid"
  | "negative"
  | "not_positive"
  | "too_large"
  | "too_many_decimals";

export type MoneyInputResult =
  | { ok: true; value: string }
  | { error: MoneyInputError; ok: false };

/** Whole-unit digits accepted before the server's own (larger) limit. */
const MAX_WHOLE_DIGITS = 12;

const currencyPrefix = /^R\$\s*/i;
const negativeStart = /^[-−]/;
const allowedCharacters = /^[\d.,]+$/;
const onlyDigits = /^\d*$/;
const dotGrouping = /^[1-9]\d{0,2}(\.\d{3})+$/;
const commaGrouping = /^[1-9]\d{0,2}(,\d{3})+$/;
const onlyZeros = /^0*$/;
const leadingZeros = /^0+(?=\d)/;

interface DecimalParts {
  fraction: string;
  whole: string;
}

function removeGrouping(whole: string, thousands: "." | ","): string | null {
  const grouping = thousands === "." ? dotGrouping : commaGrouping;
  if (whole.includes(thousands)) {
    return grouping.test(whole) ? whole.replaceAll(thousands, "") : null;
  }
  return onlyDigits.test(whole) ? whole : null;
}

function splitAt(
  text: string,
  decimal: "." | ",",
  thousands: "." | ","
): DecimalParts | null {
  const parts = text.split(decimal);
  if (parts.length > 2) {
    return null;
  }
  const [wholeText = "", fraction] = parts;
  if (fraction !== undefined && !onlyDigits.test(fraction)) {
    return null;
  }
  if (fraction === "" || (wholeText === "" && fraction === undefined)) {
    return null;
  }
  const whole = removeGrouping(wholeText, thousands);
  return whole === null ? null : { fraction: fraction ?? "", whole };
}

function splitDecimalText(text: string): DecimalParts | null {
  const hasDot = text.includes(".");
  const hasComma = text.includes(",");
  if (hasDot && hasComma) {
    // the separator written last is the decimal one: 1.500,50 and 1,500.50
    return text.lastIndexOf(",") > text.lastIndexOf(".")
      ? splitAt(text, ",", ".")
      : splitAt(text, ".", ",");
  }
  if (hasComma) {
    return splitAt(text, ",", ".");
  }
  // Only dots: 1.500 and 12.345.678 are thousands, as in pt-BR; 1500.50 and 1.5 are decimals.
  return dotGrouping.test(text)
    ? { fraction: "", whole: text.replaceAll(".", "") }
    : splitAt(text, ".", ",");
}

/**
 * Reads what a person typed as an amount of money and returns the exact
 * decimal text the API expects ("1500.50"), or the reason it was refused.
 * Accepts "1500", "1.500,50", "1500,5", "1500.50" and "R$ 1.500,50"; refuses
 * negative, zero, more than two decimals and anything that is not a number.
 * A single dot followed by exactly three digits ("1.500") is read as a
 * thousands separator, as in pt-BR; a single comma is always the decimal mark.
 */
export function parseMoneyInput(raw: string): MoneyInputResult {
  const text = raw.trim().replace(currencyPrefix, "");
  if (text === "") {
    return { error: "empty", ok: false };
  }
  if (negativeStart.test(text)) {
    return { error: "negative", ok: false };
  }
  if (!allowedCharacters.test(text)) {
    return { error: "invalid", ok: false };
  }
  const parts = splitDecimalText(text);
  if (parts === null) {
    return { error: "invalid", ok: false };
  }
  if (parts.fraction.length > 2) {
    return { error: "too_many_decimals", ok: false };
  }
  const whole = parts.whole.replace(leadingZeros, "") || "0";
  if (whole.length > MAX_WHOLE_DIGITS) {
    return { error: "too_large", ok: false };
  }
  if (onlyZeros.test(whole + parts.fraction)) {
    return { error: "not_positive", ok: false };
  }
  return { ok: true, value: `${whole}.${parts.fraction.padEnd(2, "0")}` };
}

const moneyInputMessages: Record<MoneyInputError, string> = {
  empty: "Informe o valor da despesa.",
  invalid: "Use apenas números, por exemplo 1500, 1.500,50 ou 1500,5.",
  negative: "O valor não pode ser negativo.",
  not_positive: "O valor precisa ser maior que zero.",
  too_large: "O valor é grande demais.",
  too_many_decimals: "Use no máximo duas casas decimais.",
};

export function moneyInputMessage(error: MoneyInputError): string {
  return moneyInputMessages[error];
}

/**
 * A positive exact decimal text ("1500.50") shown the way a person types it
 * ("1500,50"), to fill the field when editing.
 */
export function moneyInputText(amount: string): string {
  return amount.replace(".", ",");
}

// ----------------------------------------------------------------- the draft

export interface ExpenseDraft {
  amount: string;
  categoryId: string;
  competenceOn: string;
  description: string;
  payee: string;
}

export type ExpenseDraftField = keyof ExpenseDraft;

/** Whether the person typed or picked something: a field that still has its starting value is not work. */
export function isExpenseDraftChanged(
  draft: ExpenseDraft,
  initial: ExpenseDraft
): boolean {
  return isDraftChanged(draft, initial);
}
export type ExpenseDraftErrors = Partial<
  Record<ExpenseDraftField, string | undefined>
>;

/** What the API takes to create or change an expense. */
export interface ExpenseInput {
  amount: string;
  categoryId: string;
  competenceOn: string;
  description: string;
  payee: string | null;
}

/** Fields in the order they appear on the form, to focus the first wrong one. */
export const EXPENSE_DRAFT_FIELDS: readonly ExpenseDraftField[] = [
  "amount",
  "categoryId",
  "competenceOn",
  "description",
  "payee",
];

function competenceError(competenceOn: string): string | null {
  if (!isCalendarDate(competenceOn)) {
    return "Informe uma data de competência válida.";
  }
  if (competenceOn < EARLIEST_EXPENSE_COMPETENCE) {
    return "A data de competência não pode ser anterior a 2000.";
  }
  return null;
}

/**
 * Checks a draft the way the server will, so mistakes show next to the field
 * before anything is sent. `input` is set only when nothing is wrong.
 */
export function validateExpenseDraft(draft: ExpenseDraft): {
  errors: ExpenseDraftErrors;
  input: ExpenseInput | null;
} {
  const errors: ExpenseDraftErrors = {};
  const amount = parseMoneyInput(draft.amount);
  if (!amount.ok) {
    errors.amount = moneyInputMessage(amount.error);
  }
  if (draft.categoryId === "") {
    errors.categoryId = "Escolha uma categoria.";
  }
  const competence = competenceError(draft.competenceOn);
  if (competence) {
    errors.competenceOn = competence;
  }
  const description = draft.description.trim();
  if (description === "") {
    errors.description = "Descreva a despesa.";
  } else if ([...description].length > MAX_EXPENSE_DESCRIPTION_LENGTH) {
    errors.description = `Use no máximo ${MAX_EXPENSE_DESCRIPTION_LENGTH} caracteres.`;
  }
  const payee = draft.payee.trim();
  if ([...payee].length > MAX_EXPENSE_PAYEE_LENGTH) {
    errors.payee = `Use no máximo ${MAX_EXPENSE_PAYEE_LENGTH} caracteres.`;
  }
  if (!amount.ok || Object.keys(errors).length > 0) {
    return { errors, input: null };
  }
  return {
    errors,
    input: {
      amount: amount.value,
      categoryId: draft.categoryId,
      competenceOn: draft.competenceOn,
      description,
      payee: payee === "" ? null : payee,
    },
  };
}

// -------------------------------------------------------------------- months

const monthPattern = /^(\d{4})-(0[1-9]|1[0-2])$/;
const monthNames = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
] as const;

export function isMonthValue(value: string): boolean {
  return monthPattern.test(value);
}

function parseMonth(month: string): { month: number; year: number } | null {
  const match = monthPattern.exec(month);
  if (!match) {
    return null;
  }
  return { month: Number(match[2]), year: Number(match[1]) };
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

/** "YYYY-MM" of a calendar day written as YYYY-MM-DD. */
export function monthOfDay(day: string): string {
  return day.slice(0, 7);
}

/** First and last day (YYYY-MM-DD) of a "YYYY-MM" month, or null when it is not one. */
export function monthBounds(
  month: string
): { from: string; to: string } | null {
  const parsed = parseMonth(month);
  if (!parsed) {
    return null;
  }
  const lastDay = new Date(Date.UTC(parsed.year, parsed.month, 0)).getUTCDate();
  const prefix = `${String(parsed.year).padStart(4, "0")}-${twoDigits(parsed.month)}`;
  return { from: `${prefix}-01`, to: `${prefix}-${twoDigits(lastDay)}` };
}

/** The month `delta` months away ("2026-12" + 1 is "2027-01"); null for a non-month. */
export function shiftMonth(month: string, delta: number): string | null {
  const parsed = parseMonth(month);
  if (!parsed) {
    return null;
  }
  const index = parsed.year * 12 + (parsed.month - 1) + delta;
  const year = Math.floor(index / 12);
  if (year < 0 || year > 9999) {
    return null;
  }
  return `${String(year).padStart(4, "0")}-${twoDigits((index % 12) + 1)}`;
}

/** "outubro de 2026" for "2026-10". */
export function formatMonthLabel(month: string): string {
  const parsed = parseMonth(month);
  if (!parsed) {
    return month;
  }
  return `${monthNames[parsed.month - 1]} de ${parsed.year}`;
}
