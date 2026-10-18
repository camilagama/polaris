import {
  type OutboxEventInput,
  outboxEvent,
} from "@polaris/domain/events/outbox";
import { sql } from "drizzle-orm";
import type { TenantRequestTransaction } from "./tenant-transaction";

/**
 * Writes an event to the transactional outbox (plan PR108, ADR 0082) in the transaction of the command
 * that causes it, so the two stand or fall together: if the command rolls back, the event never
 * existed; if it commits, the event is there for the dispatcher (PR110). The event is checked first and
 * carries only opaque IDs; the database repeats the rules and, for the tenant runtime, accepts only the
 * listed types, in the transaction's own organization. Writing the same idempotency key again is a
 * no-op, so a repeated command leaves one event. Without a correlation from the caller, the event
 * starts a trace of its own.
 */
export async function recordOutboxEvent(
  transaction: TenantRequestTransaction,
  input: OutboxEventInput
): Promise<void> {
  const event = outboxEvent(input);
  // only the five columns the tenant role may insert are named: the ID, the status, the attempts and
  // the times are the table's own (even a DEFAULT in the column list needs the privilege)
  await transaction.execute(sql`
    INSERT INTO public.event_outbox (organization_id, type, event, idempotency_key, correlation_id)
    VALUES (${event.organizationId}, ${event.type}, ${JSON.stringify(event.event)}::jsonb, ${event.idempotencyKey}, ${event.correlationId ?? crypto.randomUUID()})
    ON CONFLICT DO NOTHING
  `);
}
