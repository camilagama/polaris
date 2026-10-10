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
  primaryKey,
  text,
  timestamp,
  type AnyPgColumn,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { activeTenantScope, productVariants } from "./product";

const runtimeRole = "polaris_pr11_runtime";

const inventoryVariantTenantScope = (table: {
  organizationId: AnyPgColumn;
  productId: AnyPgColumn;
  variantId: AnyPgColumn;
}) => sql`
  ${activeTenantScope(table.organizationId)}
  AND EXISTS (
    SELECT 1
    FROM public.product_variants AS variant_scope
    INNER JOIN public.products AS product_scope
      ON product_scope.id = variant_scope.product_id
     AND product_scope.organization_id = variant_scope.organization_id
    WHERE variant_scope.id = ${table.variantId}
      AND variant_scope.organization_id = ${table.organizationId}
      AND variant_scope.product_id = ${table.productId}
  )
`;

export const inventoryBalances = pgTable(
  "inventory_balances",
  {
    movingAverageCost: numeric("moving_average_cost"),
    organizationId: text("organization_id").notNull(),
    productId: uuid("product_id").notNull(),
    quantity: integer("quantity").default(0).notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    variantId: uuid("variant_id").notNull(),
    version: integer("version").default(1).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.variantId],
      name: "inventory_balances_pk",
    }),
    check(
      "inventory_balances_quantity_nonnegative",
      sql`${table.quantity} >= 0`
    ),
    check("inventory_balances_version_positive", sql`${table.version} >= 1`),
    check(
      "inventory_balances_average_cost_allowed",
      sql`
        ${table.movingAverageCost} IS NULL OR (
          ${table.movingAverageCost} >= 0
          AND scale(${table.movingAverageCost}) <= 6
          AND ${table.movingAverageCost} < 1000000000000000000
        )
      `
    ),
    foreignKey({
      columns: [table.organizationId, table.productId, table.variantId],
      foreignColumns: [
        productVariants.organizationId,
        productVariants.productId,
        productVariants.id,
      ],
      name: "inventory_balances_variant_fk",
    }).onDelete("restrict"),
    index("inventory_balances_organization_product_idx").on(
      table.organizationId,
      table.productId
    ),
    pgPolicy("inventory_balances_current_tenant_select", {
      for: "select",
      to: runtimeRole,
      using: inventoryVariantTenantScope(table),
    }),
    pgPolicy("inventory_balances_current_tenant_insert", {
      for: "insert",
      to: runtimeRole,
      withCheck: inventoryVariantTenantScope(table),
    }),
    pgPolicy("inventory_balances_current_tenant_update", {
      for: "update",
      to: runtimeRole,
      using: inventoryVariantTenantScope(table),
      withCheck: inventoryVariantTenantScope(table),
    }),
  ]
).enableRLS();

export const stockMovements = pgTable(
  "stock_movements",
  {
    commandId: uuid("command_id"),
    commandIndex: integer("command_index").default(0).notNull(),
    commandVersion: integer("command_version"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    movementType: text("movement_type").notNull(),
    organizationId: text("organization_id").notNull(),
    occurredOn: date("occurred_on", { mode: "string" }),
    productId: uuid("product_id").notNull(),
    quantityDelta: integer("quantity_delta").notNull(),
    unitCost: numeric("unit_cost"),
    variantId: uuid("variant_id").notNull(),
  },
  (table) => [
    check(
      "stock_movements_type_allowed",
      sql`${table.movementType} IN ('receipt', 'write_off', 'inventory_count', 'sale', 'sale_cancellation', 'sale_return')`
    ),
    check(
      "stock_movements_quantity_delta_nonzero",
      sql`${table.quantityDelta} <> 0`
    ),
    check(
      "stock_movements_type_direction",
      sql`
        (${table.movementType} = 'receipt' AND ${table.quantityDelta} > 0)
        OR (${table.movementType} = 'write_off' AND ${table.quantityDelta} < 0)
        OR (${table.movementType} = 'inventory_count' AND ${table.quantityDelta} <> 0)
        OR (${table.movementType} = 'sale' AND ${table.quantityDelta} < 0)
        OR (${table.movementType} = 'sale_cancellation' AND ${table.quantityDelta} > 0)
        OR (${table.movementType} = 'sale_return' AND ${table.quantityDelta} > 0)
      `
    ),
    check(
      "stock_movements_command_index_nonnegative",
      sql`${table.commandIndex} >= 0`
    ),
    check(
      "stock_movements_command_metadata_complete",
      sql`
        (
          ${table.commandId} IS NULL
          AND ${table.commandVersion} IS NULL
          AND ${table.occurredOn} IS NULL
          AND ${table.commandIndex} = 0
        )
        OR (
          ${table.commandId} IS NOT NULL
          AND ${table.commandVersion} IS NOT NULL
          AND ${table.commandVersion} >= 1
          AND ${table.occurredOn} IS NOT NULL
        )
      `
    ),
    check(
      "stock_movements_receipt_cost_and_command_required",
      sql`
        ${table.movementType} <> 'receipt'
        OR (
          ${table.unitCost} IS NOT NULL
          AND ${table.commandId} IS NOT NULL
        )
      `
    ),
    check(
      "stock_movements_unit_cost_allowed",
      sql`
        ${table.unitCost} IS NULL OR (
          ${table.unitCost} >= 0
          AND scale(${table.unitCost}) <= 6
          AND ${table.unitCost} < 1000000000000000000
        )
      `
    ),
    foreignKey({
      columns: [table.organizationId, table.productId, table.variantId],
      foreignColumns: [
        productVariants.organizationId,
        productVariants.productId,
        productVariants.id,
      ],
      name: "stock_movements_variant_fk",
    }).onDelete("restrict"),
    index("stock_movements_organization_variant_created_idx").on(
      table.organizationId,
      table.variantId,
      table.createdAt
    ),
    uniqueIndex("stock_movements_command_unique").on(
      table.organizationId,
      table.commandId,
      table.commandIndex
    ),
    pgPolicy("stock_movements_current_tenant_select", {
      for: "select",
      to: runtimeRole,
      using: inventoryVariantTenantScope(table),
    }),
    pgPolicy("stock_movements_current_tenant_insert", {
      for: "insert",
      to: runtimeRole,
      withCheck: inventoryVariantTenantScope(table),
    }),
  ]
).enableRLS();
