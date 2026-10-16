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

const adminRole = "polaris_admin_runtime";

/**
 * The people who run Polaris (plan PR93, ADR 0070). A principal is identified by
 * the Cloudflare Access issuer and subject that the Admin Worker verified from
 * the signed token, never by an e-mail address: the e-mail is only a snapshot to
 * show who it is. Principals are provisioned by the database owner (a runbook
 * step); the Admin app can read them and refresh the snapshot, never create
 * one, so a valid Access login alone does not make anyone an operator.
 */
export const platformPrincipals = pgTable(
  "platform_principals",
  {
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** Display only: never used to find or trust a principal. */
    emailSnapshot: text("email_snapshot"),
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    issuer: text("issuer").notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    role: text("role").notNull(),
    status: text("status").default("active").notNull(),
    subject: text("subject").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("platform_principals_identity_unique").on(
      table.issuer,
      table.subject
    ),
    index("platform_principals_status_idx").on(table.status),
    check(
      "platform_principals_role_allowed",
      sql`${table.role} IN ('platform_owner')`
    ),
    check(
      "platform_principals_status_allowed",
      sql`${table.status} IN ('active', 'disabled')`
    ),
    check(
      "platform_principals_issuer_allowed",
      sql`char_length(${table.issuer}) BETWEEN 1 AND 512 AND ${table.issuer} ~ '^https://'`
    ),
    check(
      "platform_principals_subject_allowed",
      sql`char_length(${table.subject}) BETWEEN 1 AND 512`
    ),
    check(
      "platform_principals_email_allowed",
      sql`${table.emailSnapshot} IS NULL OR char_length(${table.emailSnapshot}) <= 320`
    ),
    pgPolicy("platform_principals_admin_select", {
      for: "select",
      to: adminRole,
      using: sql`true`,
    }),
    pgPolicy("platform_principals_admin_update", {
      for: "update",
      to: adminRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ]
).enableRLS();
