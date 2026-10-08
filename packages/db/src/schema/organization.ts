import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { user } from "./auth";

export const organizations = pgTable(
  "organizations",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    timezone: text("timezone").notNull(),
    currency: text("currency").notNull().default("BRL"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
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
  ]
);

/**
 * The organization/user pair uniquely identifies a membership.
 * Do not add a global user_id uniqueness constraint: the V1 single-org rule
 * belongs in domain logic, while this schema preserves future multi-org support.
 */
export const memberships = pgTable(
  "memberships",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    role: text("role").notNull().default("owner"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.userId],
      name: "memberships_pk",
    }),
    check("memberships_role_check", sql`${table.role} = 'owner'`),
    check("memberships_status_check", sql`${table.status} = 'active'`),
    index("memberships_user_id_idx").on(table.userId),
  ]
);

export const organizationSchema = { memberships, organizations };
