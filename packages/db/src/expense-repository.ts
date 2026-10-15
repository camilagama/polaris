import {
  assertExpenseCompetenceInRange,
  DEFAULT_EXPENSE_CATEGORIES,
  EXPENSE_GROUPS,
  ExpenseCategoryNameConflictError,
  ExpenseCategoryNotFoundError,
  ExpenseCategoryUnavailableError,
  ExpenseCategoryVersionConflictError,
  type ExpenseGroupKey,
  type ExpenseInput,
  ExpenseNotFoundError,
  ExpenseSaleNotFoundError,
  ExpenseVersionConflictError,
  ExpenseVoidedError,
  type ExpenseLifecycleAction,
  InvalidExpenseCategoryError,
  InvalidExpenseError,
  isExpenseGroupKey,
  normalizeExpense,
  normalizeExpenseCategoryName,
  transitionExpenseLifecycle,
} from "@polaris/domain/expenses/expense";
import { isValidCalendarDate } from "@polaris/domain/inventory/calendar-date";
import {
  dayBefore,
  dueOccurrences,
  ExpenseRuleNotFoundError,
  ExpenseRuleVersionConflictError,
  isRecurrenceFrequency,
  MAX_OCCURRENCES_PER_PASS,
  normalizeExpenseRule,
  normalizeExpenseRuleTemplate,
  occurrenceDate,
  occurrencesThrough,
} from "@polaris/domain/expenses/recurrence";
import { calendarDateInTimeZone } from "@polaris/domain/sales/confirm-sale";
import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import {
  expenseCategories,
  expenseRecurringRules,
  expenses,
} from "./schema/expense";
import { organizations } from "./schema/organization";
import { sales } from "./schema/sale";
import { recordTenantAuditEvent } from "./tenant-audit";
import {
  TenantAuthorizationError,
  type TenantRequestIdentity,
  type TenantRequestTransaction,
} from "./tenant-transaction";

/** Every expense and expense-category operation needs this one capability. */
const EXPENSE_CAPABILITY = "expense:create";

function requireExpenseCapability(identity: TenantRequestIdentity) {
  if (identity.capability !== EXPENSE_CAPABILITY) {
    throw new TenantAuthorizationError("capability_denied");
  }
}

function hasConstraint(error: unknown, constraint: string): boolean {
  const seen = new Set<object>();
  let current: unknown = error;
  while (
    typeof current === "object" &&
    current !== null &&
    !seen.has(current)
  ) {
    seen.add(current);
    const candidate = current as {
      cause?: unknown;
      code?: unknown;
      constraint?: unknown;
    };
    if (candidate.code === "23505" && candidate.constraint === constraint) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

const groupOrder = new Map<string, number>(
  EXPENSE_GROUPS.map((group, index) => [group.key, index])
);

// ---------------------------------------------------------------- categories

export interface ExpenseCategoryListOptions {
  status?: "active" | "archived" | "all";
}

export interface CreateExpenseCategoryInput {
  group: ExpenseGroupKey;
  name: string;
  requestId?: string | null;
}

export interface ExpenseCategoryMutationInput {
  expectedVersion: number;
  id: string;
  requestId?: string | null;
}

export interface RenameExpenseCategoryInput
  extends ExpenseCategoryMutationInput {
  name: string;
}

const categoryColumns = {
  archivedAt: expenseCategories.archivedAt,
  createdAt: expenseCategories.createdAt,
  groupKey: expenseCategories.groupKey,
  id: expenseCategories.id,
  name: expenseCategories.name,
  organizationId: expenseCategories.organizationId,
  systemKey: expenseCategories.systemKey,
  updatedAt: expenseCategories.updatedAt,
  version: expenseCategories.version,
};

/**
 * An organization with no categories yet starts with the defaults, so the first
 * expense needs no setup. Seeded once: if the organization has any category row
 * (even archived) nothing is added, and two concurrent first calls collide on
 * the unique name and leave one set.
 */
async function ensureDefaultExpenseCategories(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity
): Promise<void> {
  const [existing] = await transaction
    .select({ id: expenseCategories.id })
    .from(expenseCategories)
    .where(eq(expenseCategories.organizationId, identity.organizationId))
    .limit(1);
  if (existing) {
    return;
  }
  await transaction
    .insert(expenseCategories)
    .values(
      DEFAULT_EXPENSE_CATEGORIES.map((category) => ({
        groupKey: category.group,
        name: category.name,
        organizationId: identity.organizationId,
        systemKey: category.systemKey,
      }))
    )
    .onConflictDoNothing();
}

export async function listExpenseCategories(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  options: ExpenseCategoryListOptions = {}
) {
  requireExpenseCapability(identity);
  await ensureDefaultExpenseCategories(transaction, identity);
  const conditions = [
    eq(expenseCategories.organizationId, identity.organizationId),
  ];
  const status = options.status ?? "active";
  if (status === "active") {
    conditions.push(isNull(expenseCategories.archivedAt));
  } else if (status === "archived") {
    conditions.push(isNotNull(expenseCategories.archivedAt));
  }
  const rows = await transaction
    .select(categoryColumns)
    .from(expenseCategories)
    .where(and(...conditions))
    .orderBy(asc(expenseCategories.name), asc(expenseCategories.id));
  // fixed group order first, then by name
  return rows.sort(
    (a, b) =>
      (groupOrder.get(a.groupKey) ?? 99) - (groupOrder.get(b.groupKey) ?? 99)
  );
}

export async function createExpenseCategory(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: CreateExpenseCategoryInput
) {
  requireExpenseCapability(identity);
  if (!isExpenseGroupKey(input.group)) {
    throw new InvalidExpenseCategoryError();
  }
  const name = normalizeExpenseCategoryName(input.name);
  await ensureDefaultExpenseCategories(transaction, identity);
  let category: typeof expenseCategories.$inferSelect | undefined;
  try {
    [category] = await transaction.transaction((savepoint) =>
      savepoint
        .insert(expenseCategories)
        .values({
          groupKey: input.group,
          name,
          organizationId: identity.organizationId,
        })
        .returning()
    );
  } catch (error) {
    if (hasConstraint(error, "expense_categories_organization_name_unique")) {
      // biome-ignore lint/style/useErrorCause: the cause is passed in the options object.
      throw new ExpenseCategoryNameConflictError({ cause: error });
    }
    throw error;
  }
  if (!category) {
    throw new Error("expense_category_insert_failed");
  }
  await recordTenantAuditEvent(transaction, identity, {
    entityId: category.id,
    entityType: "expense_category",
    eventType: "expense_category.created",
    requestId: input.requestId ?? null,
  });
  return category;
}

async function lockCategory(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: ExpenseCategoryMutationInput
) {
  const [existing] = await transaction
    .select(categoryColumns)
    .from(expenseCategories)
    .where(
      and(
        eq(expenseCategories.id, input.id),
        eq(expenseCategories.organizationId, identity.organizationId)
      )
    )
    .limit(1)
    .for("update");
  if (!existing) {
    throw new ExpenseCategoryNotFoundError();
  }
  if (existing.version !== input.expectedVersion) {
    throw new ExpenseCategoryVersionConflictError();
  }
  return existing;
}

async function saveCategory(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: ExpenseCategoryMutationInput,
  existing: { version: number },
  changes: { archivedAt?: Date | null; name?: string }
) {
  const [category] = await transaction
    .update(expenseCategories)
    .set({ ...changes, updatedAt: new Date(), version: existing.version + 1 })
    .where(
      and(
        eq(expenseCategories.id, input.id),
        eq(expenseCategories.organizationId, identity.organizationId),
        eq(expenseCategories.version, input.expectedVersion)
      )
    )
    .returning();
  if (!category) {
    throw new ExpenseCategoryVersionConflictError();
  }
  return category;
}

export async function renameExpenseCategory(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: RenameExpenseCategoryInput
) {
  requireExpenseCapability(identity);
  const name = normalizeExpenseCategoryName(input.name);
  const existing = await lockCategory(transaction, identity, input);
  if (name === existing.name) {
    return { category: existing, changed: false };
  }
  let category: typeof expenseCategories.$inferSelect;
  try {
    category = await transaction.transaction((savepoint) =>
      saveCategory(savepoint, identity, input, existing, { name })
    );
  } catch (error) {
    if (hasConstraint(error, "expense_categories_organization_name_unique")) {
      // biome-ignore lint/style/useErrorCause: the cause is passed in the options object.
      throw new ExpenseCategoryNameConflictError({ cause: error });
    }
    throw error;
  }
  await recordTenantAuditEvent(transaction, identity, {
    entityId: category.id,
    entityType: "expense_category",
    eventType: "expense_category.renamed",
    requestId: input.requestId ?? null,
  });
  return { category, changed: true };
}

async function changeCategoryLifecycle(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: ExpenseCategoryMutationInput,
  action: "archive" | "restore"
) {
  requireExpenseCapability(identity);
  const existing = await lockCategory(transaction, identity, input);
  const archived = existing.archivedAt !== null;
  if (archived === (action === "archive")) {
    return { category: existing, changed: false };
  }
  const category = await saveCategory(transaction, identity, input, existing, {
    archivedAt: action === "archive" ? new Date() : null,
  });
  await recordTenantAuditEvent(transaction, identity, {
    entityId: category.id,
    entityType: "expense_category",
    eventType:
      action === "archive"
        ? "expense_category.archived"
        : "expense_category.restored",
    requestId: input.requestId ?? null,
  });
  return { category, changed: true };
}

export function archiveExpenseCategory(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: ExpenseCategoryMutationInput
) {
  return changeCategoryLifecycle(transaction, identity, input, "archive");
}

export function restoreExpenseCategory(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: ExpenseCategoryMutationInput
) {
  return changeCategoryLifecycle(transaction, identity, input, "restore");
}

// ------------------------------------------------------------------ expenses

export interface ExpenseWriteInput extends ExpenseInput {
  categoryId: string;
  requestId?: string | null;
  /** The sale this cost belongs to (enters that sale's margin), or none. */
  saleId?: string | null;
}

export interface UpdateExpenseInput extends ExpenseWriteInput {
  expectedVersion: number;
  id: string;
}

export interface ExpenseMutationInput {
  expectedVersion: number;
  id: string;
  requestId?: string | null;
}

export interface ExpenseListOptions {
  categoryId?: string | null;
  /** Keyset cursor from the previous page. */
  cursor?: string | null;
  /** Inclusive competence bounds (`YYYY-MM-DD`). */
  from?: string | null;
  limit?: number;
  status?: "active" | "voided" | "all";
  to?: string | null;
}

const expenseColumns = {
  amount: expenses.amount,
  categoryGroup: expenseCategories.groupKey,
  categoryId: expenses.categoryId,
  categoryName: expenseCategories.name,
  competenceOn: expenses.competenceOn,
  createdAt: expenses.createdAt,
  description: expenses.description,
  id: expenses.id,
  organizationId: expenses.organizationId,
  payee: expenses.payee,
  recurringRuleId: expenses.recurringRuleId,
  saleId: expenses.saleId,
  updatedAt: expenses.updatedAt,
  version: expenses.version,
  voidedAt: expenses.voidedAt,
};

const DEFAULT_EXPENSE_PAGE = 100;
const MAX_EXPENSE_PAGE = 200;
const cursorPattern =
  /^(\d{4}-\d{2}-\d{2})\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

async function organizationToday(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity
): Promise<string> {
  const [organization] = await transaction
    .select({ timezone: organizations.timezone })
    .from(organizations)
    .where(eq(organizations.id, identity.organizationId))
    .limit(1);
  if (!organization) {
    throw new TenantAuthorizationError("tenant_access_denied");
  }
  return calendarDateInTimeZone(new Date(), organization.timezone);
}

async function requireSale(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  saleId: string
) {
  const [sale] = await transaction
    .select({ id: sales.id })
    .from(sales)
    .where(
      and(
        eq(sales.id, saleId),
        eq(sales.organizationId, identity.organizationId)
      )
    )
    .limit(1);
  if (!sale) {
    throw new ExpenseSaleNotFoundError();
  }
}

async function requireActiveCategory(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  categoryId: string
) {
  const [category] = await transaction
    .select({ archivedAt: expenseCategories.archivedAt })
    .from(expenseCategories)
    .where(
      and(
        eq(expenseCategories.id, categoryId),
        eq(expenseCategories.organizationId, identity.organizationId)
      )
    )
    .limit(1);
  if (!category) {
    throw new ExpenseCategoryNotFoundError();
  }
  if (category.archivedAt !== null) {
    throw new ExpenseCategoryUnavailableError();
  }
}

async function readExpense(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  id: string
) {
  const [expense] = await transaction
    .select(expenseColumns)
    .from(expenses)
    .innerJoin(
      expenseCategories,
      and(
        eq(expenseCategories.organizationId, expenses.organizationId),
        eq(expenseCategories.id, expenses.categoryId)
      )
    )
    .where(
      and(
        eq(expenses.id, id),
        eq(expenses.organizationId, identity.organizationId)
      )
    )
    .limit(1);
  if (!expense) {
    throw new ExpenseNotFoundError();
  }
  return expense;
}

export async function createExpense(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: ExpenseWriteInput
) {
  requireExpenseCapability(identity);
  const normalized = normalizeExpense(input);
  assertExpenseCompetenceInRange(
    normalized.competenceOn,
    await organizationToday(transaction, identity)
  );
  await ensureDefaultExpenseCategories(transaction, identity);
  await requireActiveCategory(transaction, identity, input.categoryId);
  if (input.saleId) {
    await requireSale(transaction, identity, input.saleId);
  }
  const [created] = await transaction
    .insert(expenses)
    .values({
      amount: normalized.amount,
      categoryId: input.categoryId,
      competenceOn: normalized.competenceOn,
      description: normalized.description,
      organizationId: identity.organizationId,
      payee: normalized.payee,
      saleId: input.saleId ?? null,
    })
    .returning({ id: expenses.id });
  if (!created) {
    throw new Error("expense_insert_failed");
  }
  await recordTenantAuditEvent(transaction, identity, {
    entityId: created.id,
    entityType: "expense",
    eventType: "expense.created",
    requestId: input.requestId ?? null,
  });
  return await readExpense(transaction, identity, created.id);
}

async function lockExpense(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: ExpenseMutationInput
) {
  const [existing] = await transaction
    .select({
      amount: expenses.amount,
      categoryId: expenses.categoryId,
      competenceOn: expenses.competenceOn,
      description: expenses.description,
      payee: expenses.payee,
      saleId: expenses.saleId,
      version: expenses.version,
      voidedAt: expenses.voidedAt,
    })
    .from(expenses)
    .where(
      and(
        eq(expenses.id, input.id),
        eq(expenses.organizationId, identity.organizationId)
      )
    )
    .limit(1)
    .for("update");
  if (!existing) {
    throw new ExpenseNotFoundError();
  }
  if (existing.version !== input.expectedVersion) {
    throw new ExpenseVersionConflictError();
  }
  return existing;
}

export async function updateExpense(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: UpdateExpenseInput
) {
  requireExpenseCapability(identity);
  const normalized = normalizeExpense(input);
  const existing = await lockExpense(transaction, identity, input);
  if (existing.voidedAt !== null) {
    throw new ExpenseVoidedError();
  }
  const saleId = input.saleId ?? null;
  const changed =
    normalized.amount !== existing.amount ||
    input.categoryId !== existing.categoryId ||
    normalized.competenceOn !== existing.competenceOn ||
    normalized.description !== existing.description ||
    normalized.payee !== existing.payee ||
    saleId !== existing.saleId;
  if (!changed) {
    return {
      changed: false,
      expense: await readExpense(transaction, identity, input.id),
    };
  }
  // Only what actually changes is re-validated: an old expense may sit in a
  // category archived since, or on a date that has since left the window.
  if (normalized.competenceOn !== existing.competenceOn) {
    assertExpenseCompetenceInRange(
      normalized.competenceOn,
      await organizationToday(transaction, identity)
    );
  }
  if (input.categoryId !== existing.categoryId) {
    await requireActiveCategory(transaction, identity, input.categoryId);
  }
  if (saleId !== null && saleId !== existing.saleId) {
    await requireSale(transaction, identity, saleId);
  }
  const [updated] = await transaction
    .update(expenses)
    .set({
      amount: normalized.amount,
      categoryId: input.categoryId,
      competenceOn: normalized.competenceOn,
      description: normalized.description,
      payee: normalized.payee,
      saleId,
      updatedAt: new Date(),
      version: existing.version + 1,
    })
    .where(
      and(
        eq(expenses.id, input.id),
        eq(expenses.organizationId, identity.organizationId),
        eq(expenses.version, input.expectedVersion)
      )
    )
    .returning({ id: expenses.id });
  if (!updated) {
    throw new ExpenseVersionConflictError();
  }
  await recordTenantAuditEvent(transaction, identity, {
    entityId: updated.id,
    entityType: "expense",
    eventType: "expense.updated",
    requestId: input.requestId ?? null,
  });
  return {
    changed: true,
    expense: await readExpense(transaction, identity, input.id),
  };
}

async function changeExpenseLifecycle(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: ExpenseMutationInput,
  action: ExpenseLifecycleAction
) {
  requireExpenseCapability(identity);
  const existing = await lockExpense(transaction, identity, input);
  const transition = transitionExpenseLifecycle(existing.voidedAt, action);
  if (!transition.changed) {
    return {
      changed: false,
      expense: await readExpense(transaction, identity, input.id),
    };
  }
  const [updated] = await transaction
    .update(expenses)
    .set({
      updatedAt: new Date(),
      version: existing.version + 1,
      voidedAt: transition.voidedAt,
    })
    .where(
      and(
        eq(expenses.id, input.id),
        eq(expenses.organizationId, identity.organizationId),
        eq(expenses.version, input.expectedVersion)
      )
    )
    .returning({ id: expenses.id });
  if (!updated) {
    throw new ExpenseVersionConflictError();
  }
  await recordTenantAuditEvent(transaction, identity, {
    entityId: updated.id,
    entityType: "expense",
    eventType: action === "void" ? "expense.voided" : "expense.restored",
    requestId: input.requestId ?? null,
  });
  return {
    changed: true,
    expense: await readExpense(transaction, identity, input.id),
  };
}

export function voidExpense(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: ExpenseMutationInput
) {
  return changeExpenseLifecycle(transaction, identity, input, "void");
}

export function restoreExpense(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: ExpenseMutationInput
) {
  return changeExpenseLifecycle(transaction, identity, input, "restore");
}

/**
 * Expenses by competence, newest first, in pages. `total` is the sum of the
 * expenses that match the filter in full (not only this page), exact decimal
 * text; voided ones count only when the status asks for them.
 */
export async function listExpenses(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  options: ExpenseListOptions = {}
) {
  requireExpenseCapability(identity);
  await generateDueExpenses(transaction, identity);
  const limit = Math.min(
    Math.max(Math.trunc(options.limit ?? DEFAULT_EXPENSE_PAGE), 1),
    MAX_EXPENSE_PAGE
  );
  for (const bound of [options.from, options.to]) {
    if (bound && !isValidCalendarDate(bound)) {
      throw new InvalidExpenseError();
    }
  }
  const filters = [eq(expenses.organizationId, identity.organizationId)];
  const status = options.status ?? "active";
  if (status === "active") {
    filters.push(isNull(expenses.voidedAt));
  } else if (status === "voided") {
    filters.push(isNotNull(expenses.voidedAt));
  }
  if (options.from) {
    filters.push(sql`${expenses.competenceOn} >= ${options.from}::date`);
  }
  if (options.to) {
    filters.push(sql`${expenses.competenceOn} <= ${options.to}::date`);
  }
  if (options.categoryId) {
    filters.push(eq(expenses.categoryId, options.categoryId));
  }

  const [totals] = await transaction
    .select({
      count: sql<number>`count(*)::int`,
      // no numeric(20,2) cast: a sum of many valid amounts may need 19+ digits
      total: sql<string>`coalesce(sum(${expenses.amount}), 0.00)::text`,
    })
    .from(expenses)
    .where(and(...filters));

  const pageFilters = [...filters];
  if (options.cursor) {
    const match = cursorPattern.exec(options.cursor);
    if (!(match && isValidCalendarDate(match[1] as string))) {
      throw new InvalidExpenseError();
    }
    const [, competenceOn, id] = match;
    // row comparison: same order as the ORDER BY below
    pageFilters.push(
      sql`(${expenses.competenceOn}, ${expenses.id}) < (${competenceOn}::date, ${id}::uuid)`
    );
  }
  const rows = await transaction
    .select(expenseColumns)
    .from(expenses)
    .innerJoin(
      expenseCategories,
      and(
        eq(expenseCategories.organizationId, expenses.organizationId),
        eq(expenseCategories.id, expenses.categoryId)
      )
    )
    .where(and(...pageFilters))
    .orderBy(desc(expenses.competenceOn), desc(expenses.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    count: totals?.count ?? 0,
    expenses: page,
    nextCursor:
      rows.length > limit && last ? `${last.competenceOn}|${last.id}` : null,
    total: totals?.total ?? "0.00",
  };
}

// ----------------------------------------------------------- recurring rules

export interface ExpenseRuleListOptions {
  status?: "active" | "archived" | "all";
}

export interface ExpenseRuleWriteInput {
  amount: string;
  categoryId: string;
  description: string;
  endsOn?: string | null;
  payee?: string | null;
  requestId?: string | null;
}

export interface CreateExpenseRuleInput extends ExpenseRuleWriteInput {
  frequency: string;
  startsOn: string;
}

export interface UpdateExpenseRuleInput extends ExpenseRuleWriteInput {
  expectedVersion: number;
  id: string;
}

export interface ExpenseRuleMutationInput {
  expectedVersion: number;
  id: string;
  requestId?: string | null;
}

const ruleColumns = {
  amount: expenseRecurringRules.amount,
  archivedAt: expenseRecurringRules.archivedAt,
  categoryGroup: expenseCategories.groupKey,
  categoryId: expenseRecurringRules.categoryId,
  categoryName: expenseCategories.name,
  createdAt: expenseRecurringRules.createdAt,
  description: expenseRecurringRules.description,
  endsOn: expenseRecurringRules.endsOn,
  frequency: expenseRecurringRules.frequency,
  generatedCount: expenseRecurringRules.generatedCount,
  id: expenseRecurringRules.id,
  organizationId: expenseRecurringRules.organizationId,
  payee: expenseRecurringRules.payee,
  startsOn: expenseRecurringRules.startsOn,
  updatedAt: expenseRecurringRules.updatedAt,
  version: expenseRecurringRules.version,
};

type RuleRow = Awaited<ReturnType<typeof readRule>>;

/** The date of the next occurrence to generate, or null when the rule is over. */
function nextOccurrenceOn(rule: {
  endsOn: string | null;
  frequency: string;
  generatedCount: number;
  startsOn: string;
}): string | null {
  if (!isRecurrenceFrequency(rule.frequency)) {
    return null;
  }
  const next = occurrenceDate(
    rule.startsOn,
    rule.frequency,
    rule.generatedCount
  );
  return rule.endsOn !== null && next > rule.endsOn ? null : next;
}

function ruleReadModel(rule: RuleRow) {
  return { ...rule, nextOccurrenceOn: nextOccurrenceOn(rule) };
}

async function readRule(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  id: string
) {
  const [rule] = await transaction
    .select(ruleColumns)
    .from(expenseRecurringRules)
    .innerJoin(
      expenseCategories,
      and(
        eq(
          expenseCategories.organizationId,
          expenseRecurringRules.organizationId
        ),
        eq(expenseCategories.id, expenseRecurringRules.categoryId)
      )
    )
    .where(
      and(
        eq(expenseRecurringRules.id, id),
        eq(expenseRecurringRules.organizationId, identity.organizationId)
      )
    )
    .limit(1);
  if (!rule) {
    throw new ExpenseRuleNotFoundError();
  }
  return rule;
}

const MAX_GENERATION_PASSES = 10;

/**
 * Produces the occurrences that fell due since the last time (today or earlier,
 * in the organization's calendar), as ordinary expenses that snapshot the rule
 * as it is now. Idempotent and safe to call on every read: each rule is locked,
 * its `generated_count` says what exists, the unique (rule, occurrence) index
 * is a second guard, and a voided or edited occurrence is never regenerated.
 * An archived (paused) rule produces nothing. After a long pause the missed
 * occurrences are all generated, up to 500 per rule per pass.
 */
export async function generateDueExpenses(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity
): Promise<number> {
  requireExpenseCapability(identity);
  // Without a lock: only the rules that really have something due are locked
  // below (and re-checked under the lock), always in the same order (by ID), so
  // two readers never wait on rules they do not need nor lock them crosswise.
  const candidates = await transaction
    .select({
      endsOn: expenseRecurringRules.endsOn,
      frequency: expenseRecurringRules.frequency,
      generatedCount: expenseRecurringRules.generatedCount,
      id: expenseRecurringRules.id,
      startsOn: expenseRecurringRules.startsOn,
    })
    .from(expenseRecurringRules)
    .where(
      and(
        eq(expenseRecurringRules.organizationId, identity.organizationId),
        isNull(expenseRecurringRules.archivedAt)
      )
    )
    .orderBy(asc(expenseRecurringRules.id));
  if (candidates.length === 0) {
    return 0;
  }
  const today = await organizationToday(transaction, identity);
  const due = candidates.filter(
    (rule) =>
      isRecurrenceFrequency(rule.frequency) &&
      dueOccurrences({
        endsOn: rule.endsOn,
        frequency: rule.frequency,
        generatedCount: rule.generatedCount,
        limit: 1,
        startsOn: rule.startsOn,
        today,
      }).length > 0
  );
  let generated = 0;
  for (const candidate of due) {
    for (let pass = 0; pass < MAX_GENERATION_PASSES; pass += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: one rule at a time under its own row lock
      const made = await generateForRule(
        transaction,
        identity,
        candidate.id,
        today
      );
      generated += made;
      if (made < MAX_OCCURRENCES_PER_PASS) {
        break;
      }
    }
  }
  return generated;
}

async function generateForRule(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  ruleId: string,
  today: string
): Promise<number> {
  const [rule] = await transaction
    .select()
    .from(expenseRecurringRules)
    .where(
      and(
        eq(expenseRecurringRules.id, ruleId),
        eq(expenseRecurringRules.organizationId, identity.organizationId),
        isNull(expenseRecurringRules.archivedAt)
      )
    )
    .limit(1)
    .for("update");
  if (!(rule && isRecurrenceFrequency(rule.frequency))) {
    return 0;
  }
  const due = dueOccurrences({
    endsOn: rule.endsOn,
    frequency: rule.frequency,
    generatedCount: rule.generatedCount,
    startsOn: rule.startsOn,
    today,
  });
  if (due.length === 0) {
    return 0;
  }
  await transaction
    .insert(expenses)
    .values(
      due.map((occurrence) => ({
        amount: rule.amount,
        categoryId: rule.categoryId,
        competenceOn: occurrence.date,
        description: rule.description,
        organizationId: identity.organizationId,
        payee: rule.payee,
        recurringOccurrence: occurrence.index,
        recurringRuleId: rule.id,
      }))
    )
    .onConflictDoNothing();
  await transaction
    .update(expenseRecurringRules)
    .set({
      generatedCount: rule.generatedCount + due.length,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(expenseRecurringRules.id, rule.id),
        eq(expenseRecurringRules.organizationId, identity.organizationId)
      )
    );
  await recordTenantAuditEvent(transaction, identity, {
    entityId: rule.id,
    entityType: "expense_rule",
    eventType: "expense_rule.generated",
    requestId: null,
  });
  return due.length;
}

export async function listExpenseRules(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  options: ExpenseRuleListOptions = {}
) {
  requireExpenseCapability(identity);
  await generateDueExpenses(transaction, identity);
  const filters = [
    eq(expenseRecurringRules.organizationId, identity.organizationId),
  ];
  const status = options.status ?? "active";
  if (status === "active") {
    filters.push(isNull(expenseRecurringRules.archivedAt));
  } else if (status === "archived") {
    filters.push(isNotNull(expenseRecurringRules.archivedAt));
  }
  const rows = await transaction
    .select(ruleColumns)
    .from(expenseRecurringRules)
    .innerJoin(
      expenseCategories,
      and(
        eq(
          expenseCategories.organizationId,
          expenseRecurringRules.organizationId
        ),
        eq(expenseCategories.id, expenseRecurringRules.categoryId)
      )
    )
    .where(and(...filters))
    .orderBy(
      asc(expenseRecurringRules.description),
      asc(expenseRecurringRules.id)
    );
  return rows.map(ruleReadModel);
}

export async function createExpenseRule(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: CreateExpenseRuleInput
) {
  requireExpenseCapability(identity);
  const today = await organizationToday(transaction, identity);
  const normalized = normalizeExpenseRule(
    {
      amount: input.amount,
      description: input.description,
      endsOn: input.endsOn,
      frequency: input.frequency,
      payee: input.payee,
      startsOn: input.startsOn,
    },
    today
  );
  await ensureDefaultExpenseCategories(transaction, identity);
  await requireActiveCategory(transaction, identity, input.categoryId);
  const [created] = await transaction
    .insert(expenseRecurringRules)
    .values({
      amount: normalized.amount,
      categoryId: input.categoryId,
      description: normalized.description,
      endsOn: normalized.endsOn,
      frequency: normalized.frequency,
      organizationId: identity.organizationId,
      payee: normalized.payee,
      startsOn: normalized.startsOn,
    })
    .returning({ id: expenseRecurringRules.id });
  if (!created) {
    throw new Error("expense_rule_insert_failed");
  }
  await recordTenantAuditEvent(transaction, identity, {
    entityId: created.id,
    entityType: "expense_rule",
    eventType: "expense_rule.created",
    requestId: input.requestId ?? null,
  });
  // a rule that starts in the past is caught up at once
  await generateDueExpenses(transaction, identity);
  return ruleReadModel(await readRule(transaction, identity, created.id));
}

async function lockRule(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: ExpenseRuleMutationInput
) {
  const [existing] = await transaction
    .select()
    .from(expenseRecurringRules)
    .where(
      and(
        eq(expenseRecurringRules.id, input.id),
        eq(expenseRecurringRules.organizationId, identity.organizationId)
      )
    )
    .limit(1)
    .for("update");
  if (!existing) {
    throw new ExpenseRuleNotFoundError();
  }
  if (existing.version !== input.expectedVersion) {
    throw new ExpenseRuleVersionConflictError();
  }
  return existing;
}

/**
 * Edits what future occurrences will look like. Frequency and start date are
 * fixed (a different calendar is a different rule), and nothing already
 * generated changes.
 */
export async function updateExpenseRule(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: UpdateExpenseRuleInput
) {
  requireExpenseCapability(identity);
  const existing = await lockRule(transaction, identity, input);
  const normalized = normalizeExpenseRuleTemplate({
    amount: input.amount,
    description: input.description,
    endsOn: input.endsOn,
    frequency: existing.frequency,
    payee: input.payee,
    startsOn: existing.startsOn,
  });
  const changed =
    normalized.amount !== existing.amount ||
    input.categoryId !== existing.categoryId ||
    normalized.description !== existing.description ||
    normalized.payee !== existing.payee ||
    normalized.endsOn !== existing.endsOn;
  if (!changed) {
    return {
      changed: false,
      rule: ruleReadModel(await readRule(transaction, identity, input.id)),
    };
  }
  if (input.categoryId !== existing.categoryId) {
    await requireActiveCategory(transaction, identity, input.categoryId);
  }
  const [updated] = await transaction
    .update(expenseRecurringRules)
    .set({
      amount: normalized.amount,
      categoryId: input.categoryId,
      description: normalized.description,
      endsOn: normalized.endsOn,
      payee: normalized.payee,
      updatedAt: new Date(),
      version: existing.version + 1,
    })
    .where(
      and(
        eq(expenseRecurringRules.id, input.id),
        eq(expenseRecurringRules.organizationId, identity.organizationId),
        eq(expenseRecurringRules.version, input.expectedVersion)
      )
    )
    .returning({ id: expenseRecurringRules.id });
  if (!updated) {
    throw new ExpenseRuleVersionConflictError();
  }
  await recordTenantAuditEvent(transaction, identity, {
    entityId: updated.id,
    entityType: "expense_rule",
    eventType: "expense_rule.updated",
    requestId: input.requestId ?? null,
  });
  return {
    changed: true,
    rule: ruleReadModel(await readRule(transaction, identity, input.id)),
  };
}

async function changeRuleLifecycle(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: ExpenseRuleMutationInput,
  action: "archive" | "restore"
) {
  requireExpenseCapability(identity);
  const existing = await lockRule(transaction, identity, input);
  const archived = existing.archivedAt !== null;
  if (archived === (action === "archive")) {
    return {
      changed: false,
      rule: ruleReadModel(await readRule(transaction, identity, input.id)),
    };
  }
  let { generatedCount } = existing;
  if (action === "archive") {
    // what already fell due is generated before pausing: a paused rule would
    // never generate it
    await generateForRule(
      transaction,
      identity,
      input.id,
      await organizationToday(transaction, identity)
    );
  } else if (isRecurrenceFrequency(existing.frequency)) {
    // the periods that passed while the rule was paused did not happen: they
    // are skipped, not generated afterwards. An occurrence on the day it is
    // resumed has not passed: the next read generates it.
    generatedCount = Math.max(
      generatedCount,
      occurrencesThrough(
        existing.startsOn,
        existing.frequency,
        dayBefore(await organizationToday(transaction, identity))
      )
    );
  }
  const [updated] = await transaction
    .update(expenseRecurringRules)
    .set({
      archivedAt: action === "archive" ? new Date() : null,
      // pausing keeps the count the generation above just advanced
      ...(action === "restore" ? { generatedCount } : {}),
      updatedAt: new Date(),
      version: existing.version + 1,
    })
    .where(
      and(
        eq(expenseRecurringRules.id, input.id),
        eq(expenseRecurringRules.organizationId, identity.organizationId),
        eq(expenseRecurringRules.version, input.expectedVersion)
      )
    )
    .returning({ id: expenseRecurringRules.id });
  if (!updated) {
    throw new ExpenseRuleVersionConflictError();
  }
  await recordTenantAuditEvent(transaction, identity, {
    entityId: updated.id,
    entityType: "expense_rule",
    eventType:
      action === "archive" ? "expense_rule.archived" : "expense_rule.restored",
    requestId: input.requestId ?? null,
  });
  return {
    changed: true,
    rule: ruleReadModel(await readRule(transaction, identity, input.id)),
  };
}

export function archiveExpenseRule(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: ExpenseRuleMutationInput
) {
  return changeRuleLifecycle(transaction, identity, input, "archive");
}

export function restoreExpenseRule(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: ExpenseRuleMutationInput
) {
  return changeRuleLifecycle(transaction, identity, input, "restore");
}
