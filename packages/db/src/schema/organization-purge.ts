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
    /** The deletion case that accepted the purge (always a privacy case): it goes to the deletion ledger tombstone. */
    privacyCaseId: uuid("privacy_case_id").notNull(),
    purgedAt: timestamp("purged_at", { withTimezone: true }),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    scheduledBy: uuid("scheduled_by")
      .notNull()
      .references(() => platformPrincipals.id),
    /**
     * Set by `mark_organization_purge_storage_touched` before the first object is removed from the
     * storage, and never undone: from then on the purge cannot be cancelled (ADR 0081).
     */
    storageTouchedAt: timestamp("storage_touched_at", { withTimezone: true }),
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
        AND ${table.privacyCaseId} = ${table.supportCaseId}`
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

/**
 * Every cancellation of a purge (plan PR107, ADR 0081), append-only: who cancelled it, under which case,
 * which purge it was and the short reason the operator wrote. A purge scheduled again starts its own row
 * from nothing, so the reason lives here and survives that. The Admin writes it through
 * `admin_cancel_organization_purge`; no runtime role reads or writes it directly, and nobody updates or
 * deletes a row.
 */
export const organizationPurgeCancellations = pgTable(
  "organization_purge_cancellations",
  {
    cancelledAt: timestamp("cancelled_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    cancelledBy: uuid("cancelled_by")
      .notNull()
      .references(() => platformPrincipals.id),
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    /** Short free text written by the operator; never copied to the audit event. */
    reason: text("reason").notNull(),
    /** When the cancelled purge had been scheduled. */
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    supportCaseId: uuid("support_case_id")
      .notNull()
      .references(() => supportCases.id, { onDelete: "restrict" }),
  },
  (table) => [
    index("organization_purge_cancellations_organization_idx").on(
      table.organizationId,
      table.cancelledAt
    ),
    check(
      "organization_purge_cancellations_reason_format",
      sql`char_length(${table.reason}) BETWEEN 1 AND 500 AND ${table.reason} = btrim(${table.reason}) AND ${table.reason} !~ '[[:cntrl:]]'`
    ),
    pgPolicy("organization_purge_cancellations_admin_owner_select", {
      for: "select",
      to: adminOwnerRole,
      using: sql`true`,
    }),
    pgPolicy("organization_purge_cancellations_admin_owner_insert", {
      for: "insert",
      to: adminOwnerRole,
      withCheck: sql`true`,
    }),
  ]
).enableRLS();
