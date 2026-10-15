import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organization";
import { activeTenantScope } from "./product";
import { sales } from "./sale";

const runtimeRole = "polaris_pr11_runtime";

/**
 * What the organization classifies expenses with (plan PR63). The five groups
 * are fixed (`group_key`); the categories inside them belong to the
 * organization. An expense has exactly one category. Categories are archived,
 * never deleted: expenses keep pointing at them.
 */
export const expenseCategories = pgTable(
  "expense_categories",
  {
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    groupKey: text("group_key").notNull(),
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    name: text("name").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Set only on the categories an organization started with. */
    systemKey: text("system_key"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    version: integer("version").default(1).notNull(),
  },
  (table) => {
    const tenantScope = activeTenantScope(table.organizationId);
    return [
      check(
        "expense_categories_group_allowed",
        sql`${table.groupKey} IN ('commercial', 'operational', 'financial', 'taxes', 'other')`
      ),
      check(
        "expense_categories_name_allowed",
        sql`char_length(btrim(${table.name})) >= 1 AND char_length(${table.name}) <= 100`
      ),
      check("expense_categories_version_positive", sql`${table.version} >= 1`),
      uniqueIndex("expense_categories_organization_id_id_unique").on(
        table.organizationId,
        table.id
      ),
      // One name per organization, whatever the group and the letter case.
      uniqueIndex("expense_categories_organization_name_unique").on(
        table.organizationId,
        sql`lower(${table.name})`
      ),
      uniqueIndex("expense_categories_organization_system_key_unique")
        .on(table.organizationId, table.systemKey)
        .where(sql`${table.systemKey} IS NOT NULL`),
      index("expense_categories_organization_list_idx").on(
        table.organizationId,
        table.archivedAt,
        table.groupKey,
        table.name
      ),
      pgPolicy("expense_categories_current_tenant_select", {
        for: "select",
        to: runtimeRole,
        using: tenantScope,
      }),
      pgPolicy("expense_categories_current_tenant_insert", {
        for: "insert",
        to: runtimeRole,
        withCheck: tenantScope,
      }),
      pgPolicy("expense_categories_current_tenant_update", {
        for: "update",
        to: runtimeRole,
        using: tenantScope,
        withCheck: tenantScope,
      }),
    ];
  }
).enableRLS();

/**
 * A recurring expense (plan PR65): a template that produces ordinary expenses on
 * a calendar. `frequency` and `starts_on` never change (occurrence N is the Nth
 * step from the start); amount, category, text, end date and pause may, and only
 * affect occurrences not generated yet. `generated_count` is how many
 * occurrences were produced (the next one has that index).
 */
export const expenseRecurringRules = pgTable(
  "expense_recurring_rules",
  {
    amount: numeric("amount").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    categoryId: uuid("category_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    description: text("description").notNull(),
    endsOn: date("ends_on", { mode: "string" }),
    frequency: text("frequency").notNull(),
    generatedCount: integer("generated_count").default(0).notNull(),
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    payee: text("payee"),
    startsOn: date("starts_on", { mode: "string" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    version: integer("version").default(1).notNull(),
  },
  (table) => {
    const tenantScope = activeTenantScope(table.organizationId);
    return [
      check(
        "expense_recurring_rules_amount_allowed",
        sql`
          ${table.amount} > 0
          AND scale(${table.amount}) <= 2
          AND ${table.amount} < 1000000000000000000
        `
      ),
      check(
        "expense_recurring_rules_text_limits",
        sql`
          char_length(btrim(${table.description})) >= 1
          AND char_length(${table.description}) <= 200
          AND (${table.payee} IS NULL OR (char_length(btrim(${table.payee})) >= 1 AND char_length(${table.payee}) <= 120))
        `
      ),
      check(
        "expense_recurring_rules_frequency_allowed",
        sql`${table.frequency} IN ('weekly', 'monthly', 'yearly')`
      ),
      check(
        "expense_recurring_rules_dates_allowed",
        sql`
          ${table.startsOn} >= DATE '2000-01-01'
          AND (${table.endsOn} IS NULL OR ${table.endsOn} >= ${table.startsOn})
        `
      ),
      check(
        "expense_recurring_rules_counters_allowed",
        sql`${table.generatedCount} >= 0 AND ${table.version} >= 1`
      ),
      foreignKey({
        columns: [table.organizationId, table.categoryId],
        foreignColumns: [
          expenseCategories.organizationId,
          expenseCategories.id,
        ],
        name: "expense_recurring_rules_organization_category_fk",
      }).onDelete("restrict"),
      uniqueIndex("expense_recurring_rules_organization_id_id_unique").on(
        table.organizationId,
        table.id
      ),
      index("expense_recurring_rules_organization_list_idx").on(
        table.organizationId,
        table.archivedAt,
        table.startsOn
      ),
      pgPolicy("expense_recurring_rules_current_tenant_select", {
        for: "select",
        to: runtimeRole,
        using: tenantScope,
      }),
      pgPolicy("expense_recurring_rules_current_tenant_insert", {
        for: "insert",
        to: runtimeRole,
        withCheck: tenantScope,
      }),
      pgPolicy("expense_recurring_rules_current_tenant_update", {
        for: "update",
        to: runtimeRole,
        using: tenantScope,
        withCheck: tenantScope,
      }),
    ];
  }
).enableRLS();

/**
 * An operating expense by competence (plan PR64): the period it belongs to, not
 * when it was paid. `sale_id` ties it to one sale so it enters that sale's
 * margin (PR66). A mistaken expense is voided (`voided_at`), never deleted.
 */
export const expenses = pgTable(
  "expenses",
  {
    amount: numeric("amount").notNull(),
    categoryId: uuid("category_id").notNull(),
    competenceOn: date("competence_on", { mode: "string" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    description: text("description").notNull(),
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    payee: text("payee"),
    /** Set only on the occurrences a recurring rule generated. */
    recurringOccurrence: integer("recurring_occurrence"),
    recurringRuleId: uuid("recurring_rule_id"),
    saleId: uuid("sale_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    version: integer("version").default(1).notNull(),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
  },
  (table) => {
    const tenantScope = activeTenantScope(table.organizationId);
    return [
      check(
        "expenses_amount_allowed",
        sql`
          ${table.amount} > 0
          AND scale(${table.amount}) <= 2
          AND ${table.amount} < 1000000000000000000
        `
      ),
      check(
        "expenses_text_limits",
        sql`
          char_length(btrim(${table.description})) >= 1
          AND char_length(${table.description}) <= 200
          AND (${table.payee} IS NULL OR (char_length(btrim(${table.payee})) >= 1 AND char_length(${table.payee}) <= 120))
        `
      ),
      check(
        "expenses_competence_allowed",
        sql`${table.competenceOn} >= DATE '2000-01-01'`
      ),
      check("expenses_version_positive", sql`${table.version} >= 1`),
      check(
        "expenses_recurring_origin_coherent",
        sql`
          (${table.recurringRuleId} IS NULL AND ${table.recurringOccurrence} IS NULL)
          OR (${table.recurringRuleId} IS NOT NULL AND ${table.recurringOccurrence} IS NOT NULL AND ${table.recurringOccurrence} >= 0)
        `
      ),
      foreignKey({
        columns: [table.organizationId, table.recurringRuleId],
        foreignColumns: [
          expenseRecurringRules.organizationId,
          expenseRecurringRules.id,
        ],
        name: "expenses_organization_recurring_rule_fk",
      }).onDelete("restrict"),
      // each occurrence of a rule exists once: generation is idempotent
      uniqueIndex("expenses_recurring_occurrence_unique")
        .on(table.recurringRuleId, table.recurringOccurrence)
        .where(sql`${table.recurringRuleId} IS NOT NULL`),
      foreignKey({
        columns: [table.organizationId, table.categoryId],
        foreignColumns: [
          expenseCategories.organizationId,
          expenseCategories.id,
        ],
        name: "expenses_organization_category_fk",
      }).onDelete("restrict"),
      foreignKey({
        columns: [table.organizationId, table.saleId],
        foreignColumns: [sales.organizationId, sales.id],
        name: "expenses_organization_sale_fk",
      }).onDelete("restrict"),
      uniqueIndex("expenses_organization_id_id_unique").on(
        table.organizationId,
        table.id
      ),
      index("expenses_organization_competence_idx").on(
        table.organizationId,
        table.competenceOn,
        table.id
      ),
      index("expenses_organization_category_idx").on(
        table.organizationId,
        table.categoryId
      ),
      index("expenses_organization_sale_idx")
        .on(table.organizationId, table.saleId)
        .where(sql`${table.saleId} IS NOT NULL`),
      pgPolicy("expenses_current_tenant_select", {
        for: "select",
        to: runtimeRole,
        using: tenantScope,
      }),
      pgPolicy("expenses_current_tenant_insert", {
        for: "insert",
        to: runtimeRole,
        withCheck: tenantScope,
      }),
      pgPolicy("expenses_current_tenant_update", {
        for: "update",
        to: runtimeRole,
        using: tenantScope,
        withCheck: tenantScope,
      }),
    ];
  }
).enableRLS();
