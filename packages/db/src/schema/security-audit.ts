import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgEnum,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const authSecurityAuditEventType = pgEnum(
  "auth_security_audit_event_type",
  [
    "google_login_started",
    "google_callback_succeeded",
    "google_callback_failed",
    "logout_succeeded",
    "logout_failed",
    "device_revoked",
    "login_locked",
    "login_unlocked",
    "password_changed",
    "password_reset_completed",
    "password_set",
    "unverified_user_deleted",
  ]
);

export const authSecurityAuditOutcome = pgEnum("auth_security_audit_outcome", [
  "started",
  "succeeded",
  "failed",
]);

export const authSecurityAuditEvents = pgTable(
  "auth_security_audit_event",
  {
    /** The device the revoking session was linked to, when it was (device_revoked). */
    actingDeviceId: uuid("acting_device_id"),
    /** The session that revoked (device_revoked); an id, never the token. */
    actingSessionId: text("acting_session_id"),
    actorId: text("actor_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** How many sessions the revocation ended (device_revoked). */
    endedSessionCount: integer("ended_session_count"),
    errorCode: text("error_code"),
    eventType: authSecurityAuditEventType("event_type").notNull(),
    id: uuid("id").defaultRandom().primaryKey(),
    outcome: authSecurityAuditOutcome("outcome").notNull(),
    provider: text("provider"),
    requestId: text("request_id").notNull(),
    /** The revoked device (device_revoked) or the deleted user (unverified_user_deleted). */
    subjectId: text("subject_id"),
  },
  // Row security with FORCE (0098); INSERT only, no role of the app reads it. Each event type is written by one side: the
  // owners write their own type (with its actor), and Better Auth's runtime every other one, never an owner's.
  (table) => [
    index("auth_security_audit_event_actor_created_idx").on(
      table.actorId,
      table.createdAt
    ),
    index("auth_security_audit_event_request_idx").on(table.requestId),
    pgPolicy("auth_security_audit_event_auth_runtime_insert", {
      for: "insert",
      to: "polaris_auth_runtime",
      withCheck: sql`${table.eventType} NOT IN ('device_revoked', 'unverified_user_deleted')`,
    }),
    pgPolicy("auth_security_audit_event_device_session_owner_insert", {
      for: "insert",
      to: "polaris_device_session_owner",
      withCheck: sql`${table.eventType} = 'device_revoked' AND ${table.actorId} = NULLIF(pg_catalog.current_setting('app.owner_scope.device_session_user_id', true), '')`,
    }),
    pgPolicy("auth_security_audit_event_unverified_user_owner_insert", {
      for: "insert",
      to: "polaris_unverified_user_owner",
      withCheck: sql`${table.eventType} = 'unverified_user_deleted' AND ${table.outcome} = 'succeeded' AND ${table.actorId} IS NULL`,
    }),
  ]
).enableRLS();
