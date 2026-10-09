import { sql } from "drizzle-orm";
import {
  check,
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
    createdAt: timestamp("created_at").defaultNow().notNull(),
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    movementType: text("movement_type").notNull(),
    organizationId: text("organization_id").notNull(),
    productId: uuid("product_id").notNull(),
    quantityDelta: integer("quantity_delta").notNull(),
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
