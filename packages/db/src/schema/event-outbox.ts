import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organization";

const runtimeRole = "polaris_pr11_runtime";

/**
 * The transactional outbox (plan PR108, ADR 0082): an event written in the same transaction as the
 * command that causes it, waiting for the dispatcher (PR110) to hand it to a queue. It holds the kind
 * of event, a body of opaque IDs, numbers and booleans (never a name, e-mail, phone or note: the CHECK
 * refuses any other string) and the bookkeeping the dispatcher needs.
 *
 * The tenant runtime only inserts, in its own organization and only the events its policy lists (a
 * `data_export.requested` must name an export that the same user requested in that organization); it
 * reads, updates and deletes nothing, and no other role has a privilege here yet: the dispatcher's role
 * and its policies arrive with PR110, in their own migration. The rows go with the organization
 * (`ON DELETE CASCADE`), so the purge needs no step of its own.
 */
export const eventOutbox = pgTable(
  "event_outbox",
  {
    /** Delivery tries, counted by the dispatcher. */
    attempts: integer("attempts").default(0).notNull(),
    /** Not before this time; the dispatcher also uses it to back off a retry. */
    availableAt: timestamp("available_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** The trace of the request that caused the event, carried to the queue and the consumer. */
    correlationId: text("correlation_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    event: jsonb("event").notNull(),
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    idempotencyKey: text("idempotency_key").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    status: text("status").default("pending").notNull(),
    type: text("type").notNull(),
  },
  (table) => [
    // one event per key and organization: the same command twice writes one event
    uniqueIndex("event_outbox_idempotency_unique").on(
      table.organizationId,
      table.idempotencyKey
    ),
    // what the dispatcher scans: the pending events that are due, oldest first
    index("event_outbox_pending_idx")
      .on(table.availableAt, table.id)
      .where(sql`${table.status} = 'pending'`),
    check(
      "event_outbox_status_allowed",
      sql`${table.status} IN ('pending', 'dispatched')`
    ),
    check("event_outbox_attempts_allowed", sql`${table.attempts} >= 0`),
    check(
      "event_outbox_type_format",
      sql`${table.type} ~ '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$' AND char_length(${table.type}) <= 80`
    ),
    check(
      "event_outbox_tokens_format",
      sql`${table.idempotencyKey} ~ '^[A-Za-z0-9._:-]{1,128}$' AND ${table.correlationId} ~ '^[A-Za-z0-9._:-]{1,128}$'`
    ),
    // the body is a flat object, small, with short key names, whose values are opaque IDs (letters,
    // digits, "-" and "_", up to 64), integers or booleans: free text, where a person's data would be,
    // does not fit. The string test is positive (an ID, or refused) because a regex for "anything
    // else" does not match a line break
    check(
      "event_outbox_event_shape",
      sql`jsonb_typeof(${table.event}) = 'object'
        AND octet_length(${table.event}::text) <= 2048
        AND NOT jsonb_path_exists(${table.event}, 'strict $.keyvalue() ? (!(@.key like_regex "^[a-z][A-Za-z0-9]{0,31}$"))')
        AND NOT jsonb_path_exists(${table.event}, 'strict $.* ? (@.type() == "object" || @.type() == "array" || @.type() == "null")')
        AND NOT jsonb_path_exists(${table.event}, 'strict $.* ? (@.type() == "string" && !(@ like_regex "^[A-Za-z0-9_-]{1,64}$"))')
        AND NOT jsonb_path_exists(${table.event}, 'strict $.* ? (@.type() == "number" && (@ % 1 != 0 || @ < -9007199254740991 || @ > 9007199254740991))')`
    ),
    pgPolicy("event_outbox_tenant_insert", {
      for: "insert",
      to: runtimeRole,
      withCheck: sql`
        ${table.organizationId} = NULLIF(current_setting('app.organization_id', true), '')
        AND ${table.type} IN ('data_export.requested')
        AND ${table.status} = 'pending'
        AND ${table.attempts} = 0
        AND ${table.idempotencyKey} = ${table.type} || ':' || (${table.event} ->> 'exportId')
        AND EXISTS (
          SELECT 1
          FROM public.data_exports AS export_scope
          WHERE export_scope.id::text = ${table.event} ->> 'exportId'
            AND export_scope.organization_id = ${table.organizationId}
            AND export_scope.requested_by_user_id = NULLIF(current_setting('app.user_id', true), '')
        )
        AND EXISTS (
          SELECT 1
          FROM public.memberships AS membership_scope
          WHERE membership_scope.organization_id = ${table.organizationId}
            AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
            AND membership_scope.status = 'active'
        )
        AND EXISTS (
          SELECT 1
          FROM public.organizations AS organization_scope
          WHERE organization_scope.id = ${table.organizationId}
            AND organization_scope.status = 'active'
        )`,
    }),
  ]
).enableRLS();
