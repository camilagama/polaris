import { logger } from "@polaris/observability/logger";
import { describeError } from "@polaris/observability/wide-event";
import { classifyDeadLetter } from "@polaris/domain/events/dead-letter";
import { type QueueBatch, retryDelaySeconds } from "./consumer";

/**
 * The consumer of the dead-letter queue (plan PR111, ADR 0085). Each message becomes one count in the
 * incident of its cause and, when it names an event the outbox holds, that event is kept as dead so an
 * operator can send it again from the Admin. The message is acknowledged only after it was recorded; a
 * database that is down retries it. It reads the body only through `classifyDeadLetter`, which keeps a
 * cause, an event type the outbox declares, an opaque reference and the event's IDs, nothing else, and
 * nothing it logs comes from the body.
 */

/** What this consumer needs of the database (`@polaris/db/outbox-dispatch`). */
export interface DeadLetterStore {
  recordDeadLetter: (entry: {
    cause: string;
    event: { id: string; organizationId: string } | null;
    reference: string | null;
    subject: string;
  }) => Promise<void>;
}

/** `polaris-dlq`, with an optional environment suffix like the other queues (`polaris-dlq-staging`). */
const DEAD_LETTER_QUEUE_NAME = /^polaris-dlq(?:-[a-z0-9-]+)?$/;

export function isDeadLetterQueue(queue: string): boolean {
  return DEAD_LETTER_QUEUE_NAME.test(queue);
}

export async function handleDeadLetterBatch(
  batch: QueueBatch,
  store: DeadLetterStore
): Promise<void> {
  for (const message of batch.messages) {
    const record = classifyDeadLetter(message.body, message.id);
    try {
      // biome-ignore lint/performance/noAwaitInLoops: one message at a time, like the other consumers.
      await store.recordDeadLetter(record);
    } catch (error: unknown) {
      logger.error("queue_dead_letter_not_recorded", {
        ...describeError(error),
        messageId: message.id,
      });
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
      continue;
    }
    logger.warn("queue_dead_letter_recorded", {
      cause: record.cause,
      messageId: message.id,
      subject: record.subject,
    });
    message.ack();
  }
}
