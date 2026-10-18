import { sql } from "drizzle-orm";
import {
  check,
  index,
  inet,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const accessLogOwnerRole = "polaris_access_log_owner";

/**
 * The record of access to the application (ADR 0092): date, time and IP of every login, logout,
 * failed login and daily refresh of a session, kept for the 6 months of the Marco Civil, art. 15.
 * It is not a tenant table: it has no organization (the server of authentication does not know one when
 * a session starts), and `user_id` is an opaque Better Auth ID without a foreign key, so a row outlives the
 * deletion of the user. It never holds a user agent, e-mail, password, token or body.
 *
 * Append-only: a trigger refuses UPDATE, DELETE and TRUNCATE for every role (the expiry job of the future
 * replaces it in a reviewed migration). No runtime role reads or writes the table: only
 * `polaris_access_log_owner` has privileges on it, `record_auth_access` (owned by it, executed by the
 * authentication runtime) appends, and `admin_read_auth_access_log` (owned by it, executed by the Admin
 * runtime) reads, on a court order, and writes the platform audit in the same transaction.
 */
export const authAccessLog = pgTable(
  "auth_access_log",
  {
    event: text("event").notNull(),
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    ip: inet("ip").notNull(),
    /** The database clock, never a value from the client. */
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    requestId: text("request_id").notNull(),
    /** Null only for a failed login: nobody looks a user up by e-mail on a failure. */
    userId: text("user_id"),
  },
  (table) => [
    index("auth_access_log_user_occurred_idx").on(
      table.userId,
      table.occurredAt
    ),
    index("auth_access_log_ip_occurred_idx").on(table.ip, table.occurredAt),
    // the expiry job of the future cuts by date
    index("auth_access_log_occurred_idx").on(table.occurredAt),
    check(
      "auth_access_log_event_allowed",
      sql`${table.event} IN ('login_succeeded', 'login_failed', 'logout', 'session_refreshed')`
    ),
    check(
      "auth_access_log_user_required",
      sql`${table.userId} IS NOT NULL OR ${table.event} = 'login_failed'`
    ),
    check(
      "auth_access_log_user_format",
      sql`${table.userId} IS NULL OR ${table.userId} ~ '^[A-Za-z0-9_-]{1,64}$'`
    ),
    check(
      "auth_access_log_request_format",
      sql`${table.requestId} ~ '^[A-Za-z0-9_-]{1,64}$'`
    ),
    pgPolicy("auth_access_log_owner_insert", {
      for: "insert",
      to: accessLogOwnerRole,
      withCheck: sql`true`,
    }),
    pgPolicy("auth_access_log_owner_select", {
      for: "select",
      to: accessLogOwnerRole,
      using: sql`true`,
    }),
  ]
).enableRLS();
