import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organization";
import { platformPrincipals } from "./platform";
import { supportCases } from "./platform-support";

const purgeOwnerRole = "polaris_purge_owner";
const adminOwnerRole = "polaris_admin_owner";

/**
 * The purge of a closed organization (plan PR107, ADR 0081): who scheduled it, under which case,
 * from when it may run, and how far it went. One row per organization; it survives the purge with
 * the organization's tombstone row, without personal data (IDs, times and an error code). The Admin
 * creates it through `admin_schedule_organization_purge`; the purge functions, owned by a role that
 * is never a login, claim and finish it. No runtime role reads or writes it directly.
 */
export const organizationPurges = pgTable(
  "organization_purges",
  {
    attempts: integer("attempts").default(0).notNull(),
    /** A short code of the last failed step; never a message, a key or tenant data. */
    lastErrorCode: text("last_error_code"),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    notBefore: timestamp("not_before", { withTimezone: true }).notNull(),
    /** Restrictive on purpose: the organization's row stays as a tombstone after the purge. */
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "restrict" }),
    /** The case, when it is a privacy case: it goes to the deletion ledger tombstone. */
    privacyCaseId: uuid("privacy_case_id"),
    purgedAt: timestamp("purged_at", { withTimezone: true }),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    scheduledBy: uuid("scheduled_by")
      .notNull()
      .references(() => platformPrincipals.id),
    supportCaseId: uuid("support_case_id")
      .notNull()
      .references(() => supportCases.id, { onDelete: "restrict" }),
    sweptAt: timestamp("swept_at", { withTimezone: true }),
  },
  (table) => [
    index("organization_purges_due_idx").on(table.notBefore),
    check("organization_purges_attempts_allowed", sql`${table.attempts} >= 0`),
    check(
      "organization_purges_error_code_format",
      sql`${table.lastErrorCode} IS NULL OR ${table.lastErrorCode} ~ '^[a-z][a-z0-9_]{0,63}$'`
    ),
    check(
      "organization_purges_progress_coherent",
      sql`(${table.sweptAt} IS NULL OR ${table.purgedAt} IS NOT NULL)
        AND (${table.privacyCaseId} IS NULL OR ${table.privacyCaseId} = ${table.supportCaseId})`
    ),
    pgPolicy("organization_purges_purge_owner_select", {
      for: "select",
      to: purgeOwnerRole,
      using: sql`true`,
    }),
    pgPolicy("organization_purges_purge_owner_update", {
      for: "update",
      to: purgeOwnerRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
    pgPolicy("organization_purges_admin_owner_select", {
      for: "select",
      to: adminOwnerRole,
      using: sql`true`,
    }),
    pgPolicy("organization_purges_admin_owner_insert", {
      for: "insert",
      to: adminOwnerRole,
      withCheck: sql`true`,
    }),
    pgPolicy("organization_purges_admin_owner_update", {
      for: "update",
      to: adminOwnerRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ]
).enableRLS();
