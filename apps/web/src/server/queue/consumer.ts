import {
  type DeadLetterNotice,
  deadLetterNotice,
  refusalCauseOf,
} from "@polaris/domain/events/dead-letter";
import type { OutboxEventType } from "@polaris/domain/events/outbox";
import {
  parseQueueEnvelope,
  type QueueEnvelope,
  queueForEventType,
} from "@polaris/domain/events/queue-envelope";
import { logger } from "@polaris/observability/logger";
import { describeError } from "@polaris/observability/wide-event";
import type { ProcessingKey, ProcessingLedger } from "./processing-ledger";

/**
 * The generic consumer of the queues (plans PR109 and PR110, ADRs 0083 and 0084). For each message:
 * validate the envelope at the edge, take its idempotency key in the ledger (which refuses the key under
 * another event ID and, when durable, an event the outbox does not hold), run the handler of its type,
 * record it done and ack; on a failure give the key back and retry with a delay. A handler reads the
 * state it acts on by the IDs of the event, with its own authority, and never acts on the envelope alone. It knows no event type: the handlers
 * are given to it. The queue's own limit of retries ends a message that keeps failing: the platform moves
 * it to the dead-letter queue (PR111, ADR 0085). A message it refuses for good (an envelope that does not
 * validate, a type or version it does not know, a queue that is not the type's own) it sends there itself,
 * as a notice that names the cause and the message and carries none of its body.
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

/**
 * Every type of the outbox has its handler: what the Worker binds (a type with none spins on `queue_handler_missing`
 * until the dead-letter queue). The consumer itself takes a partial map, so a test can bind only the type it exercises.
 */
export type QueueHandlers = Record<OutboxEventType, QueueHandler>;

/** A failure that a retry cannot fix: the message is acknowledged instead of retried. */
export class PermanentHandlerError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "PermanentHandlerError";
    this.code = code;
  }
}

/**
 * The handler asks for the same message again in `delaySeconds` (a billing notice not yet due, ADR 0104): not a
 * failure, so it is logged as information; the platform still counts the delivery.
 */
export class DeferredHandlerError extends Error {
  readonly delaySeconds: number;

  constructor(delaySeconds: number) {
    super("queue_message_deferred");
    this.name = "DeferredHandlerError";
    this.delaySeconds = delaySeconds;
  }
}

/** What the consumer needs of the producer of the dead-letter queue. */
export interface DeadLetterProducer {
  send: (
    notice: DeadLetterNotice,
    options?: { contentType?: "json" }
  ) => Promise<unknown>;
}

export interface QueueConsumerDependencies {
  /** Where a message refused for good goes; without it (local development) the message is only dropped, with a warning. */
  deadLetters?: DeadLetterProducer | undefined;
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

/**
 * A message refused for good goes to the dead-letter queue as a notice (never its body) and is
 * acknowledged only after the queue took the notice: if sending fails the message is retried (and, past
 * the platform's retries, the platform moves it there itself). Without the producer it is dropped.
 */
async function refuse(
  message: QueueMessage,
  dependencies: QueueConsumerDependencies,
  delay: number,
  input: Parameters<typeof deadLetterNotice>[0]
): Promise<void> {
  const { deadLetters } = dependencies;
  if (!deadLetters) {
    logger.warn("queue_dead_letter_not_configured", {
      messageId: message.id,
    });
    message.ack();
    return;
  }
  try {
    await deadLetters.send(deadLetterNotice(input), { contentType: "json" });
  } catch (error: unknown) {
    logger.error("queue_dead_letter_send_failed", {
      cause: input.cause,
      ...describeError(error),
      messageId: message.id,
    });
    message.retry({ delaySeconds: delay });
    return;
  }
  message.ack();
}

const QUEUE_NAME = /^polaris-(critical|default|media)(?:-[a-z0-9-]+)?$/;

/** The lane of a queue name (`polaris-default-staging` is `default`), or undefined for another queue. */
export function queueLaneOf(queue: string): string | undefined {
  return QUEUE_NAME.exec(queue)?.[1];
}

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
    const cause = refusalCauseOf(message.body);
    logger.warn("queue_message_invalid", { cause, messageId: message.id });
    await refuse(message, dependencies, delay, {
      cause,
      messageId: message.id,
    });
    return;
  }
  if (queueLaneOf(queue) !== queueForEventType(envelope.type)) {
    // a type runs only on its own queue, so a heavy handler never runs on the queue of another weight
    logger.warn("queue_message_misrouted", {
      eventType: envelope.type,
      messageId: message.id,
    });
    await refuse(message, dependencies, delay, {
      cause: "wrong_queue",
      eventId: envelope.eventId,
      messageId: message.id,
      organizationId: envelope.organizationId,
      type: envelope.type,
    });
    return;
  }
  const handler = dependencies.handlers[envelope.type];
  if (!handler) {
    // a valid type this deploy has no handler for: retried while the retries last, then the platform moves it to the dead-letter queue
    logger.warn("queue_handler_missing", {
      eventType: envelope.type,
      messageId: message.id,
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
    logger.error("queue_ledger_unavailable", {
      ...describeError(error),
      messageId: message.id,
      sqlState: sqlState(error),
    });
    message.retry({ delaySeconds: delay });
    return;
  }
  if (claim.result === "done") {
    logger.info("queue_message_duplicate", {
      eventId: envelope.eventId,
      messageId: message.id,
    });
    message.ack();
    return;
  }
  if (claim.result === "unknown") {
    // the key belongs to another event, or the outbox does not hold this one (forged, or purged since):
    // it will not become known, and nothing runs on the envelope alone
    logger.warn("queue_message_unknown_event", {
      eventId: envelope.eventId,
      eventType: envelope.type,
      messageId: message.id,
      reason: claim.reason,
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
    if (error instanceof DeferredHandlerError) {
      logger.info("queue_message_deferred", {
        delaySeconds: error.delaySeconds,
        eventId: envelope.eventId,
        eventType: envelope.type,
        messageId: message.id,
      });
      message.retry({ delaySeconds: error.delaySeconds });
      return;
    }
    const permanent = error instanceof PermanentHandlerError;
    logger.error("queue_message_failed", {
      correlationId: envelope.correlationId,
      ...describeError(error),
      eventId: envelope.eventId,
      eventType: envelope.type,
      messageId: message.id,
      permanent,
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
    logger.error("queue_ledger_not_recorded", {
      ...describeError(error),
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
