import { sql } from "drizzle-orm";
import {
  boolean,
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
import { activeTenantScope, products } from "./product";

const runtimeRole = "polaris_pr11_runtime";

/**
 * What an organization chooses to show the world (plan PR87, ADR 0069): a public
 * name, an address (the slug, unique across every organization) and optional
 * contacts, all typed into this profile and never taken from the owner, the
 * login or the billing data. `published` is the organization's own switch; the
 * plan decides, at every public read, whether it counts.
 */
export const publicCatalogProfiles = pgTable(
  "public_catalog_profiles",
  {
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    description: text("description"),
    /** The Instagram name without the @ (optional). */
    instagram: text("instagram"),
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    publicName: text("public_name").notNull(),
    published: boolean("published").default(false).notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    slug: text("slug").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    version: integer("version").default(1).notNull(),
    /** Digits only, country code included (optional). */
    whatsapp: text("whatsapp"),
  },
  (table) => [
    check(
      "public_catalog_profiles_slug_allowed",
      sql`
        char_length(${table.slug}) BETWEEN 3 AND 40
        AND ${table.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
        AND ${table.slug} NOT IN ('admin', 'api', 'app', 'assets', 'catalog', 'catalogo', 'login', 'm', 'polaris', 'robots', 'sitemap', 'static', 'www')
      `
    ),
    check(
      "public_catalog_profiles_name_allowed",
      sql`char_length(btrim(${table.publicName})) BETWEEN 1 AND 80`
    ),
    check(
      "public_catalog_profiles_description_allowed",
      sql`${table.description} IS NULL OR char_length(${table.description}) BETWEEN 1 AND 280`
    ),
    check(
      "public_catalog_profiles_whatsapp_allowed",
      sql`${table.whatsapp} IS NULL OR ${table.whatsapp} ~ '^[0-9]{10,15}$'`
    ),
    check(
      "public_catalog_profiles_instagram_allowed",
      sql`${table.instagram} IS NULL OR ${table.instagram} ~ '^[a-z0-9._]{1,30}$'`
    ),
    check(
      "public_catalog_profiles_published_coherent",
      sql`NOT ${table.published} OR ${table.publishedAt} IS NOT NULL`
    ),
    check(
      "public_catalog_profiles_version_positive",
      sql`${table.version} >= 1`
    ),
    // the address is one namespace for every organization
    uniqueIndex("public_catalog_profiles_slug_unique").on(table.slug),
    pgPolicy("public_catalog_profiles_current_tenant_select", {
      for: "select",
      to: runtimeRole,
      using: activeTenantScope(table.organizationId),
    }),
    pgPolicy("public_catalog_profiles_current_tenant_insert", {
      for: "insert",
      to: runtimeRole,
      withCheck: activeTenantScope(table.organizationId),
    }),
    pgPolicy("public_catalog_profiles_current_tenant_update", {
      for: "update",
      to: runtimeRole,
      using: activeTenantScope(table.organizationId),
      withCheck: activeTenantScope(table.organizationId),
    }),
  ]
).enableRLS();

/**
 * The products an organization chose to show (plan PR88): one row per product,
 * shown while `unpublished_at` is null. Nothing about the product is copied: what
 * is public is read from the live product, and a product that is archived or
 * deleted stops being shown whatever this row says.
 */
export const productPublications = pgTable(
  "product_publications",
  {
    organizationId: text("organization_id").notNull(),
    productId: uuid("product_id").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    publishedBy: text("published_by").notNull(),
    unpublishedAt: timestamp("unpublished_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.productId],
      name: "product_publications_pk",
    }),
    foreignKey({
      columns: [table.organizationId, table.productId],
      foreignColumns: [products.organizationId, products.id],
      name: "product_publications_organization_product_fk",
    }).onDelete("restrict"),
    check(
      "product_publications_actor_allowed",
      sql`char_length(${table.publishedBy}) BETWEEN 1 AND 128`
    ),
    check(
      "product_publications_period_coherent",
      sql`${table.unpublishedAt} IS NULL OR ${table.unpublishedAt} >= ${table.publishedAt}`
    ),
    // the public list reads the products shown
    index("product_publications_shown_idx")
      .on(table.organizationId, table.publishedAt)
      .where(sql`${table.unpublishedAt} IS NULL`),
    pgPolicy("product_publications_current_tenant_select", {
      for: "select",
      to: runtimeRole,
      using: activeTenantScope(table.organizationId),
    }),
    pgPolicy("product_publications_current_tenant_insert", {
      for: "insert",
      to: runtimeRole,
      withCheck: activeTenantScope(table.organizationId),
    }),
    pgPolicy("product_publications_current_tenant_update", {
      for: "update",
      to: runtimeRole,
      using: activeTenantScope(table.organizationId),
      withCheck: activeTenantScope(table.organizationId),
    }),
  ]
).enableRLS();
