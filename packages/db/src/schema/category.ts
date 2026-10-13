import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organization";

const runtimeRole = "polaris_pr11_runtime";

export const categories = pgTable(
  "categories",
  {
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    check(
      "categories_name_length",
      sql`char_length(btrim(${table.name})) BETWEEN 1 AND 100`
    ),
    index("categories_organization_id_name_idx").on(
      table.organizationId,
      table.name
    ),
    uniqueIndex("categories_organization_name_unique").on(
      table.organizationId,
      sql`lower(btrim(${table.name}))`
    ),
    uniqueIndex("categories_organization_id_id_unique").on(
      table.organizationId,
      table.id
    ),
    pgPolicy("categories_current_tenant_select", {
      for: "select",
      to: runtimeRole,
      using: sql`
        ${table.organizationId} = NULLIF(current_setting('app.organization_id', true), '')
        AND EXISTS (
          SELECT 1
          FROM public.memberships AS membership_scope
          WHERE membership_scope.organization_id = ${table.organizationId}
            AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
            AND membership_scope.status = 'active'
        )
        AND EXISTS (
          SELECT 1
          FROM public.organizations AS organization_scope
          WHERE organization_scope.id = ${table.organizationId}
            AND organization_scope.status = 'active'
        )
      `,
    }),
    pgPolicy("categories_current_tenant_insert", {
      for: "insert",
      to: runtimeRole,
      withCheck: sql`
        ${table.organizationId} = NULLIF(current_setting('app.organization_id', true), '')
        AND EXISTS (
          SELECT 1
          FROM public.memberships AS membership_scope
          WHERE membership_scope.organization_id = ${table.organizationId}
            AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
            AND membership_scope.status = 'active'
        )
        AND EXISTS (
          SELECT 1
          FROM public.organizations AS organization_scope
          WHERE organization_scope.id = ${table.organizationId}
            AND organization_scope.status = 'active'
        )
      `,
    }),
    pgPolicy("categories_current_tenant_update", {
      for: "update",
      to: runtimeRole,
      using: sql`
        ${table.organizationId} = NULLIF(current_setting('app.organization_id', true), '')
        AND EXISTS (
          SELECT 1
          FROM public.memberships AS membership_scope
          WHERE membership_scope.organization_id = ${table.organizationId}
            AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
            AND membership_scope.status = 'active'
        )
        AND EXISTS (
          SELECT 1
          FROM public.organizations AS organization_scope
          WHERE organization_scope.id = ${table.organizationId}
            AND organization_scope.status = 'active'
        )
      `,
      withCheck: sql`
        ${table.organizationId} = NULLIF(current_setting('app.organization_id', true), '')
        AND EXISTS (
          SELECT 1
          FROM public.memberships AS membership_scope
          WHERE membership_scope.organization_id = ${table.organizationId}
            AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
            AND membership_scope.status = 'active'
        )
        AND EXISTS (
          SELECT 1
          FROM public.organizations AS organization_scope
          WHERE organization_scope.id = ${table.organizationId}
            AND organization_scope.status = 'active'
        )
      `,
    }),
  ]
).enableRLS();
