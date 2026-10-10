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
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organization";
import { activeTenantScope, productVariants, products } from "./product";

const runtimeRole = "polaris_pr11_runtime";

export const mediaAssets = pgTable(
  "media_assets",
  {
    createdAt: timestamp("created_at").defaultNow().notNull(),
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
  },
  (table) => [
    uniqueIndex("media_assets_organization_id_unique").on(
      table.organizationId,
      table.id
    ),
    pgPolicy("media_assets_current_tenant_select", {
      for: "select",
      to: runtimeRole,
      using: activeTenantScope(table.organizationId),
    }),
  ]
).enableRLS();

export const productMedia = pgTable(
  "product_media",
  {
    createdAt: timestamp("created_at").defaultNow().notNull(),
    mediaAssetId: uuid("media_asset_id").notNull(),
    organizationId: text("organization_id").notNull(),
    position: integer("position").notNull(),
    productId: uuid("product_id").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.productId, table.mediaAssetId],
      name: "product_media_pk",
    }),
    check("product_media_position_nonnegative", sql`${table.position} >= 0`),
    foreignKey({
      columns: [table.organizationId, table.productId],
      foreignColumns: [products.organizationId, products.id],
      name: "product_media_product_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.mediaAssetId],
      foreignColumns: [mediaAssets.organizationId, mediaAssets.id],
      name: "product_media_asset_fk",
    }).onDelete("restrict"),
    uniqueIndex("product_media_asset_one_product_unique").on(
      table.organizationId,
      table.mediaAssetId
    ),
    uniqueIndex("product_media_product_position_unique").on(
      table.organizationId,
      table.productId,
      table.position
    ),
    pgPolicy("product_media_current_tenant_select", {
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
  ]
).enableRLS();

export const variantMedia = pgTable(
  "variant_media",
  {
    createdAt: timestamp("created_at").defaultNow().notNull(),
    mediaAssetId: uuid("media_asset_id").notNull(),
    organizationId: text("organization_id").notNull(),
    position: integer("position").notNull(),
    productId: uuid("product_id").notNull(),
    variantId: uuid("variant_id").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.organizationId,
        table.productId,
        table.variantId,
        table.mediaAssetId,
      ],
      name: "variant_media_pk",
    }),
    check("variant_media_position_nonnegative", sql`${table.position} >= 0`),
    foreignKey({
      columns: [table.organizationId, table.productId, table.variantId],
      foreignColumns: [
        productVariants.organizationId,
        productVariants.productId,
        productVariants.id,
      ],
      name: "variant_media_variant_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.productId, table.mediaAssetId],
      foreignColumns: [
        productMedia.organizationId,
        productMedia.productId,
        productMedia.mediaAssetId,
      ],
      name: "variant_media_product_asset_fk",
    }).onDelete("restrict"),
    index("variant_media_organization_asset_idx").on(
      table.organizationId,
      table.mediaAssetId
    ),
    uniqueIndex("variant_media_variant_position_unique").on(
      table.organizationId,
      table.productId,
      table.variantId,
      table.position
    ),
    pgPolicy("variant_media_current_tenant_select", {
      for: "select",
      to: runtimeRole,
      using: sql`
        ${activeTenantScope(table.organizationId)}
        AND EXISTS (
          SELECT 1
          FROM public.products AS product_scope
          INNER JOIN public.product_variants AS variant_scope
            ON variant_scope.organization_id = product_scope.organization_id
           AND variant_scope.product_id = product_scope.id
          WHERE product_scope.id = ${table.productId}
            AND product_scope.organization_id = ${table.organizationId}
            AND variant_scope.id = ${table.variantId}
        )
      `,
    }),
  ]
).enableRLS();
