import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgPolicy,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { organizations } from "./organization";

const ownerRole = "polaris_privacy_owner";

/**
 * The closure of an organization (plan PR101, ADR 0074): who asked, when, and until
 * when the owner can still undo it. One row per organization, describing its latest
 * closure (a recovery followed by a new closure rewrites it; the history is in the
 * tenant audit). No runtime role reads or writes it: the closure functions, owned by
 * a role that is never a login, do.
 */
export const organizationClosures = pgTable(
  "organization_closures",
  {
    closedAt: timestamp("closed_at", { withTimezone: true }),
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    recoverUntil: timestamp("recover_until", { withTimezone: true }).notNull(),
    recoveredAt: timestamp("recovered_at", { withTimezone: true }),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** An internal ID, never a name or e-mail. Not a foreign key: it must not block deleting the user. */
    requestedByUserId: text("requested_by_user_id").notNull(),
  },
  (table) => [
    index("organization_closures_recover_until_idx").on(table.recoverUntil),
    check(
      "organization_closures_window_allowed",
      sql`${table.recoverUntil} > ${table.requestedAt} AND ${table.recoverUntil} <= ${table.requestedAt} + interval '2160 hours'`
    ),
    check(
      "organization_closures_requester_allowed",
      sql`char_length(btrim(${table.requestedByUserId})) BETWEEN 1 AND 255`
    ),
    check(
      "organization_closures_outcome_coherent",
      sql`${table.closedAt} IS NULL OR ${table.recoveredAt} IS NULL`
    ),
    pgPolicy("organization_closures_privacy_owner_select", {
      for: "select",
      to: ownerRole,
      using: sql`true`,
    }),
    pgPolicy("organization_closures_privacy_owner_insert", {
      for: "insert",
      to: ownerRole,
      withCheck: sql`true`,
    }),
    pgPolicy("organization_closures_privacy_owner_update", {
      for: "update",
      to: ownerRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ]
).enableRLS();
