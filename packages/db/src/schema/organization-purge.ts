import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organization";
import { platformPrincipals } from "./platform";
import { supportCases } from "./platform-support";

const purgeOwnerRole = "polaris_purge_owner";
const adminOwnerRole = "polaris_admin_owner";

/**
 * The purge of a closed organization (plan PR107, ADR 0081 and 0102): who scheduled it, under which case,
 * from when it may run, and how far it went. One row per organization; it survives the purge with
 * the organization's tombstone row, without personal data (IDs, times and an error code). The Admin
 * creates it through `admin_schedule_organization_purge` (`trigger = 'admin'`, with the operator and the
 * privacy case), and the privacy job through `schedule_closed_organization_purges` once the closure period
 * ends (`trigger = 'closure_period'`, with neither); the purge functions, owned by a role that is never a
 * login, claim and finish it. No runtime role reads or writes it directly.
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
    /**
     * The deletion case that accepted the purge (always a privacy case): it goes to the deletion ledger tombstone.
     * Null when the closure period scheduled it (ADR 0102).
     */
    privacyCaseId: uuid("privacy_case_id"),
    purgedAt: timestamp("purged_at", { withTimezone: true }),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** The operator who scheduled it; null when the closure period did (ADR 0102). */
    scheduledBy: uuid("scheduled_by").references(() => platformPrincipals.id),
    /**
     * Set by `mark_organization_purge_storage_touched` before the first object is removed from the
     * storage, and never undone: from then on the purge cannot be cancelled (ADR 0081).
     */
    storageTouchedAt: timestamp("storage_touched_at", { withTimezone: true }),
    /** Null when the closure period scheduled it (ADR 0102). */
    supportCaseId: uuid("support_case_id").references(() => supportCases.id, {
      onDelete: "restrict",
    }),
    sweptAt: timestamp("swept_at", { withTimezone: true }),
    /**
     * What scheduled it: `admin` (an operator, under an accepted privacy case) or `closure_period` (the privacy
     * job, once the owner's closure reached D minus 7 days, ADR 0102).
     */
    trigger: text("trigger").default("admin").notNull(),
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
    check(
      "organization_purges_trigger_allowed",
      sql`${table.trigger} IN ('admin', 'closure_period')`
    ),
    check(
      "organization_purges_trigger_coherent",
      sql`(${table.trigger} = 'admin' AND ${table.scheduledBy} IS NOT NULL AND ${table.supportCaseId} IS NOT NULL AND ${table.privacyCaseId} IS NOT NULL)
        OR (${table.trigger} = 'closure_period' AND ${table.scheduledBy} IS NULL AND ${table.supportCaseId} IS NULL AND ${table.privacyCaseId} IS NULL)`
    ),
    pgPolicy("organization_purges_purge_owner_select", {
      for: "select",
      to: purgeOwnerRole,
      using: sql`true`,
    }),
    // the privacy job schedules a purge of the closure period, never one of the Admin (ADR 0102)
    pgPolicy("organization_purges_purge_owner_insert", {
      for: "insert",
      to: purgeOwnerRole,
      withCheck: sql`trigger = 'closure_period'`,
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

/**
 * A legal hold on an organization (ADR 0081): while one is in force, the purge is
 * neither scheduled nor run, and nothing of the organization is removed. One row per hold; released holds
 * stay as the record of it. It carries no free text: why the hold exists is the case it hangs from. It has a
 * required review date: when it passes the hold stays in force (nothing releases it but an operator) and the
 * Admin list shows it as due for review. The Admin places and releases it through
 * `admin_place_organization_legal_hold` and `admin_release_organization_legal_hold` and reads the ones in force
 * through `admin_list_organization_legal_holds`; the purge functions only read it. Nobody deletes a row.
 */
export const organizationLegalHolds = pgTable(
  "organization_legal_holds",
  {
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    placedAt: timestamp("placed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    placedBy: uuid("placed_by")
      .notNull()
      .references(() => platformPrincipals.id),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releasedBy: uuid("released_by").references(() => platformPrincipals.id),
    /** When the hold must be looked at again; after it the hold stays and is listed as due for review. */
    reviewAt: timestamp("review_at", { withTimezone: true }).notNull(),
    supportCaseId: uuid("support_case_id")
      .notNull()
      .references(() => supportCases.id, { onDelete: "restrict" }),
  },
  (table) => [
    // one hold in force per organization
    uniqueIndex("organization_legal_holds_active_unique")
      .on(table.organizationId)
      .where(sql`${table.releasedAt} IS NULL`),
    check(
      "organization_legal_holds_review_after_placed",
      sql`${table.reviewAt} > ${table.placedAt}`
    ),
    check(
      "organization_legal_holds_release_coherent",
      sql`(${table.releasedAt} IS NULL) = (${table.releasedBy} IS NULL)
        AND (${table.releasedAt} IS NULL OR ${table.releasedAt} >= ${table.placedAt})`
    ),
    pgPolicy("organization_legal_holds_admin_owner_select", {
      for: "select",
      to: adminOwnerRole,
      using: sql`true`,
    }),
    pgPolicy("organization_legal_holds_admin_owner_insert", {
      for: "insert",
      to: adminOwnerRole,
      withCheck: sql`true`,
    }),
    pgPolicy("organization_legal_holds_admin_owner_update", {
      for: "update",
      to: adminOwnerRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
    pgPolicy("organization_legal_holds_purge_owner_select", {
      for: "select",
      to: purgeOwnerRole,
      using: sql`true`,
    }),
  ]
).enableRLS();
