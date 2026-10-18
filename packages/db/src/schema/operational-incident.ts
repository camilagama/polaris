import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organization";

const outboxOwnerRole = "polaris_outbox_owner";
const adminOwnerRole = "polaris_admin_owner";

/**
 * Operational incidents (plan PR111, ADR 0085): something the platform itself must look at, kept
 * apart from any tenant. Today two kinds: a queue message that ended in the dead-letter queue and an
 * outbox event that passed the cap of delivery attempts. One row per cause (kind, cause and subject,
 * the event type or `unknown`), never per message: the next occurrence of a cause adds to the count
 * and moves the last occurrence. It holds codes, counts, dates and one opaque reference, never the
 * body of a message or anything a person typed.
 *
 * Only the functions of `polaris_outbox_owner` write it; `polaris_admin_owner` reads it for the Admin.
 */
export const operationalIncidents = pgTable(
  "operational_incidents",
  {
    cause: text("cause").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    kind: text("kind").notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** An opaque ID of the latest occurrence (a message or an outbox event), to find it in the logs. */
    lastReference: text("last_reference"),
    occurrenceCount: bigint("occurrence_count", { mode: "number" })
      .default(1)
      .notNull(),
    /** The event type the cause concerns, or `unknown` when the message did not carry a valid one. */
    subject: text("subject").notNull(),
  },
  (table) => [
    // one incident per cause: a repeat is a count, not a row
    unique("operational_incidents_cause_unique").on(
      table.kind,
      table.cause,
      table.subject
    ),
    check(
      "operational_incidents_kind_allowed",
      sql`${table.kind} IN ('queue_dead_letter', 'outbox_attempts_exhausted')`
    ),
    check(
      "operational_incidents_cause_allowed",
      sql`(${table.kind} = 'queue_dead_letter' AND ${table.cause} IN ('retries_exhausted', 'invalid_envelope', 'unknown_type', 'wrong_queue'))
        OR (${table.kind} = 'outbox_attempts_exhausted' AND ${table.cause} = 'attempts_exhausted')`
    ),
    check(
      "operational_incidents_subject_format",
      sql`${table.subject} = 'unknown' OR (${table.subject} ~ '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$' AND char_length(${table.subject}) <= 80)`
    ),
    check(
      "operational_incidents_reference_format",
      sql`${table.lastReference} IS NULL OR ${table.lastReference} ~ '^[A-Za-z0-9._:-]{1,128}$'`
    ),
    check(
      "operational_incidents_count_positive",
      sql`${table.occurrenceCount} >= 1`
    ),
    pgPolicy("operational_incidents_outbox_owner_all", {
      for: "all",
      to: outboxOwnerRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
    pgPolicy("operational_incidents_admin_owner_select", {
      for: "select",
      to: adminOwnerRole,
      using: sql`true`,
    }),
  ]
).enableRLS();

/**
 * The outbox events that are dead (plan PR111, ADR 0085): one row per event, so an operator can send
 * that event again. It names the event by its opaque ID and organization, and says nothing more:
 * the event itself stays in the outbox, and the retry puts that same event back to pending. A retry
 * marks the row `retried`; if the event dies again the row is `dead` again. The foreign key to the
 * organization is `ON DELETE CASCADE`, but the purge keeps the organization row as a tombstone, so the
 * cascade does not fire for it: the purge has to delete these rows itself (policy and DELETE grant of
 * its role, in the purge PR). `operational_incidents` has no organization column.
 */
export const queueDeadLetters = pgTable(
  "queue_dead_letters",
  {
    eventId: uuid("event_id").primaryKey(),
    eventType: text("event_type").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    incidentId: uuid("incident_id").notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    occurrences: integer("occurrences").default(1).notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    retriedAt: timestamp("retried_at", { withTimezone: true }),
    retryCount: integer("retry_count").default(0).notNull(),
    state: text("state").default("dead").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.incidentId],
      foreignColumns: [operationalIncidents.id],
      name: "queue_dead_letters_incident_id_operational_incidents_id_fk",
    }),
    // what the Admin lists for an incident: the dead ones, most recent first
    index("queue_dead_letters_incident_idx").on(
      table.incidentId,
      table.state,
      table.lastSeenAt
    ),
    check(
      "queue_dead_letters_state_allowed",
      sql`${table.state} IN ('dead', 'retried')`
    ),
    check(
      "queue_dead_letters_state_coherent",
      sql`(${table.state} = 'dead') OR (${table.state} = 'retried' AND ${table.retriedAt} IS NOT NULL AND ${table.retryCount} >= 1)`
    ),
    check(
      "queue_dead_letters_event_type_format",
      sql`${table.eventType} ~ '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$' AND char_length(${table.eventType}) <= 80`
    ),
    check(
      "queue_dead_letters_counts_allowed",
      sql`${table.occurrences} >= 1 AND ${table.retryCount} >= 0`
    ),
    pgPolicy("queue_dead_letters_outbox_owner_all", {
      for: "all",
      to: outboxOwnerRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
    pgPolicy("queue_dead_letters_admin_owner_select", {
      for: "select",
      to: adminOwnerRole,
      using: sql`true`,
    }),
  ]
).enableRLS();
