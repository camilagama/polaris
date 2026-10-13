import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { user } from "./auth";

const runtimeRole = "polaris_pr11_runtime";

export const organizations = pgTable(
  "organizations",
  {
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    currency: text("currency").notNull().default("BRL"),
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    status: text("status").notNull().default("active"),
    timezone: text("timezone").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    check(
      "organizations_status_check",
      sql`${table.status} in ('active', 'suspended', 'closed')`
    ),
    check("organizations_currency_check", sql`${table.currency} = 'BRL'`),
    pgPolicy("organizations_active_tenant_select", {
      for: "select",
      to: runtimeRole,
      using: sql`
        ${table.id} = NULLIF(current_setting('app.organization_id', true), '')
        AND ${table.status} = 'active'
        AND EXISTS (
          SELECT 1
          FROM public.memberships AS membership_scope
          WHERE membership_scope.organization_id = ${table.id}
            AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
            AND membership_scope.status = 'active'
        )
      `,
    }),
  ]
).enableRLS();

/**
 * The organization/user pair uniquely identifies a membership.
 * Do not add a global user_id uniqueness constraint: the V1 single-org rule
 * belongs in domain logic, while this schema preserves future multi-org support.
 */
export const memberships = pgTable(
  "memberships",
  {
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("owner"),
    status: text("status").notNull().default("active"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.userId],
      name: "memberships_pk",
    }),
    check("memberships_role_check", sql`${table.role} = 'owner'`),
    check("memberships_status_check", sql`${table.status} = 'active'`),
    index("memberships_user_id_idx").on(table.userId),
    pgPolicy("memberships_current_user_select", {
      for: "select",
      to: runtimeRole,
      using: sql`
        ${table.userId} = NULLIF(current_setting('app.user_id', true), '')
        AND (
          NULLIF(current_setting('app.organization_id', true), '') IS NULL
          OR ${table.organizationId} = NULLIF(current_setting('app.organization_id', true), '')
        )
      `,
    }),
  ]
).enableRLS();

export const organizationSchema = { memberships, organizations };
