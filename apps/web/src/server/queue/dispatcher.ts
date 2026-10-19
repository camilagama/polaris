import { logger } from "@polaris/observability/logger";
import { describeError } from "@polaris/observability/wide-event";
import type { OutboxEventBody } from "@polaris/domain/events/outbox";
import {
  OUTBOX_DISPATCH_BATCH,
  OUTBOX_DISPATCH_LEASE_SECONDS,
  OUTBOX_UNSENDABLE_DELAY_SECONDS,
  outboxRetryDelaySeconds,
} from "@polaris/domain/events/outbox-dispatch";
import {
  type QueueEnvelope,
  type QueueName,
  queueEnvelope,
  queueForEventType,
} from "@polaris/domain/events/queue-envelope";

/**
 * The outbox dispatcher and sweeper (plan PR110, ADR 0084): pending event in the database → queue →
 * marked dispatched. One run claims a batch of due events (and, the sweep, those whose claim outlived
 * the run that held it), sends them with one `sendBatch` per queue, marks dispatched what the queue
 * accepted and gives the rest back with a delay. Crash-safe by order: the mark comes only after the
 * send, so a run that dies in between leaves the claim to run out and the event is sent again (a
 * duplicate, which the consumer and the handlers absorb). Nothing here reads the body beyond building
 * the envelope, and nothing logged comes from it.
 */

export interface DispatchedEvent {
  attempts: number;
  correlationId: string;
  event: Record<string, unknown>;
  id: string;
  idempotencyKey: string;
  organizationId: string;
  recovered: boolean;
  type: string;
}

/** What the dispatcher needs of the database client (`@polaris/db/outbox-dispatch`). */
export interface DispatchStore {
  claimOutboxEvents: (
    limit: number,
    leaseSeconds: number
  ) => Promise<DispatchedEvent[]>;
  markOutboxEventsDispatched: (
    events: readonly { attempts: number; id: string }[]
  ) => Promise<number>;
  releaseOutboxEvents: (
    events: readonly { attempts: number; delaySeconds: number; id: string }[]
  ) => Promise<number>;
}

/** What the dispatcher needs of a Cloudflare queue producer. */
export interface QueueProducer {
  sendBatch: (
    messages: Iterable<{ body: QueueEnvelope; contentType?: "json" }>
  ) => Promise<unknown>;
}

export interface DispatchReport {
  claimed: number;
  /** Claims that had run out (the sweep): these events may arrive twice. */
  recovered: number;
  /** Given back for a later run: the queue refused them, or the queue is not bound here. */
  released: number;
  sent: number;
  /** Sent, but not marked (the claim was taken again, or the purge removed the event): sent again later or never needed. */
  unmarked: number;
  /** This deploy cannot build their envelope (a type or body it does not know): they wait the longest. */
  unsendable: number;
}

export interface DispatchDependencies {
  /** How many events one run takes (default: the dispatch batch). */
  limit?: number;
  queues: Readonly<Partial<Record<QueueName, QueueProducer | undefined>>>;
  store: DispatchStore;
}

function envelopeOf(row: DispatchedEvent): QueueEnvelope | null {
  try {
    return queueEnvelope({
      attempt: row.attempts,
      correlationId: row.correlationId,
      event: row.event as OutboxEventBody,
      eventId: row.id,
      idempotencyKey: row.idempotencyKey,
      organizationId: row.organizationId,
      type: row.type as QueueEnvelope["type"],
    });
  } catch {
    return null;
  }
}

/** One dispatcher run. A failure to send one queue's batch never stops another queue's. */
export async function dispatchOutbox(
  dependencies: DispatchDependencies
): Promise<DispatchReport> {
  const { queues, store } = dependencies;
  const claimed = await store.claimOutboxEvents(
    dependencies.limit ?? OUTBOX_DISPATCH_BATCH,
    OUTBOX_DISPATCH_LEASE_SECONDS
  );
  const report: DispatchReport = {
    claimed: claimed.length,
    recovered: claimed.filter((row) => row.recovered).length,
    released: 0,
    sent: 0,
    unmarked: 0,
    unsendable: 0,
  };
  if (claimed.length === 0) {
    return report;
  }

  const byQueue = new Map<
    QueueName,
    { envelope: QueueEnvelope; row: DispatchedEvent }[]
  >();
  const giveBack: { attempts: number; delaySeconds: number; id: string }[] = [];
  for (const row of claimed) {
    const envelope = envelopeOf(row);
    if (!envelope) {
      // an older deploy, or a row it refuses: it waits the longest and stops being claimed at the cap (and becomes an incident, ADR 0085)
      logger.warn("outbox_event_unsendable", {
        attempt: row.attempts,
        eventId: row.id,
      });
      report.unsendable += 1;
      giveBack.push({
        attempts: row.attempts,
        delaySeconds: OUTBOX_UNSENDABLE_DELAY_SECONDS,
        id: row.id,
      });
      continue;
    }
    const queue = queueForEventType(envelope.type);
    const group = byQueue.get(queue) ?? [];
    group.push({ envelope, row });
    byQueue.set(queue, group);
  }

  const sent: { attempts: number; id: string }[] = [];
  for (const [queue, group] of byQueue) {
    const producer = queues[queue];
    try {
      if (!producer) {
        throw new Error("queue_not_bound");
      }
      // biome-ignore lint/performance/noAwaitInLoops: one batch per queue; a refusal of one never hides the others.
      await producer.sendBatch(
        group.map(({ envelope }) => ({ body: envelope, contentType: "json" }))
      );
      for (const { row } of group) {
        sent.push({ attempts: row.attempts, id: row.id });
      }
    } catch (error: unknown) {
      // the daily quota of the Free plan, the queue down or not bound: the events stay pending
      logger.error("outbox_send_failed", {
        count: group.length,
        ...describeError(error),
        queue,
      });
      for (const { row } of group) {
        giveBack.push({
          attempts: row.attempts,
          delaySeconds: outboxRetryDelaySeconds(row.attempts),
          id: row.id,
        });
      }
    }
  }
  report.sent = sent.length;

  // the mark comes after the send: if it fails, the claims run out and the events are sent again
  let markFailure: unknown = null;
  try {
    report.unmarked =
      sent.length - (await store.markOutboxEventsDispatched(sent));
  } catch (error: unknown) {
    markFailure = error;
    report.unmarked = sent.length;
  }
  if (giveBack.length > 0) {
    report.released = await store.releaseOutboxEvents(giveBack);
  }
  if (markFailure) {
    throw markFailure;
  }
  return report;
}
