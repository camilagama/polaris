import { isValidCalendarDate } from "../inventory/calendar-date";
import {
  EARLIEST_EXPENSE_COMPETENCE,
  MAX_EXPENSE_COMPETENCE_DAYS_AHEAD,
  type NormalizedExpense,
  normalizeExpense,
} from "./expense";

/**
 * Recurring expenses (plan PR65). A rule is a template that produces ordinary
 * expenses ("occurrences") on a calendar: every week, month or year, from a
 * start date, optionally until an end date. Occurrences are generated when they
 * fall due (their date is today or earlier, in the organization's calendar),
 * each one a normal expense that is edited and voided on its own.
 *
 * Occurrence N lies on the Nth step from the start date, always counted from
 * the START date (not from the previous occurrence), so a rule that starts on
 * the 31st lands on the last day of shorter months and back on the 31st after.
 * Editing a rule changes the occurrences that are not generated yet; the ones
 * already generated, edited or voided are never rewritten.
 */
export const RECURRENCE_FREQUENCIES = ["weekly", "monthly", "yearly"] as const;
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number];

/** At most this many occurrences are generated per rule in one pass (the next pass continues). */
export const MAX_OCCURRENCES_PER_PASS = 500;

export class InvalidExpenseRuleError extends Error {
  readonly code = "invalid_expense_rule";

  constructor(options?: ErrorOptions) {
    super("invalid_expense_rule", options);
    this.name = "InvalidExpenseRuleError";
  }
}

export class ExpenseRuleNotFoundError extends Error {
  readonly code = "expense_rule_not_found";

  constructor() {
    super("expense_rule_not_found");
    this.name = "ExpenseRuleNotFoundError";
  }
}

export class ExpenseRuleVersionConflictError extends Error {
  readonly code = "expense_rule_version_conflict";

  constructor() {
    super("expense_rule_version_conflict");
    this.name = "ExpenseRuleVersionConflictError";
  }
}

export function isRecurrenceFrequency(
  value: string
): value is RecurrenceFrequency {
  return (RECURRENCE_FREQUENCIES as readonly string[]).includes(value);
}

function parts(date: string): [number, number, number] {
  const [year, month, day] = date.split("-").map(Number);
  return [year ?? 0, month ?? 1, day ?? 1];
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The date of occurrence `index` (0 is the start date itself). */
export function occurrenceDate(
  startsOn: string,
  frequency: RecurrenceFrequency,
  index: number
): string {
  const [year, month, day] = parts(startsOn);
  if (frequency === "weekly") {
    const moved = new Date(Date.UTC(year, month - 1, day + 7 * index));
    return moved.toISOString().slice(0, 10);
  }
  const monthsAhead = frequency === "monthly" ? index : 12 * index;
  const monthIndex = month - 1 + monthsAhead;
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonth = (monthIndex % 12) + 1;
  const targetDay = Math.min(day, daysInMonth(targetYear, targetMonth));
  return `${pad(targetYear, 4)}-${pad(targetMonth, 2)}-${pad(targetDay, 2)}`;
}

export interface DueOccurrencesInput {
  /** The occurrences already generated (the next one to produce has this index). */
  generatedCount: number;
  endsOn: string | null;
  frequency: RecurrenceFrequency;
  /** Occurrences per pass; defaults to MAX_OCCURRENCES_PER_PASS. */
  limit?: number;
  startsOn: string;
  /** Today in the organization's calendar. */
  today: string;
}

export interface DueOccurrence {
  date: string;
  index: number;
}

/**
 * The occurrences that fell due and were not generated yet, in order: from the
 * next index while the date is not after today nor after the end date. After a
 * long pause (the scheduler was down, or the rule was created with a start date
 * in the past) this returns everything missed, up to the per-pass limit.
 */
export function dueOccurrences(input: DueOccurrencesInput): DueOccurrence[] {
  const limit = Math.min(
    input.limit ?? MAX_OCCURRENCES_PER_PASS,
    MAX_OCCURRENCES_PER_PASS
  );
  const last =
    input.endsOn !== null && input.endsOn < input.today
      ? input.endsOn
      : input.today;
  const due: DueOccurrence[] = [];
  for (let index = input.generatedCount; due.length < limit; index += 1) {
    const date = occurrenceDate(input.startsOn, input.frequency, index);
    if (date > last) {
      break;
    }
    due.push({ date, index });
  }
  return due;
}

export interface ExpenseRuleInput {
  amount: string;
  description: string;
  endsOn?: string | null | undefined;
  payee?: string | null | undefined;
  frequency: string;
  /** First occurrence date (`YYYY-MM-DD`, organization calendar). */
  startsOn: string;
}

export interface NormalizedExpenseRule {
  amount: string;
  description: string;
  endsOn: string | null;
  frequency: RecurrenceFrequency;
  payee: string | null;
  startsOn: string;
}

function addDays(date: string, days: number): string {
  const [year, month, day] = parts(date);
  return new Date(Date.UTC(year, month - 1, day + days))
    .toISOString()
    .slice(0, 10);
}

/**
 * Validates what a person typed for a rule: the amount and text with the rules
 * of an expense, a known frequency, real dates, the start date inside the
 * competence window (not before 2000, not more than 366 days ahead of
 * `today`) and an end date that is not before the start.
 */
export function normalizeExpenseRule(
  input: ExpenseRuleInput,
  today: string
): NormalizedExpenseRule {
  if (
    !isValidCalendarDate(input.startsOn) ||
    input.startsOn < EARLIEST_EXPENSE_COMPETENCE ||
    input.startsOn > addDays(today, MAX_EXPENSE_COMPETENCE_DAYS_AHEAD)
  ) {
    throw new InvalidExpenseRuleError();
  }
  return normalizeExpenseRuleTemplate(input);
}

/**
 * The part of a rule that can be edited later (amount, text, end date), checked
 * against the stored start date and frequency. It does not re-check the start
 * date against the competence window: a rule created long ago stays editable.
 */
export function normalizeExpenseRuleTemplate(
  input: ExpenseRuleInput
): NormalizedExpenseRule {
  if (!isRecurrenceFrequency(input.frequency)) {
    throw new InvalidExpenseRuleError();
  }
  const endsOn = input.endsOn ?? null;
  if (
    endsOn !== null &&
    !(isValidCalendarDate(endsOn) && endsOn >= input.startsOn)
  ) {
    throw new InvalidExpenseRuleError();
  }
  let expense: NormalizedExpense;
  try {
    expense = normalizeExpense({
      amount: input.amount,
      competenceOn: input.startsOn,
      description: input.description,
      payee: input.payee ?? null,
    });
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: the cause is passed in the options object.
    throw new InvalidExpenseRuleError({ cause: error });
  }
  return {
    amount: expense.amount,
    description: expense.description,
    endsOn,
    frequency: input.frequency,
    payee: expense.payee,
    startsOn: input.startsOn,
  };
}

/** The calendar date before `date`. */
export function dayBefore(date: string): string {
  return addDays(date, -1);
}

function daysBetween(earlier: string, later: string): number {
  const [y1, m1, d1] = parts(earlier);
  const [y2, m2, d2] = parts(later);
  return Math.round(
    (Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000
  );
}

/**
 * How many occurrences lie on or before `date` (0 when the rule starts later).
 * Used when a paused rule resumes: the periods that passed while it was paused
 * are skipped, not generated afterwards.
 */
export function occurrencesThrough(
  startsOn: string,
  frequency: RecurrenceFrequency,
  date: string
): number {
  if (date < startsOn) {
    return 0;
  }
  const [y1, m1] = parts(startsOn);
  const [y2, m2] = parts(date);
  let steps: number;
  if (frequency === "weekly") {
    steps = Math.floor(daysBetween(startsOn, date) / 7);
  } else if (frequency === "monthly") {
    steps = (y2 - y1) * 12 + (m2 - m1);
  } else {
    steps = y2 - y1;
  }
  // the estimate is at most one off because of the end-of-month clamping
  let count = steps + 1;
  while (count > 0 && occurrenceDate(startsOn, frequency, count - 1) > date) {
    count -= 1;
  }
  while (occurrenceDate(startsOn, frequency, count) <= date) {
    count += 1;
  }
  return count;
}
