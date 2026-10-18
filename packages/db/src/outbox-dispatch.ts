import { windowsMissed } from "@polaris/domain/scheduling/scheduled-jobs";
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

/** Why the record refuses a message: the outbox does not hold that event, or the key is another event's. */
export type UnknownReason = "event_not_held" | "key_of_another_event";

export type ProcessingClaim =
  | { result: "busy" }
  | { result: "done" }
  | { reason: UnknownReason; result: "unknown" }
  | { result: "claimed"; token: string };

/** What a message on the dead-letter queue is, for the incident (ADR 0085): a cause, a subject and opaque IDs only. */
export interface DeadLetterEntry {
  cause: string;
  event: { id: string; organizationId: string } | null;
  reference: string | null;
  subject: string;
}

/**
 * What a tick learns when it asks for the lease of a scheduled job (ADR 0086): the job is not due in this
 * window, another run holds it, or it was taken (with the token that fences its outcome, how many windows
 * passed without a successful run, and whether it took over a run that died).
 */
export type ScheduledJobClaim =
  | { result: "busy" }
  | { result: "not_due" }
  | {
      missedWindows: number;
      recovered: boolean;
      result: "claimed";
      token: string;
    };

export interface OutboxClient {
  claimOutboxEvents: (
    limit: number,
    leaseSeconds: number
  ) => Promise<ClaimedOutboxEvent[]>;
  claimProcessing: (
    key: ProcessingKey,
    leaseSeconds: number
  ) => Promise<ProcessingClaim>;
  /** Asks for the lease of a scheduled job: due only once per window of `cadenceSeconds`. */
  claimScheduledJob: (
    jobId: string,
    cadenceSeconds: number,
    leaseSeconds: number
  ) => Promise<ScheduledJobClaim>;
  close: () => Promise<void>;
  completeProcessing: (key: ProcessingKey) => Promise<void>;
  /** Records a successful run; false when the lease was taken over (nothing was recorded). */
  completeScheduledJob: (jobId: string, token: string) => Promise<boolean>;
  /** Removes the finished records (and claims long dead) older than `keepHours`; returns how many. */
  expireProcessing: (keepHours: number, limit: number) => Promise<number>;
  /** Counts the message in its cause's incident and, when it names an event the outbox holds, keeps the event as dead. */
  recordDeadLetter: (entry: DeadLetterEntry) => Promise<void>;
  /** Records the events past the attempt cap as incidents and dead events; returns how many were new. */
  recordExhaustedOutboxEvents: (limit: number) => Promise<number>;
  /** Returns how many were marked: an event whose claim was taken again, or that the purge removed, is not. */
  markOutboxEventsDispatched: (
    events: readonly OutboxEventFence[]
  ) => Promise<number>;
  releaseOutboxEvents: (
    events: readonly (OutboxEventFence & { delaySeconds: number })[]
  ) => Promise<number>;
  releaseProcessing: (key: ProcessingKey, token: string) => Promise<void>;
  /** Gives the lease back without covering the windows: the next tick runs the job again. */
  releaseScheduledJob: (
    jobId: string,
    token: string,
    outcome: "failed" | "skipped"
  ) => Promise<boolean>;
}

const UNKNOWN_REASONS = new Set<string>([
  "event_not_held",
  "key_of_another_event",
]);

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
        claimed: { reason?: string; result: string; token?: string };
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
      if (claimed?.result === "busy" || claimed?.result === "done") {
        return { result: claimed.result };
      }
      if (
        claimed?.result === "unknown" &&
        typeof claimed.reason === "string" &&
        UNKNOWN_REASONS.has(claimed.reason)
      ) {
        return { reason: claimed.reason as UnknownReason, result: "unknown" };
      }
      throw new Error("processing_claim_unreadable");
    },
    async claimScheduledJob(jobId, cadenceSeconds, leaseSeconds) {
      const result = await pool.query<{
        claimed: {
          coveredAt?: number | null;
          recovered?: boolean;
          result: string;
          startedAt?: number;
          token?: string;
        };
      }>(
        "SELECT public.claim_scheduled_job($1::text, $2::integer, $3::integer) AS claimed",
        [jobId, cadenceSeconds, leaseSeconds]
      );
      const claimed = result.rows[0]?.claimed;
      if (claimed?.result === "busy" || claimed?.result === "not_due") {
        return { result: claimed.result };
      }
      if (
        claimed?.result === "claimed" &&
        typeof claimed.token === "string" &&
        typeof claimed.startedAt === "number"
      ) {
        return {
          missedWindows: windowsMissed(
            typeof claimed.coveredAt === "number"
              ? new Date(claimed.coveredAt * 1000)
              : null,
            new Date(claimed.startedAt * 1000),
            cadenceSeconds
          ),
          recovered: claimed.recovered === true,
          result: "claimed",
          token: claimed.token,
        };
      }
      throw new Error("scheduled_job_claim_unreadable");
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
    async completeScheduledJob(jobId, token) {
      const result = await pool.query<{ recorded: boolean }>(
        "SELECT public.complete_scheduled_job($1::text, $2::uuid) AS recorded",
        [jobId, token]
      );
      return result.rows[0]?.recorded === true;
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
    async recordDeadLetter(entry) {
      await pool.query(
        "SELECT public.record_dead_letter($1::text, $2::text, $3::text, $4::uuid, $5::text)",
        [
          entry.cause,
          entry.subject,
          entry.reference,
          entry.event?.id ?? null,
          entry.event?.organizationId ?? null,
        ]
      );
    },
    async recordExhaustedOutboxEvents(limit) {
      const result = await pool.query<{ recorded: number }>(
        "SELECT public.record_exhausted_outbox_events($1::integer) AS recorded",
        [limit]
      );
      return Number(result.rows[0]?.recorded ?? 0);
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
    async releaseScheduledJob(jobId, token, outcome) {
      const result = await pool.query<{ released: boolean }>(
        "SELECT public.release_scheduled_job($1::text, $2::uuid, $3::boolean) AS released",
        [jobId, token, outcome === "failed"]
      );
      return result.rows[0]?.released === true;
    },
    async releaseProcessing(key, token) {
      await pool.query(
        "SELECT public.release_queue_processing($1::text, $2::text, $3::uuid)",
        [key.organizationId, key.idempotencyKey, token]
      );
    },
  };
}
