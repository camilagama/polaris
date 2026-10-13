import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  type AnyPgColumn,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { activeTenantScope } from "./product";
import { organizations } from "./organization";

const runtimeRole = "polaris_pr11_runtime";

function validFeeConfiguration(
  mode: AnyPgColumn,
  fixedAmount: AnyPgColumn,
  percentage: AnyPgColumn
) {
  return sql`
    (
      ${mode} IN ('unknown', 'none')
      AND ${fixedAmount} IS NULL
      AND ${percentage} IS NULL
    )
    OR (
      ${mode} = 'fixed'
      AND ${fixedAmount} IS NOT NULL
      AND ${fixedAmount} >= 0
      AND scale(${fixedAmount}) <= 2
      AND ${fixedAmount} < 1000000000000000000
      AND ${percentage} IS NULL
    )
    OR (
      ${mode} = 'percentage'
      AND ${fixedAmount} IS NULL
      AND ${percentage} IS NOT NULL
      AND ${percentage} >= 0
      AND scale(${percentage}) <= 6
      AND ${percentage} < 'Infinity'
    )
    OR (
      ${mode} = 'fixed_and_percentage'
      AND ${fixedAmount} IS NOT NULL
      AND ${fixedAmount} >= 0
      AND scale(${fixedAmount}) <= 2
      AND ${fixedAmount} < 1000000000000000000
      AND ${percentage} IS NOT NULL
      AND ${percentage} >= 0
      AND scale(${percentage}) <= 6
      AND ${percentage} < 'Infinity'
    )
  `;
}

export const paymentProfiles = pgTable(
  "payment_profiles",
  {
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    name: text("name").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    version: integer("version").default(1).notNull(),
  },
  (table) => [
    check(
      "payment_profiles_name_valid",
      sql`char_length(btrim(${table.name})) BETWEEN 1 AND 100`
    ),
    check("payment_profiles_version_positive", sql`${table.version} >= 1`),
    uniqueIndex("payment_profiles_organization_id_id_unique").on(
      table.organizationId,
      table.id
    ),
    index("payment_profiles_organization_archive_name_idx").on(
      table.organizationId,
      table.archivedAt,
      table.name,
      table.id
    ),
    pgPolicy("payment_profiles_current_tenant_select", {
      for: "select",
      to: runtimeRole,
      using: activeTenantScope(table.organizationId),
    }),
    pgPolicy("payment_profiles_current_tenant_insert", {
      for: "insert",
      to: runtimeRole,
      withCheck: activeTenantScope(table.organizationId),
    }),
    pgPolicy("payment_profiles_current_tenant_update", {
      for: "update",
      to: runtimeRole,
      using: activeTenantScope(table.organizationId),
      withCheck: activeTenantScope(table.organizationId),
    }),
  ]
).enableRLS();

export const paymentProfileRules = pgTable(
  "payment_profile_rules",
  {
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    anticipationFeeFixedAmount: numeric("anticipation_fee_fixed_amount"),
    anticipationFeeMode: text("anticipation_fee_mode").notNull(),
    anticipationFeePercentage: numeric("anticipation_fee_percentage"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expectedSettlementDays: integer("expected_settlement_days"),
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    installmentPlan: text("installment_plan"),
    installments: integer("installments"),
    method: text("method").notNull(),
    organizationId: text("organization_id").notNull(),
    paymentProfileId: uuid("payment_profile_id").notNull(),
    processingFeeFixedAmount: numeric("processing_fee_fixed_amount"),
    processingFeeMode: text("processing_fee_mode").notNull(),
    processingFeePercentage: numeric("processing_fee_percentage"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      "payment_profile_rules_method_allowed",
      sql`${table.method} IN ('pix', 'cash', 'credit_card', 'debit_card', 'bank_transfer', 'other')`
    ),
    check(
      "payment_profile_rules_installments_allowed",
      sql`
        (
          ${table.method} = 'credit_card'
          AND ${table.installmentPlan} IS NOT NULL
          AND ${table.installmentPlan} IN ('merchant', 'issuer')
          AND ${table.installments} IS NOT NULL
          AND ${table.installments} >= 1
        )
        OR (
          ${table.method} <> 'credit_card'
          AND ${table.installmentPlan} IS NULL
          AND ${table.installments} IS NULL
        )
      `
    ),
    check(
      "payment_profile_rules_expected_settlement_days_nonnegative",
      sql`${table.expectedSettlementDays} IS NULL OR ${table.expectedSettlementDays} >= 0`
    ),
    check(
      "payment_profile_rules_processing_fee_valid",
      validFeeConfiguration(
        table.processingFeeMode,
        table.processingFeeFixedAmount,
        table.processingFeePercentage
      )
    ),
    check(
      "payment_profile_rules_anticipation_fee_valid",
      validFeeConfiguration(
        table.anticipationFeeMode,
        table.anticipationFeeFixedAmount,
        table.anticipationFeePercentage
      )
    ),
    foreignKey({
      columns: [table.organizationId, table.paymentProfileId],
      foreignColumns: [paymentProfiles.organizationId, paymentProfiles.id],
      name: "payment_profile_rules_organization_profile_fk",
    }).onDelete("restrict"),
    uniqueIndex("payment_profile_rules_organization_profile_id_unique").on(
      table.organizationId,
      table.paymentProfileId,
      table.id
    ),
    uniqueIndex("payment_profile_rules_credit_card_key_unique")
      .on(
        table.organizationId,
        table.paymentProfileId,
        table.installmentPlan,
        table.installments
      )
      .where(
        sql`${table.method} = 'credit_card' AND ${table.archivedAt} IS NULL`
      ),
    uniqueIndex("payment_profile_rules_other_method_key_unique")
      .on(table.organizationId, table.paymentProfileId, table.method)
      .where(
        sql`${table.method} <> 'credit_card' AND ${table.archivedAt} IS NULL`
      ),
    index("payment_profile_rules_organization_profile_archive_idx").on(
      table.organizationId,
      table.paymentProfileId,
      table.archivedAt,
      table.method,
      table.installments
    ),
    pgPolicy("payment_profile_rules_current_tenant_select", {
      for: "select",
      to: runtimeRole,
      using: activeTenantScope(table.organizationId),
    }),
    pgPolicy("payment_profile_rules_current_tenant_insert", {
      for: "insert",
      to: runtimeRole,
      withCheck: activeTenantScope(table.organizationId),
    }),
    pgPolicy("payment_profile_rules_current_tenant_update", {
      for: "update",
      to: runtimeRole,
      using: activeTenantScope(table.organizationId),
      withCheck: activeTenantScope(table.organizationId),
    }),
  ]
).enableRLS();
