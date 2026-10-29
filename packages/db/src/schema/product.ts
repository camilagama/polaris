import { MAX_PRODUCT_VARIANT_SKU_LENGTH } from "@polaris/domain/catalog/product";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
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
import { categories } from "./category";
import { organizations } from "./organization";

const runtimeRole = "polaris_pr11_runtime";

export const activeTenantScope = (organizationId: AnyPgColumn) => sql`
  ${organizationId} = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = ${organizationId}
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = ${organizationId}
      AND organization_scope.status = 'active'
  )
`;

export const products = pgTable(
  "products",
  {
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    categoryId: uuid("category_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    description: text("description"),
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    name: text("name").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    variantsConfiguredAt: timestamp("variants_configured_at", {
      withTimezone: true,
    }),
    version: integer("version").default(1).notNull(),
  },
  (table) => [
    check(
      "products_name_not_blank",
      sql`char_length(btrim(${table.name})) >= 1`
    ),
    check("products_version_positive", sql`${table.version} >= 1`),
    foreignKey({
      columns: [table.organizationId, table.categoryId],
      foreignColumns: [categories.organizationId, categories.id],
      name: "products_organization_category_fk",
    }).onDelete("no action"),
    index("products_organization_archive_name_idx").on(
      table.organizationId,
      table.archivedAt,
      table.name,
      table.id
    ),
    index("products_organization_category_idx").on(
      table.organizationId,
      table.categoryId
    ),
    uniqueIndex("products_organization_id_id_unique").on(
      table.organizationId,
      table.id
    ),
    pgPolicy("products_current_tenant_select", {
      for: "select",
      to: runtimeRole,
      using: activeTenantScope(table.organizationId),
    }),
    pgPolicy("products_current_tenant_insert", {
      for: "insert",
      to: runtimeRole,
      withCheck: activeTenantScope(table.organizationId),
    }),
    pgPolicy("products_current_tenant_update", {
      for: "update",
      to: runtimeRole,
      using: activeTenantScope(table.organizationId),
      withCheck: activeTenantScope(table.organizationId),
    }),
  ]
).enableRLS();

export const productVariants = pgTable(
  "product_variants",
  {
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    isDefault: boolean("is_default").default(true).notNull(),
    /** Optional BRL list price suggested for sale items; never an economic fact. */
    listPrice: numeric("list_price"),
    organizationId: text("organization_id").notNull(),
    position: integer("position"),
    productId: uuid("product_id").notNull(),
    sku: text("sku"),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.productId],
      foreignColumns: [products.organizationId, products.id],
      name: "product_variants_organization_product_fk",
    }).onDelete("cascade"),
    check(
      "product_variants_position_nonnegative",
      sql`${table.position} IS NULL OR ${table.position} >= 0`
    ),
    check(
      "product_variants_list_price_allowed",
      sql`
        ${table.listPrice} IS NULL OR (
          ${table.listPrice} >= 0
          AND scale(${table.listPrice}) <= 2
          AND ${table.listPrice} < 1000000000000000000
        )
      `
    ),
    check(
      "product_variants_sku_canonical",
      sql`
        ${table.sku} IS NULL OR (
          ${table.sku} <> ''
          AND ${table.sku} = btrim(${table.sku})
          AND ${table.sku} !~ '^[[:space:]]|[[:space:]]$'
        )
      `
    ),
    check(
      "product_variants_sku_max_length",
      sql`${table.sku} IS NULL OR char_length(${table.sku}) <= ${sql.raw(String(MAX_PRODUCT_VARIANT_SKU_LENGTH))}`
    ),
    index("product_variants_organization_product_idx").on(
      table.organizationId,
      table.productId
    ),
    uniqueIndex("product_variants_organization_product_id_unique").on(
      table.organizationId,
      table.productId,
      table.id
    ),
    uniqueIndex("product_variants_one_default_per_product_unique")
      .on(table.productId)
      .where(sql`${table.isDefault}`),
    uniqueIndex("product_variants_product_position_unique")
      .on(table.productId, table.position)
      .where(sql`${table.position} IS NOT NULL`),
    uniqueIndex("product_variants_organization_sku_unique")
      .on(table.organizationId, sql`lower(btrim(${table.sku}))`)
      .where(sql`${table.sku} IS NOT NULL`),
    pgPolicy("product_variants_current_tenant_select", {
      for: "select",
      to: runtimeRole,
      using: sql`
        ${activeTenantScope(table.organizationId)}
        AND EXISTS (
          SELECT 1
          FROM public.products AS product_scope
          WHERE product_scope.id = ${table.productId}
            AND product_scope.organization_id = ${table.organizationId}
        )
      `,
    }),
    pgPolicy("product_variants_current_tenant_insert", {
      for: "insert",
      to: runtimeRole,
      withCheck: sql`
        ${activeTenantScope(table.organizationId)}
        AND EXISTS (
          SELECT 1
          FROM public.products AS product_scope
          WHERE product_scope.id = ${table.productId}
            AND product_scope.organization_id = ${table.organizationId}
            AND product_scope.variants_configured_at IS NULL
            AND product_scope.deleted_at IS NULL
        )
      `,
    }),
    pgPolicy("product_variants_current_tenant_delete", {
      for: "delete",
      to: runtimeRole,
      using: sql`
        ${activeTenantScope(table.organizationId)}
        AND ${table.isDefault}
        AND EXISTS (
          SELECT 1
          FROM public.products AS product_scope
          WHERE product_scope.id = ${table.productId}
            AND product_scope.organization_id = ${table.organizationId}
            AND product_scope.variants_configured_at IS NULL
            AND product_scope.deleted_at IS NULL
        )
      `,
    }),
    pgPolicy("product_variants_current_tenant_sku_update", {
      for: "update",
      to: runtimeRole,
      using: sql`
        ${activeTenantScope(table.organizationId)}
        AND EXISTS (
          SELECT 1
          FROM public.products AS product_scope
          WHERE product_scope.id = ${table.productId}
            AND product_scope.organization_id = ${table.organizationId}
          AND product_scope.deleted_at IS NULL
        )
      `,
      withCheck: sql`
        ${activeTenantScope(table.organizationId)}
        AND EXISTS (
          SELECT 1
          FROM public.products AS product_scope
          WHERE product_scope.id = ${table.productId}
            AND product_scope.organization_id = ${table.organizationId}
          AND product_scope.deleted_at IS NULL
        )
      `,
    }),
  ]
).enableRLS();
