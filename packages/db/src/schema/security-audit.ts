import {
  index,
  pgEnum,
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
    actorId: text("actor_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    errorCode: text("error_code"),
    eventType: authSecurityAuditEventType("event_type").notNull(),
    id: uuid("id").defaultRandom().primaryKey(),
    outcome: authSecurityAuditOutcome("outcome").notNull(),
    provider: text("provider"),
    requestId: text("request_id").notNull(),
  },
  (table) => [
    index("auth_security_audit_event_actor_created_idx").on(
      table.actorId,
      table.createdAt
    ),
    index("auth_security_audit_event_request_idx").on(table.requestId),
  ]
);
