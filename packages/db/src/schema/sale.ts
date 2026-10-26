import { sql } from "drizzle-orm";
import {
  boolean,
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
  type AnyPgColumn,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organization";
import { activeTenantScope, productVariants, products } from "./product";
import { paymentProfileRules, paymentProfiles } from "./payment-profile";

const runtimeRole = "polaris_pr11_runtime";

function validFeeSnapshot(
  mode: AnyPgColumn,
  amount: AnyPgColumn,
  fixedAmount: AnyPgColumn,
  percentage: AnyPgColumn,
  allowNotApplicable: boolean
) {
  return sql`
    (
      ${mode} = 'unknown'
      AND ${amount} IS NULL
      AND ${fixedAmount} IS NULL
      AND ${percentage} IS NULL
    )
    OR (
      ${mode} = 'none'
      AND ${amount} = 0
      AND ${fixedAmount} IS NULL
      AND ${percentage} IS NULL
    )
    OR (
      ${mode} = 'fixed'
      AND ${amount} IS NOT NULL
      AND ${amount} >= 0
      AND scale(${amount}) <= 2
      AND ${amount} < 1000000000000000000
      AND ${fixedAmount} IS NOT NULL
      AND ${fixedAmount} >= 0
      AND scale(${fixedAmount}) <= 2
      AND ${fixedAmount} < 1000000000000000000
      AND ${percentage} IS NULL
    )
    OR (
      ${mode} = 'percentage'
      AND ${amount} IS NOT NULL
      AND ${amount} >= 0
      AND scale(${amount}) <= 2
      AND ${amount} < 1000000000000000000
      AND ${fixedAmount} IS NULL
      AND ${percentage} IS NOT NULL
      AND ${percentage} >= 0
      AND scale(${percentage}) <= 6
      AND ${percentage} < 'Infinity'
    )
    OR (
      ${mode} = 'fixed_and_percentage'
      AND ${amount} IS NOT NULL
      AND ${amount} >= 0
      AND scale(${amount}) <= 2
      AND ${amount} < 1000000000000000000
      AND ${fixedAmount} IS NOT NULL
      AND ${fixedAmount} >= 0
      AND scale(${fixedAmount}) <= 2
      AND ${fixedAmount} < 1000000000000000000
      AND ${percentage} IS NOT NULL
      AND ${percentage} >= 0
      AND scale(${percentage}) <= 6
      AND ${percentage} < 'Infinity'
    )
    ${
      allowNotApplicable
        ? sql`OR (
      ${mode} = 'not_applicable'
      AND ${amount} = 0
      AND ${fixedAmount} IS NULL
      AND ${percentage} IS NULL
    )`
        : sql``
    }
  `;
}

export const sales = pgTable(
  "sales",
  {
    adjustmentCount: integer("adjustment_count").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }),
    commandId: uuid("command_id").notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true })
      .default(sql`clock_timestamp()`)
      .notNull(),
    currency: text("currency").default("BRL").notNull(),
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    itemCount: integer("item_count").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    occurredOn: date("occurred_on", { mode: "string" }).notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
  },
  (table) => [
    check("sales_currency_brl", sql`${table.currency} = 'BRL'`),
    check("sales_item_count_positive", sql`${table.itemCount} >= 1`),
    check(
      "sales_adjustment_count_nonnegative",
      sql`${table.adjustmentCount} >= 0`
    ),
    uniqueIndex("sales_organization_id_id_unique").on(
      table.organizationId,
      table.id
    ),
    uniqueIndex("sales_organization_command_unique").on(
      table.organizationId,
      table.commandId
    ),
    index("sales_organization_confirmed_idx").on(
      table.organizationId,
      table.confirmedAt,
      table.id
    ),
    index("sales_organization_occurred_on_idx").on(
      table.organizationId,
      table.occurredOn
    ),
    pgPolicy("sales_current_tenant_select", {
      for: "select",
      to: runtimeRole,
      using: activeTenantScope(table.organizationId),
    }),
    pgPolicy("sales_current_tenant_insert", {
      for: "insert",
      to: runtimeRole,
      withCheck: activeTenantScope(table.organizationId),
    }),
  ]
).enableRLS();

export const saleItems = pgTable(
  "sale_items",
  {
    chargedUnitPrice: numeric("charged_unit_price").notNull(),
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    listedUnitPrice: numeric("listed_unit_price").notNull(),
    organizationId: text("organization_id").notNull(),
    position: integer("position").notNull(),
    productId: uuid("product_id").notNull(),
    productLabel: text("product_label").notNull(),
    quantity: integer("quantity").notNull(),
    saleId: uuid("sale_id").notNull(),
    unitCost: numeric("unit_cost"),
    variantId: uuid("variant_id").notNull(),
  },
  (table) => [
    check("sale_items_position_nonnegative", sql`${table.position} >= 0`),
    check(
      "sale_items_product_label_not_blank",
      sql`char_length(btrim(${table.productLabel})) >= 1`
    ),
    check("sale_items_quantity_positive", sql`${table.quantity} >= 1`),
    check(
      "sale_items_listed_unit_price_allowed",
      sql`
        ${table.listedUnitPrice} >= 0
        AND scale(${table.listedUnitPrice}) <= 2
        AND ${table.listedUnitPrice} < 1000000000000000000
      `
    ),
    check(
      "sale_items_charged_unit_price_allowed",
      sql`
        ${table.chargedUnitPrice} >= 0
        AND scale(${table.chargedUnitPrice}) <= 2
        AND ${table.chargedUnitPrice} < 1000000000000000000
      `
    ),
    check(
      "sale_items_unit_cost_allowed",
      sql`
        ${table.unitCost} IS NULL OR (
          ${table.unitCost} >= 0
          AND scale(${table.unitCost}) <= 6
          AND ${table.unitCost} < 1000000000000000000
        )
      `
    ),
    foreignKey({
      columns: [table.organizationId, table.saleId],
      foreignColumns: [sales.organizationId, sales.id],
      name: "sale_items_organization_sale_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.productId],
      foreignColumns: [products.organizationId, products.id],
      name: "sale_items_organization_product_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.productId, table.variantId],
      foreignColumns: [
        productVariants.organizationId,
        productVariants.productId,
        productVariants.id,
      ],
      name: "sale_items_variant_fk",
    }).onDelete("restrict"),
    uniqueIndex("sale_items_organization_sale_position_unique").on(
      table.organizationId,
      table.saleId,
      table.position
    ),
    index("sale_items_organization_variant_idx").on(
      table.organizationId,
      table.variantId,
      table.saleId
    ),
    pgPolicy("sale_items_current_tenant_select", {
      for: "select",
      to: runtimeRole,
      using: activeTenantScope(table.organizationId),
    }),
    pgPolicy("sale_items_current_tenant_insert", {
      for: "insert",
      to: runtimeRole,
      withCheck: activeTenantScope(table.organizationId),
    }),
  ]
).enableRLS();

export const saleAdjustments = pgTable(
  "sale_adjustments",
  {
    amount: numeric("amount").notNull(),
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    kind: text("kind").notNull(),
    organizationId: text("organization_id").notNull(),
    percentage: numeric("percentage"),
    position: integer("position").notNull(),
    saleId: uuid("sale_id").notNull(),
    valueType: text("value_type").notNull(),
  },
  (table) => [
    check(
      "sale_adjustments_kind_allowed",
      sql`${table.kind} IN ('discount', 'surcharge', 'freight', 'payment_surcharge')`
    ),
    check(
      "sale_adjustments_value_type_allowed",
      sql`${table.valueType} IN ('fixed', 'percentage')`
    ),
    check("sale_adjustments_position_nonnegative", sql`${table.position} >= 0`),
    check(
      "sale_adjustments_amount_allowed",
      sql`
        ${table.amount} >= 0
        AND scale(${table.amount}) <= 2
        AND ${table.amount} < 1000000000000000000
      `
    ),
    check(
      "sale_adjustments_value_allowed",
      sql`
        (
          ${table.valueType} = 'fixed'
          AND ${table.percentage} IS NULL
        )
        OR (
          ${table.valueType} = 'percentage'
          AND ${table.kind} IN ('discount', 'surcharge')
          AND ${table.percentage} IS NOT NULL
          AND ${table.percentage} >= 0
          AND scale(${table.percentage}) <= 6
          AND ${table.percentage} < 'Infinity'
        )
      `
    ),
    foreignKey({
      columns: [table.organizationId, table.saleId],
      foreignColumns: [sales.organizationId, sales.id],
      name: "sale_adjustments_organization_sale_fk",
    }).onDelete("restrict"),
    uniqueIndex("sale_adjustments_organization_sale_position_unique").on(
      table.organizationId,
      table.saleId,
      table.position
    ),
    pgPolicy("sale_adjustments_current_tenant_select", {
      for: "select",
      to: runtimeRole,
      using: activeTenantScope(table.organizationId),
    }),
    pgPolicy("sale_adjustments_current_tenant_insert", {
      for: "insert",
      to: runtimeRole,
      withCheck: activeTenantScope(table.organizationId),
    }),
  ]
).enableRLS();

export const salePayments = pgTable(
  "sale_payments",
  {
    anticipationFeeAmountSnapshot: numeric(
      "anticipation_fee_amount_snapshot"
    ).default("0.00"),
    anticipationFeeFixedAmountSnapshot: numeric(
      "anticipation_fee_fixed_amount_snapshot"
    ),
    anticipationFeeModeSnapshot: text("anticipation_fee_mode_snapshot")
      .default("not_applicable")
      .notNull(),
    anticipationFeePercentageSnapshot: numeric(
      "anticipation_fee_percentage_snapshot"
    ),
    anticipationRequested: boolean("anticipation_requested")
      .default(false)
      .notNull(),
    amount: numeric("amount").notNull(),
    expectedSettlementDaysSnapshot: integer(
      "expected_settlement_days_snapshot"
    ),
    installmentPlan: text("installment_plan"),
    installmentPlanUnknown: boolean("installment_plan_unknown")
      .default(false)
      .notNull(),
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    installments: integer("installments"),
    method: text("method").notNull(),
    organizationId: text("organization_id").notNull(),
    paymentProfileId: uuid("payment_profile_id"),
    paymentProfileNameSnapshot: text("payment_profile_name_snapshot"),
    paymentProfileRuleIdSnapshot: uuid("payment_profile_rule_id_snapshot"),
    paymentProfileVersionSnapshot: integer("payment_profile_version_snapshot"),
    processingFeeAmountSnapshot: numeric("processing_fee_amount_snapshot"),
    processingFeeFixedAmountSnapshot: numeric(
      "processing_fee_fixed_amount_snapshot"
    ),
    processingFeeModeSnapshot: text("processing_fee_mode_snapshot")
      .default("unknown")
      .notNull(),
    processingFeePercentageSnapshot: numeric(
      "processing_fee_percentage_snapshot"
    ),
    saleId: uuid("sale_id").notNull(),
  },
  (table) => [
    check(
      "sale_payments_method_allowed",
      sql`${table.method} IN ('pix', 'cash', 'credit_card', 'debit_card', 'bank_transfer', 'other')`
    ),
    check(
      "sale_payments_amount_allowed",
      sql`
        ${table.amount} >= 0
        AND scale(${table.amount}) <= 2
        AND ${table.amount} < 1000000000000000000
      `
    ),
    check(
      "sale_payments_installments_allowed",
      sql`
        (
          ${table.method} = 'credit_card'
          AND ${table.installments} IS NOT NULL
          AND ${table.installments} >= 1
          AND (
            (
              ${table.installmentPlan} IS NOT NULL
              AND ${table.installmentPlan} IN ('merchant', 'issuer')
              AND ${table.installmentPlanUnknown} = false
            )
            OR (
              ${table.installmentPlan} IS NULL
              AND ${table.installmentPlanUnknown} = true
            )
          )
        )
        OR (
          ${table.method} <> 'credit_card'
          AND ${table.installments} IS NULL
          AND ${table.installmentPlan} IS NULL
          AND ${table.installmentPlanUnknown} = false
          AND ${table.anticipationRequested} = false
        )
      `
    ),
    check(
      "sale_payments_profile_snapshot_valid",
      sql`
        (
          ${table.paymentProfileId} IS NULL
          AND ${table.paymentProfileNameSnapshot} IS NULL
          AND ${table.paymentProfileVersionSnapshot} IS NULL
          AND ${table.paymentProfileRuleIdSnapshot} IS NULL
        )
        OR (
          ${table.paymentProfileId} IS NOT NULL
          AND ${table.paymentProfileNameSnapshot} IS NOT NULL
          AND char_length(btrim(${table.paymentProfileNameSnapshot})) >= 1
          AND ${table.paymentProfileVersionSnapshot} IS NOT NULL
          AND ${table.paymentProfileVersionSnapshot} >= 1
        )
      `
    ),
    check(
      "sale_payments_fee_snapshot_requires_profile_rule",
      sql`
        ${table.paymentProfileRuleIdSnapshot} IS NOT NULL
        OR (
          ${table.processingFeeModeSnapshot} = 'unknown'
          AND ${table.expectedSettlementDaysSnapshot} IS NULL
          AND (
            ${table.anticipationRequested} = false
            OR ${table.anticipationFeeModeSnapshot} = 'unknown'
          )
        )
      `
    ),
    check(
      "sale_payments_processing_fee_snapshot_valid",
      validFeeSnapshot(
        table.processingFeeModeSnapshot,
        table.processingFeeAmountSnapshot,
        table.processingFeeFixedAmountSnapshot,
        table.processingFeePercentageSnapshot,
        false
      )
    ),
    check(
      "sale_payments_anticipation_fee_snapshot_valid",
      validFeeSnapshot(
        table.anticipationFeeModeSnapshot,
        table.anticipationFeeAmountSnapshot,
        table.anticipationFeeFixedAmountSnapshot,
        table.anticipationFeePercentageSnapshot,
        true
      )
    ),
    check(
      "sale_payments_anticipation_snapshot_matches_request",
      sql`
        (
          ${table.anticipationRequested} = true
          AND ${table.method} = 'credit_card'
          AND ${table.anticipationFeeModeSnapshot} <> 'not_applicable'
        )
        OR (
          ${table.anticipationRequested} = false
          AND ${table.anticipationFeeModeSnapshot} = 'not_applicable'
          AND ${table.anticipationFeeAmountSnapshot} = 0
        )
      `
    ),
    check(
      "sale_payments_expected_settlement_days_nonnegative",
      sql`${table.expectedSettlementDaysSnapshot} IS NULL OR ${table.expectedSettlementDaysSnapshot} >= 0`
    ),
    foreignKey({
      columns: [table.organizationId, table.saleId],
      foreignColumns: [sales.organizationId, sales.id],
      name: "sale_payments_organization_sale_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.paymentProfileId],
      foreignColumns: [paymentProfiles.organizationId, paymentProfiles.id],
      name: "sale_payments_organization_profile_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.organizationId,
        table.paymentProfileId,
        table.paymentProfileRuleIdSnapshot,
      ],
      foreignColumns: [
        paymentProfileRules.organizationId,
        paymentProfileRules.paymentProfileId,
        paymentProfileRules.id,
      ],
      name: "sale_payments_profile_rule_snapshot_fk",
    }).onDelete("restrict"),
    uniqueIndex("sale_payments_organization_sale_unique").on(
      table.organizationId,
      table.saleId
    ),
    pgPolicy("sale_payments_current_tenant_select", {
      for: "select",
      to: runtimeRole,
      using: activeTenantScope(table.organizationId),
    }),
    pgPolicy("sale_payments_current_tenant_insert", {
      for: "insert",
      to: runtimeRole,
      withCheck: activeTenantScope(table.organizationId),
    }),
  ]
).enableRLS();
