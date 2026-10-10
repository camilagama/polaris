import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { activeTenantScope, productVariants, products } from "./product";

const runtimeRole = "polaris_pr11_runtime";

export const productOptions = pgTable(
  "product_options",
  {
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    name: text("name").notNull(),
    organizationId: text("organization_id").notNull(),
    position: integer("position").notNull(),
    productId: uuid("product_id").notNull(),
  },
  (table) => [
    check(
      "product_options_name_allowed",
      sql`${table.name} IN ('model', 'color', 'size')`
    ),
    check(
      "product_options_position_allowed",
      sql`
        (${table.name} = 'model' AND ${table.position} = 0)
        OR (${table.name} = 'color' AND ${table.position} = 1)
        OR (${table.name} = 'size' AND ${table.position} = 2)
      `
    ),
    foreignKey({
      columns: [table.organizationId, table.productId],
      foreignColumns: [products.organizationId, products.id],
      name: "product_options_organization_product_fk",
    }).onDelete("cascade"),
    uniqueIndex("product_options_product_name_unique").on(
      table.organizationId,
      table.productId,
      table.name
    ),
    uniqueIndex("product_options_product_position_unique").on(
      table.organizationId,
      table.productId,
      table.position
    ),
    uniqueIndex("product_options_organization_product_id_unique").on(
      table.organizationId,
      table.productId,
      table.id
    ),
    pgPolicy("product_options_current_tenant_select", {
      for: "select",
      to: runtimeRole,
      using: sql`
        ${activeTenantScope(table.organizationId)}
        AND EXISTS (
          SELECT 1 FROM public.products AS product_scope
          WHERE product_scope.id = ${table.productId}
            AND product_scope.organization_id = ${table.organizationId}
        )
      `,
    }),
    pgPolicy("product_options_current_tenant_insert", {
      for: "insert",
      to: runtimeRole,
      withCheck: sql`
        ${activeTenantScope(table.organizationId)}
        AND EXISTS (
          SELECT 1 FROM public.products AS product_scope
          WHERE product_scope.id = ${table.productId}
            AND product_scope.organization_id = ${table.organizationId}
            AND product_scope.variants_configured_at IS NULL
            AND product_scope.deleted_at IS NULL
        )
      `,
    }),
  ]
).enableRLS();

export const productOptionValues = pgTable(
  "product_option_values",
  {
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    name: text("name").notNull(),
    optionId: uuid("option_id").notNull(),
    organizationId: text("organization_id").notNull(),
    position: integer("position").notNull(),
    productId: uuid("product_id").notNull(),
  },
  (table) => [
    check(
      "product_option_values_name_not_blank",
      sql`char_length(btrim(${table.name})) >= 1`
    ),
    check(
      "product_option_values_position_nonnegative",
      sql`${table.position} >= 0`
    ),
    foreignKey({
      columns: [table.organizationId, table.productId, table.optionId],
      foreignColumns: [
        productOptions.organizationId,
        productOptions.productId,
        productOptions.id,
      ],
      name: "product_option_values_option_fk",
    }).onDelete("cascade"),
    uniqueIndex("product_option_values_option_position_unique").on(
      table.organizationId,
      table.productId,
      table.optionId,
      table.position
    ),
    uniqueIndex("product_option_values_option_id_unique").on(
      table.organizationId,
      table.productId,
      table.optionId,
      table.id
    ),
    uniqueIndex("product_option_values_option_name_unique").on(
      table.organizationId,
      table.productId,
      table.optionId,
      sql`lower(btrim(${table.name}))`
    ),
    pgPolicy("product_option_values_current_tenant_select", {
      for: "select",
      to: runtimeRole,
      using: sql`
        ${activeTenantScope(table.organizationId)}
        AND EXISTS (
          SELECT 1 FROM public.product_options AS option_scope
          WHERE option_scope.id = ${table.optionId}
            AND option_scope.organization_id = ${table.organizationId}
            AND option_scope.product_id = ${table.productId}
        )
      `,
    }),
    pgPolicy("product_option_values_current_tenant_insert", {
      for: "insert",
      to: runtimeRole,
      withCheck: sql`
        ${activeTenantScope(table.organizationId)}
        AND EXISTS (
          SELECT 1 FROM public.product_options AS option_scope
          INNER JOIN public.products AS product_scope
            ON product_scope.id = option_scope.product_id
           AND product_scope.organization_id = option_scope.organization_id
          WHERE option_scope.id = ${table.optionId}
            AND option_scope.organization_id = ${table.organizationId}
            AND option_scope.product_id = ${table.productId}
            AND product_scope.variants_configured_at IS NULL
            AND product_scope.deleted_at IS NULL
        )
      `,
    }),
  ]
).enableRLS();

export const variantOptionValues = pgTable(
  "variant_option_values",
  {
    optionId: uuid("option_id").notNull(),
    optionValueId: uuid("option_value_id").notNull(),
    organizationId: text("organization_id").notNull(),
    productId: uuid("product_id").notNull(),
    variantId: uuid("variant_id").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.organizationId,
        table.productId,
        table.variantId,
        table.optionId,
      ],
      name: "variant_option_values_pk",
    }),
    foreignKey({
      columns: [table.organizationId, table.productId, table.variantId],
      foreignColumns: [
        productVariants.organizationId,
        productVariants.productId,
        productVariants.id,
      ],
      name: "variant_option_values_variant_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId, table.productId, table.optionId],
      foreignColumns: [
        productOptions.organizationId,
        productOptions.productId,
        productOptions.id,
      ],
      name: "variant_option_values_option_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [
        table.organizationId,
        table.productId,
        table.optionId,
        table.optionValueId,
      ],
      foreignColumns: [
        productOptionValues.organizationId,
        productOptionValues.productId,
        productOptionValues.optionId,
        productOptionValues.id,
      ],
      name: "variant_option_values_value_fk",
    }).onDelete("cascade"),
    index("variant_option_values_option_value_idx").on(
      table.organizationId,
      table.productId,
      table.optionId,
      table.optionValueId
    ),
    pgPolicy("variant_option_values_current_tenant_select", {
      for: "select",
      to: runtimeRole,
      using: sql`
        ${activeTenantScope(table.organizationId)}
        AND EXISTS (
          SELECT 1 FROM public.products AS product_scope
          WHERE product_scope.id = ${table.productId}
            AND product_scope.organization_id = ${table.organizationId}
        )
      `,
    }),
    pgPolicy("variant_option_values_current_tenant_insert", {
      for: "insert",
      to: runtimeRole,
      withCheck: sql`
        ${activeTenantScope(table.organizationId)}
        AND EXISTS (
          SELECT 1 FROM public.products AS product_scope
          WHERE product_scope.id = ${table.productId}
            AND product_scope.organization_id = ${table.organizationId}
            AND product_scope.variants_configured_at IS NULL
            AND product_scope.deleted_at IS NULL
        )
      `,
    }),
  ]
).enableRLS();
