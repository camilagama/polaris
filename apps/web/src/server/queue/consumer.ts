import type { OutboxEventType } from "@polaris/domain/events/outbox";
import {
  parseQueueEnvelope,
  type QueueEnvelope,
  queueForEventType,
} from "@polaris/domain/events/queue-envelope";
import type { ProcessingKey, ProcessingLedger } from "./processing-ledger";

/**
 * The generic consumer of the queues (plans PR109 and PR110, ADRs 0083 and 0084). For each message:
 * validate the envelope at the edge, take its idempotency key in the ledger (which refuses the key under
 * another event ID and, when durable, an event the outbox does not hold), run the handler of its type,
 * record it done and ack; on a failure give the key back and retry with a delay. A handler reads the
 * state it acts on by the IDs of the event, with its own authority, and never acts on the envelope alone. It knows no event type: the handlers
 * are given to it. The queue's own limit of retries ends a message that keeps failing (no dead-letter
 * queue yet: PR111).
 *
 * Nothing it logs comes from the body of a message, which could carry anything: a message is named by
 * its ID, and an error by its class, never its text.
 */

/** What the consumer needs of a message; the Cloudflare `Message` has it. */
export interface QueueMessage {
  ack: () => void;
  /** The deliveries so far, counted by the platform (1 on the first). */
  attempts: number;
  body: unknown;
  id: string;
  retry: (options?: { delaySeconds?: number }) => void;
}

export interface QueueBatch {
  messages: readonly QueueMessage[];
  /** The name of the queue it came from: `polaris-<critical|default|media>`, with an optional environment suffix. */
  queue: string;
}

export type QueueHandler = (envelope: QueueEnvelope) => Promise<void>;

/** A failure that a retry cannot fix: the message is acknowledged instead of retried. */
export class PermanentHandlerError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "PermanentHandlerError";
    this.code = code;
  }
}

export interface QueueConsumerDependencies {
  handlers: Readonly<Partial<Record<OutboxEventType, QueueHandler>>>;
  /** How long a claim holds the key while its handler runs (default: longer than the 15 minutes a consumer invocation can live). */
  leaseSeconds?: number;
  ledger: ProcessingLedger;
}

const DEFAULT_LEASE_SECONDS = 960;
const BASE_RETRY_DELAY_SECONDS = 30;
const MAX_RETRY_DELAY_SECONDS = 3600;

/** Exponential back-off from the platform's delivery count, capped. */
export function retryDelaySeconds(deliveries: number): number {
  const exponent = Math.max(0, Math.min(deliveries, 16) - 1);
  return Math.min(
    BASE_RETRY_DELAY_SECONDS * 2 ** exponent,
    MAX_RETRY_DELAY_SECONDS
  );
}

/** The SQLSTATE of a database error (five characters, no message): tells a contended claim from a database that is down. */
function sqlState(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.length === 5 ? code : undefined;
}

function errorClass(error: unknown): string {
  return error instanceof Error ? error.name : "non_error_thrown";
}

const QUEUE_NAME = /^polaris-(critical|default|media)(?:-[a-z0-9-]+)?$/;

async function processMessage(
  message: QueueMessage,
  queue: string,
  dependencies: QueueConsumerDependencies
): Promise<void> {
  const delay = retryDelaySeconds(message.attempts);
  let envelope: QueueEnvelope;
  try {
    envelope = parseQueueEnvelope(message.body);
  } catch {
    // it will not become valid: a retry would only repeat the refusal
    console.warn("queue_message_invalid", { messageId: message.id });
    message.ack();
    return;
  }
  if (QUEUE_NAME.exec(queue)?.[1] !== queueForEventType(envelope.type)) {
    // a type runs only on its own queue, so a heavy handler never runs on the queue of another weight
    console.warn("queue_message_misrouted", {
      messageId: message.id,
      type: envelope.type,
    });
    message.ack();
    return;
  }
  const handler = dependencies.handlers[envelope.type];
  if (!handler) {
    // a valid type this deploy has no handler for: retried while the retries last (no dead-letter queue yet)
    console.warn("queue_handler_missing", {
      messageId: message.id,
      type: envelope.type,
    });
    message.retry({ delaySeconds: delay });
    return;
  }
  const key: ProcessingKey = {
    attempt: envelope.attempt,
    eventId: envelope.eventId,
    idempotencyKey: envelope.idempotencyKey,
    organizationId: envelope.organizationId,
    type: envelope.type,
  };
  const { ledger } = dependencies;
  let claim: Awaited<ReturnType<ProcessingLedger["claim"]>>;
  try {
    claim = await ledger.claim(
      key,
      dependencies.leaseSeconds ?? DEFAULT_LEASE_SECONDS
    );
  } catch (error: unknown) {
    console.error("queue_ledger_unavailable", {
      errorName: errorClass(error),
      messageId: message.id,
      sqlState: sqlState(error),
    });
    message.retry({ delaySeconds: delay });
    return;
  }
  if (claim.result === "done") {
    console.info("queue_message_duplicate", {
      eventId: envelope.eventId,
      messageId: message.id,
    });
    message.ack();
    return;
  }
  if (claim.result === "unknown") {
    // the key belongs to another event, or the outbox does not hold this one (forged, or purged since):
    // it will not become known, and nothing runs on the envelope alone
    console.warn("queue_message_unknown_event", {
      eventId: envelope.eventId,
      messageId: message.id,
      reason: claim.reason,
      type: envelope.type,
    });
    message.ack();
    return;
  }
  if (claim.result === "busy") {
    // another delivery is running it: ask again later instead of running it twice
    message.retry({ delaySeconds: delay });
    return;
  }
  try {
    await handler(envelope);
  } catch (error: unknown) {
    await ledger.release(key, claim.token).catch(() => undefined);
    const permanent = error instanceof PermanentHandlerError;
    console.error("queue_message_failed", {
      code: permanent ? error.code : undefined,
      correlationId: envelope.correlationId,
      errorName: errorClass(error),
      eventId: envelope.eventId,
      messageId: message.id,
      permanent,
      type: envelope.type,
    });
    if (permanent) {
      message.ack();
    } else {
      message.retry({ delaySeconds: delay });
    }
    return;
  }
  try {
    await ledger.complete(key);
  } catch (error: unknown) {
    // the work is done: the retry finds the handler idempotent, and a ledger that is back records it then
    console.error("queue_ledger_not_recorded", {
      errorName: errorClass(error),
      eventId: envelope.eventId,
      messageId: message.id,
    });
    message.retry({ delaySeconds: delay });
    return;
  }
  message.ack();
}

/**
 * Processes a batch one message at a time (a handler may be heavy, as the data export is) and
 * decides each message alone: a failure never stops the next one.
 */
export async function handleQueueBatch(
  batch: QueueBatch,
  dependencies: QueueConsumerDependencies
): Promise<void> {
  for (const message of batch.messages) {
    // biome-ignore lint/performance/noAwaitInLoops: one message at a time; a handler may take the whole invocation.
    await processMessage(message, batch.queue, dependencies);
  }
}
