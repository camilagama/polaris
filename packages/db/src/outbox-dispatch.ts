import { Pool } from "pg";

/**
 * What the outbox dispatcher and the queue consumer do in the database (plan PR110, ADR 0084), under
 * their own role, which can execute a few functions and read nothing: claim the due events of every
 * organization, mark them dispatched after the queue accepted them or give them back with a delay, and
 * keep the consumer's durable record of what it processed.
 */
export interface ClaimedOutboxEvent {
  /** The claims so far, this one included: the delivery attempt the envelope carries, and the fence. */
  attempts: number;
  correlationId: string;
  event: Record<string, unknown>;
  id: string;
  idempotencyKey: string;
  organizationId: string;
  /** It was held by a run whose claim ran out (the sweep): it may have been sent already. */
  recovered: boolean;
  type: string;
}

export interface OutboxEventFence {
  attempts: number;
  id: string;
}

/** Which event a queue message says it carries: the consumer's key against a duplicate delivery. */
export interface ProcessingKey {
  attempt: number;
  eventId: string;
  idempotencyKey: string;
  organizationId: string;
  type: string;
}

export type ProcessingClaim =
  | { result: "busy" }
  | { result: "done" }
  | { result: "unknown" }
  | { result: "claimed"; token: string };

export interface OutboxClient {
  claimOutboxEvents: (
    limit: number,
    leaseSeconds: number
  ) => Promise<ClaimedOutboxEvent[]>;
  claimProcessing: (
    key: ProcessingKey,
    leaseSeconds: number
  ) => Promise<ProcessingClaim>;
  close: () => Promise<void>;
  completeProcessing: (key: ProcessingKey) => Promise<void>;
  /** Removes the finished records (and claims long dead) older than `keepHours`; returns how many. */
  expireProcessing: (keepHours: number, limit: number) => Promise<number>;
  /** Returns how many were marked: an event whose claim was taken again, or that the purge removed, is not. */
  markOutboxEventsDispatched: (
    events: readonly OutboxEventFence[]
  ) => Promise<number>;
  releaseOutboxEvents: (
    events: readonly (OutboxEventFence & { delaySeconds: number })[]
  ) => Promise<number>;
  releaseProcessing: (key: ProcessingKey, token: string) => Promise<void>;
}

const CLAIM_RESULTS = new Set(["busy", "done", "unknown"]);

export function createOutboxClient(connectionString: string): OutboxClient {
  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 5000,
    max: 1,
  });
  return {
    async claimOutboxEvents(limit, leaseSeconds) {
      const result = await pool.query<{
        attempts: number;
        correlation_id: string;
        event: Record<string, unknown>;
        id: string;
        idempotency_key: string;
        organization_id: string;
        recovered: boolean;
        type: string;
      }>(
        "SELECT id, organization_id, type, event, idempotency_key, correlation_id, attempts, recovered FROM public.claim_outbox_events($1::integer, $2::integer)",
        [limit, leaseSeconds]
      );
      return result.rows.map((row) => ({
        attempts: row.attempts,
        correlationId: row.correlation_id,
        event: row.event,
        id: row.id,
        idempotencyKey: row.idempotency_key,
        organizationId: row.organization_id,
        recovered: row.recovered,
        type: row.type,
      }));
    },
    async claimProcessing(key, leaseSeconds) {
      const result = await pool.query<{
        claimed: { result: string; token?: string };
      }>(
        "SELECT public.claim_queue_processing($1::text, $2::text, $3::text, $4::uuid, $5::integer, $6::integer) AS claimed",
        [
          key.organizationId,
          key.idempotencyKey,
          key.type,
          key.eventId,
          key.attempt,
          leaseSeconds,
        ]
      );
      const claimed = result.rows[0]?.claimed;
      if (claimed?.result === "claimed" && typeof claimed.token === "string") {
        return { result: "claimed", token: claimed.token };
      }
      if (claimed && CLAIM_RESULTS.has(claimed.result)) {
        return { result: claimed.result as "busy" | "done" | "unknown" };
      }
      throw new Error("processing_claim_unreadable");
    },
    async close() {
      await pool.end();
    },
    async completeProcessing(key) {
      await pool.query(
        "SELECT public.complete_queue_processing($1::text, $2::text, $3::uuid, $4::integer)",
        [key.organizationId, key.idempotencyKey, key.eventId, key.attempt]
      );
    },
    async expireProcessing(keepHours, limit) {
      const result = await pool.query<{ removed: number }>(
        "SELECT public.expire_queue_processing($1::integer, $2::integer) AS removed",
        [keepHours, limit]
      );
      return Number(result.rows[0]?.removed ?? 0);
    },
    async markOutboxEventsDispatched(events) {
      if (events.length === 0) {
        return 0;
      }
      const result = await pool.query<{ marked: number }>(
        "SELECT public.mark_outbox_events_dispatched($1::uuid[], $2::integer[]) AS marked",
        [events.map((event) => event.id), events.map((event) => event.attempts)]
      );
      return Number(result.rows[0]?.marked ?? 0);
    },
    async releaseOutboxEvents(events) {
      if (events.length === 0) {
        return 0;
      }
      const result = await pool.query<{ released: number }>(
        "SELECT public.release_outbox_events($1::uuid[], $2::integer[], $3::integer[]) AS released",
        [
          events.map((event) => event.id),
          events.map((event) => event.attempts),
          events.map((event) => event.delaySeconds),
        ]
      );
      return Number(result.rows[0]?.released ?? 0);
    },
    async releaseProcessing(key, token) {
      await pool.query(
        "SELECT public.release_queue_processing($1::text, $2::text, $3::uuid)",
        [key.organizationId, key.idempotencyKey, token]
      );
    },
  };
}
