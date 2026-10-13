import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  type AnyPgColumn,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organization";

const runtimeRole = "polaris_pr11_runtime";

function activeTenantScope(organizationId: AnyPgColumn) {
  return sql`
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
}

export const customers = pgTable(
  "customers",
  {
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    email: text("email"),
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    name: text("name").notNull(),
    notes: text("notes"),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    phone: text("phone"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    version: integer("version").default(1).notNull(),
  },
  (table) => {
    const tenantScope = activeTenantScope(table.organizationId);

    return [
      check(
        "customers_name_not_blank",
        sql`char_length(btrim(${table.name})) >= 1`
      ),
      check(
        "customers_contact_required",
        sql`
          (${table.phone} IS NOT NULL OR ${table.email} IS NOT NULL)
          AND (${table.phone} IS NULL OR char_length(btrim(${table.phone})) >= 1)
          AND (${table.email} IS NULL OR char_length(btrim(${table.email})) >= 1)
        `
      ),
      check("customers_version_positive", sql`${table.version} >= 1`),
      index("customers_organization_archive_name_idx").on(
        table.organizationId,
        table.archivedAt,
        table.name,
        table.id
      ),
      index("customers_organization_email_lower_idx")
        .on(table.organizationId, sql`lower(${table.email})`)
        .where(sql`${table.email} IS NOT NULL`),
      index("customers_organization_phone_idx")
        .on(table.organizationId, table.phone)
        .where(sql`${table.phone} IS NOT NULL`),
      uniqueIndex("customers_organization_id_id_unique").on(
        table.organizationId,
        table.id
      ),
      pgPolicy("customers_current_tenant_select", {
        for: "select",
        to: runtimeRole,
        using: tenantScope,
      }),
      pgPolicy("customers_current_tenant_insert", {
        for: "insert",
        to: runtimeRole,
        withCheck: tenantScope,
      }),
      pgPolicy("customers_current_tenant_update", {
        for: "update",
        to: runtimeRole,
        using: tenantScope,
        withCheck: tenantScope,
      }),
    ];
  }
).enableRLS();
