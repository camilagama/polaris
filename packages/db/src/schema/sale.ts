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
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organization";
import { activeTenantScope, productVariants, products } from "./product";

const runtimeRole = "polaris_pr11_runtime";

export const sales = pgTable(
  "sales",
  {
    commandId: uuid("command_id").notNull(),
    confirmedAt: timestamp("confirmed_at").defaultNow().notNull(),
    currency: text("currency").default("BRL").notNull(),
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
  },
  (table) => [
    check("sales_currency_brl", sql`${table.currency} = 'BRL'`),
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
    pgPolicy("sales_current_tenant_select", {
      for: "select",
      to: runtimeRole,
      using: activeTenantScope(table.organizationId),
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
  ]
).enableRLS();

export const salePayments = pgTable(
  "sale_payments",
  {
    amount: numeric("amount").notNull(),
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    installments: integer("installments"),
    method: text("method").notNull(),
    organizationId: text("organization_id").notNull(),
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
        )
        OR (
          ${table.method} <> 'credit_card'
          AND ${table.installments} IS NULL
        )
      `
    ),
    foreignKey({
      columns: [table.organizationId, table.saleId],
      foreignColumns: [sales.organizationId, sales.id],
      name: "sale_payments_organization_sale_fk",
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
  ]
).enableRLS();
