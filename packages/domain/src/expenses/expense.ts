import { isValidCalendarDate } from "../inventory/calendar-date";
import { Money } from "../money/money";

/**
 * Expenses (plan PR63 and PR64): what the operation cost, by competence. This
 * is a managerial view, not accounting: no suppliers, accounts payable or
 * reconciliation (docs/business-rules/expenses-and-results.md).
 */
export const MAX_EXPENSE_CATEGORY_NAME_LENGTH = 100;
export const MAX_EXPENSE_DESCRIPTION_LENGTH = 200;
export const MAX_EXPENSE_PAYEE_LENGTH = 120;

/** The competence date cannot be older than this calendar date. */
export const EARLIEST_EXPENSE_COMPETENCE = "2000-01-01";
/** ...nor further ahead than this many days after the organization's today. */
export const MAX_EXPENSE_COMPETENCE_DAYS_AHEAD = 366;

export const EXPENSE_GROUP_KEYS = [
  "commercial",
  "operational",
  "financial",
  "taxes",
  "other",
] as const;

/** The five fixed groups; the organization customizes the categories inside them. */
export const EXPENSE_GROUPS = [
  { key: "commercial", label: "Comercial" },
  { key: "operational", label: "Operacional/Administrativa" },
  { key: "financial", label: "Financeira" },
  { key: "taxes", label: "Impostos" },
  { key: "other", label: "Outras" },
] as const;

export type ExpenseGroupKey = (typeof EXPENSE_GROUPS)[number]["key"];

const expenseGroupKeys: readonly string[] = EXPENSE_GROUPS.map(
  (group) => group.key
);

export function isExpenseGroupKey(value: string): value is ExpenseGroupKey {
  return expenseGroupKeys.includes(value);
}

export interface DefaultExpenseCategory {
  group: ExpenseGroupKey;
  name: string;
  /** Stable identity of the default across renames, for reports. */
  systemKey: string;
}

/**
 * What a new organization starts with, so the first expense needs no setup.
 * They are ordinary categories of the organization (renamed, archived and
 * extended freely); only `systemKey` remembers where they came from.
 */
export const DEFAULT_EXPENSE_CATEGORIES: readonly DefaultExpenseCategory[] = [
  { group: "commercial", name: "Marketing", systemKey: "marketing" },
  { group: "commercial", name: "Comissões", systemKey: "commissions" },
  { group: "commercial", name: "Entrega", systemKey: "delivery" },
  { group: "commercial", name: "Embalagem", systemKey: "packaging" },
  { group: "operational", name: "Aluguel", systemKey: "rent" },
  { group: "operational", name: "Energia e água", systemKey: "utilities" },
  {
    group: "operational",
    name: "Internet e telefone",
    systemKey: "telecom",
  },
  { group: "operational", name: "Contador", systemKey: "accountant" },
  { group: "operational", name: "Software", systemKey: "software" },
  { group: "operational", name: "Salários e pró-labore", systemKey: "payroll" },
  { group: "financial", name: "Tarifas bancárias", systemKey: "bank_fees" },
  { group: "financial", name: "Juros e multas", systemKey: "interest" },
  { group: "taxes", name: "Impostos", systemKey: "taxes" },
  { group: "other", name: "Outras despesas", systemKey: "other" },
];

export class InvalidExpenseCategoryError extends Error {
  readonly code = "invalid_expense_category";

  constructor() {
    super("invalid_expense_category");
    this.name = "InvalidExpenseCategoryError";
  }
}

export class ExpenseCategoryNotFoundError extends Error {
  readonly code = "expense_category_not_found";

  constructor() {
    super("expense_category_not_found");
    this.name = "ExpenseCategoryNotFoundError";
  }
}

export class ExpenseCategoryNameConflictError extends Error {
  readonly code = "expense_category_name_conflict";

  constructor(options?: ErrorOptions) {
    super("expense_category_name_conflict", options);
    this.name = "ExpenseCategoryNameConflictError";
  }
}

export class ExpenseCategoryVersionConflictError extends Error {
  readonly code = "expense_category_version_conflict";

  constructor() {
    super("expense_category_version_conflict");
    this.name = "ExpenseCategoryVersionConflictError";
  }
}

/** A new expense (or a changed category) cannot use an archived category. */
export class ExpenseCategoryUnavailableError extends Error {
  readonly code = "expense_category_unavailable";

  constructor() {
    super("expense_category_unavailable");
    this.name = "ExpenseCategoryUnavailableError";
  }
}

export class InvalidExpenseError extends Error {
  readonly code = "invalid_expense";

  constructor(options?: ErrorOptions) {
    super("invalid_expense", options);
    this.name = "InvalidExpenseError";
  }
}

export class ExpenseCompetenceOutOfRangeError extends Error {
  readonly code = "expense_competence_out_of_range";

  constructor() {
    super("expense_competence_out_of_range");
    this.name = "ExpenseCompetenceOutOfRangeError";
  }
}

export class ExpenseNotFoundError extends Error {
  readonly code = "expense_not_found";

  constructor() {
    super("expense_not_found");
    this.name = "ExpenseNotFoundError";
  }
}

export class ExpenseVersionConflictError extends Error {
  readonly code = "expense_version_conflict";

  constructor() {
    super("expense_version_conflict");
    this.name = "ExpenseVersionConflictError";
  }
}

/** A voided expense is read-only until it is restored. */
export class ExpenseVoidedError extends Error {
  readonly code = "expense_voided";

  constructor() {
    super("expense_voided");
    this.name = "ExpenseVoidedError";
  }
}

/** The sale an expense points to does not exist in the organization. */
export class ExpenseSaleNotFoundError extends Error {
  readonly code = "expense_sale_not_found";

  constructor() {
    super("expense_sale_not_found");
    this.name = "ExpenseSaleNotFoundError";
  }
}

export function normalizeExpenseCategoryName(name: string): string {
  const normalized = name.trim();
  if (
    !normalized ||
    [...normalized].length > MAX_EXPENSE_CATEGORY_NAME_LENGTH
  ) {
    throw new InvalidExpenseCategoryError();
  }
  return normalized;
}

export interface ExpenseInput {
  amount: string;
  /** Calendar date of the organization (`YYYY-MM-DD`): the period it belongs to. */
  competenceOn: string;
  description: string;
  payee?: string | null;
}

export interface NormalizedExpense {
  /** Exact BRL amount with two decimals, always positive. */
  amount: string;
  competenceOn: string;
  description: string;
  payee: string | null;
}

function optionalText(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}

/** Normalizes what the person typed; the competence window is checked apart (it needs "today"). */
export function normalizeExpense(input: ExpenseInput): NormalizedExpense {
  const description = input.description.trim();
  const payee = optionalText(input.payee);
  if (
    !description ||
    [...description].length > MAX_EXPENSE_DESCRIPTION_LENGTH ||
    [...(payee ?? "")].length > MAX_EXPENSE_PAYEE_LENGTH ||
    !isValidCalendarDate(input.competenceOn)
  ) {
    throw new InvalidExpenseError();
  }
  let amount: Money;
  try {
    amount = Money.from(input.amount.trim());
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: the cause is passed in the options object.
    throw new InvalidExpenseError({ cause: error });
  }
  if (amount.minorUnits <= 0n) {
    throw new InvalidExpenseError();
  }
  return {
    amount: amount.toString(),
    competenceOn: input.competenceOn,
    description,
    payee,
  };
}

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/**
 * The competence date must be a plausible period: not before `2000-01-01` and
 * not more than 366 days after `today` (the date in the organization's
 * calendar). Competence may be in the future (next month's rent) or far in the
 * past (a correction), unlike a sale, which happened.
 */
export function assertExpenseCompetenceInRange(
  competenceOn: string,
  today: string
): void {
  if (
    competenceOn < EARLIEST_EXPENSE_COMPETENCE ||
    competenceOn > addDays(today, MAX_EXPENSE_COMPETENCE_DAYS_AHEAD)
  ) {
    throw new ExpenseCompetenceOutOfRangeError();
  }
}

export type ExpenseLifecycle = "active" | "voided";
export type ExpenseLifecycleAction = "restore" | "void";

export interface ExpenseLifecycleTransition {
  changed: boolean;
  lifecycle: ExpenseLifecycle;
  voidedAt: Date | null;
}

export function deriveExpenseLifecycle(
  voidedAt: Date | null
): ExpenseLifecycle {
  return voidedAt === null ? "active" : "voided";
}

/**
 * An expense is never deleted: a mistaken one is voided (kept, audited, out of
 * every total and list by default) and can be brought back.
 */
export function transitionExpenseLifecycle(
  voidedAt: Date | null,
  action: ExpenseLifecycleAction,
  at: Date = new Date()
): ExpenseLifecycleTransition {
  const current = deriveExpenseLifecycle(voidedAt);
  const target = action === "void" ? "voided" : "active";
  if (current === target) {
    return { changed: false, lifecycle: current, voidedAt };
  }
  return {
    changed: true,
    lifecycle: target,
    voidedAt: target === "voided" ? at : null,
  };
}
