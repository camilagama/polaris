import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgPolicy,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { organizations } from "./organization";

const ownerRole = "polaris_privacy_owner";

/**
 * The notices of a closure (ADR 0102 amended, design t107 §5): one row per milestone of a closure cycle, written
 * by the privacy job once the milestone's date arrives (`record_closure_notices`), whether or not an e-mail goes
 * out. The milestones come only from the dates of the closure (the request, D minus 30 and minus 7 local days,
 * D), the same with or without a legal hold; `rescheduled` is the new notice of 7 days when a legal hold released
 * after the schedule pushed the purge (`purge_from` is then the new first instant of the purge). The cycle is the
 * instant of the request: a closure undone and requested again has notices of its own. A milestone left behind by
 * a run that stopped is written `skipped` (no e-mail): only the latest one due goes out.
 *
 * The row holds IDs and dates, never the e-mail: the address is read when the notice is sent. It survives the
 * purge of the organization (class `closure_notice`), so the owner can still read when the data was deleted, and
 * leaves with the account of its user (foreign key in cascade). No runtime role reads or writes it directly, and the
 * table is under FORCE ROW LEVEL SECURITY (the migration says so: the schema builder has no form for it). The purge
 * owner reads five columns of the delivered (or dismissed) `d7` and `rescheduled` notices, by a policy the migration
 * writes: no store is deleted before the owner was told, or before the person responsible decided, under a privacy
 * case, that the notice is dismissed (ADR 0102, amended).
 *
 * The support resends or dismisses a notice by a new `d7` row of the same cycle (`reissue` 1, 2...), never by an
 * UPDATE (`admin_reissue_closure_notice` and `admin_dismiss_closure_notice`). A dismissed row has no user (nobody was
 * told; the account may be gone) and `dismissed_at` filled.
 */
export const closureNotices = pgTable(
  "closure_notices",
  {
    /** The instant of the closure request: the cycle the notice belongs to. */
    closureRequestedAt: timestamp("closure_requested_at", {
      withTimezone: true,
    }).notNull(),
    /** When the milestone was due (the first instant of its local day, or the request, or the release of a hold). */
    /**
     * When the person responsible dismissed the notice under a privacy case (a new `d7` row, never sent): it counts
     * as delivered for the purge, and the decision is in the platform audit (`closure_notice.dismissed`).
     */
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    /** A short code of why the notice was not sent; never a message or an address. */
    failureCode: text("failure_code"),
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    milestone: text("milestone").notNull(),
    /** Restrictive on purpose: the notices outlive the organization's data, with its tombstone row. */
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    /** Only for `rescheduled`: the first instant the purge may run after the release of the hold. */
    purgeFrom: timestamp("purge_from", { withTimezone: true }),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** 0 for the notice the privacy job writes; 1, 2... for each new `d7` the support writes in the same cycle. */
    reissue: smallint("reissue").default(0).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    /** An earlier milestone found together with a later one: written, never sent. */
    skipped: boolean("skipped").default(false).notNull(),
    /**
     * The owner the notice is for, when it was written (an internal ID, never a name or an e-mail). Null only for a
     * dismissed notice: nobody is told.
     */
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    unique("closure_notices_cycle_milestone_unique")
      .on(
        table.organizationId,
        table.closureRequestedAt,
        table.milestone,
        table.purgeFrom,
        table.reissue
      )
      .nullsNotDistinct(),
    index("closure_notices_user_idx").on(table.userId),
    check(
      "closure_notices_milestone_allowed",
      sql`${table.milestone} IN ('closure', 'd30', 'd7', 'deletion_day', 'rescheduled')`
    ),
    check(
      "closure_notices_purge_from_coherent",
      sql`(${table.milestone} = 'rescheduled') = (${table.purgeFrom} IS NOT NULL)`
    ),
    check(
      "closure_notices_outcome_coherent",
      sql`(${table.sentAt} IS NULL OR ${table.failedAt} IS NULL)
        AND (NOT ${table.skipped} OR (${table.sentAt} IS NULL AND ${table.failedAt} IS NULL))
        AND ((${table.failedAt} IS NULL) = (${table.failureCode} IS NULL))`
    ),
    check(
      "closure_notices_dismissal_coherent",
      sql`(${table.dismissedAt} IS NULL OR (${table.sentAt} IS NULL AND ${table.failedAt} IS NULL AND NOT ${table.skipped}))
        AND ((${table.userId} IS NULL) = (${table.dismissedAt} IS NOT NULL))
        AND (${table.reissue} = 0 OR ${table.milestone} = 'd7')
        AND (${table.dismissedAt} IS NULL OR ${table.reissue} > 0)
        AND ${table.reissue} >= 0`
    ),
    check(
      "closure_notices_failure_code_format",
      sql`${table.failureCode} IS NULL OR ${table.failureCode} ~ '^[a-z][a-z0-9_]{0,63}$'`
    ),
    check(
      "closure_notices_due_after_request",
      sql`${table.dueAt} >= ${table.closureRequestedAt}`
    ),
    pgPolicy("closure_notices_privacy_owner_select", {
      for: "select",
      to: ownerRole,
      using: sql`true`,
    }),
    pgPolicy("closure_notices_privacy_owner_insert", {
      for: "insert",
      to: ownerRole,
      withCheck: sql`true`,
    }),
    pgPolicy("closure_notices_privacy_owner_update", {
      for: "update",
      to: ownerRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ]
).enableRLS();
