import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organization";

const ownerRole = "polaris_outbox_owner";

/**
 * The queue consumer's record of what it processed (plans PR109 and PR110, ADRs 0083 and 0084): one row
 * per outbox event, by its organization and idempotency key, with the event's ID and the dispatch
 * attempt it last ran. A duplicate delivery of the same attempt finds it done and does nothing; a later
 * attempt (an event sent again because its work is still owed) runs again. A claim has a lease longer
 * than a consumer invocation can live, and a token, so only its holder gives it back.
 *
 * It holds opaque IDs only. Nobody reaches it but the functions of `polaris_outbox_owner`, which also
 * check that the event exists in the outbox with that key, and the purge owner, which reads and deletes the
 * rows of an organization being purged (ADR 0081); a finished row is removed a week later
 * (retention class `queue_processing`, ADR 0079).
 */
export const queueProcessing = pgTable(
  "queue_processing",
  {
    attempt: integer("attempt").notNull(),
    eventId: uuid("event_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    state: text("state").notNull(),
    token: uuid("token"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.idempotencyKey] }),
    // what the weekly expiry scans: the finished rows, oldest first
    index("queue_processing_done_idx")
      .on(table.updatedAt)
      .where(sql`${table.state} = 'done'`),
    check(
      "queue_processing_state_coherent",
      sql`(${table.state} = 'claimed' AND ${table.token} IS NOT NULL AND ${table.leaseUntil} IS NOT NULL)
        OR (${table.state} = 'done' AND ${table.token} IS NULL AND ${table.leaseUntil} IS NULL)`
    ),
    check(
      "queue_processing_attempt_allowed",
      sql`${table.attempt} BETWEEN 1 AND 1000`
    ),
    check(
      "queue_processing_key_format",
      sql`${table.idempotencyKey} ~ '^[A-Za-z0-9._:-]{1,128}$'`
    ),
    pgPolicy("queue_processing_outbox_owner_all", {
      for: "all",
      to: ownerRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ]
).enableRLS();
