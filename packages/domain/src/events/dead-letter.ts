import { OUTBOX_EVENT_TYPES, type OutboxEventType } from "./outbox";
import { parseQueueEnvelope, QUEUE_ENVELOPE_VERSION } from "./queue-envelope";

/**
 * The dead-letter queue (plan PR111, ADR 0085): where a queue message goes when the consumer can do
 * nothing more with it. There are two ways in. The platform moves a message that used up its retries
 * (the original envelope arrives, untouched). The consumer itself sends a message it refuses for good
 * (an envelope that does not validate, a type this deploy does not know, a queue that is not the type's
 * own): not the message, but a **notice** that says why and names it, because the body of a refused
 * message could carry anything and nothing of it may be copied into another queue or into the database.
 *
 * `classifyDeadLetter` turns what arrives on the dead-letter queue into the one record the incident
 * keeps: a cause, the event type (only when it is one the outbox declares, otherwise `unknown`), an opaque
 * reference and, when the message names an outbox event, that event's IDs. Nothing else of the message
 * is read or kept.
 */

export const DEAD_LETTER_CAUSES = Object.freeze([
  "retries_exhausted",
  "invalid_envelope",
  "unknown_type",
  "wrong_queue",
] as const);

export type DeadLetterCause = (typeof DEAD_LETTER_CAUSES)[number];

/** The cause of a message the consumer refuses for good: the ones the consumer itself sends a notice for. */
export type RefusalCause = Exclude<DeadLetterCause, "retries_exhausted">;

export const DEAD_LETTER_NOTICE_KIND = "polaris.dead_letter";
export const DEAD_LETTER_NOTICE_VERSION = 1;

/** What the consumer sends to the dead-letter queue for a message it refuses: IDs and a cause, never the body. */
export interface DeadLetterNotice {
  cause: RefusalCause;
  /** The outbox event the message names, only when its envelope was valid (a wrong queue). */
  eventId?: string;
  kind: typeof DEAD_LETTER_NOTICE_KIND;
  /** The platform's ID of the refused message: an opaque reference to find it in the logs. */
  messageId?: string;
  organizationId?: string;
  type?: OutboxEventType;
  version: typeof DEAD_LETTER_NOTICE_VERSION;
}

export interface DeadLetterNoticeInput {
  cause: RefusalCause;
  eventId?: string;
  messageId: string;
  organizationId?: string;
  type?: OutboxEventType;
}

/** What an incident keeps of a dead message. */
export interface DeadLetterRecord {
  cause: DeadLetterCause;
  /** The outbox event the message names (both or neither): the Admin can send it again. */
  event: { id: string; organizationId: string } | null;
  /** An opaque ID of the message or the event, to find it in the logs. */
  reference: string | null;
  /** The event type, or `unknown` when the message did not carry a valid one. */
  subject: OutboxEventType | "unknown";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9._:-]{1,128}$/;
const NOTICE_FIELDS = new Set([
  "cause",
  "eventId",
  "kind",
  "messageId",
  "organizationId",
  "type",
  "version",
]);
const REFUSAL_CAUSES: readonly string[] = [
  "invalid_envelope",
  "unknown_type",
  "wrong_queue",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEventType(value: unknown): value is OutboxEventType {
  return (
    typeof value === "string" &&
    (OUTBOX_EVENT_TYPES as readonly string[]).includes(value)
  );
}

/** A reference is kept only when it is a plain token: anything else is dropped, never trimmed or escaped. */
function referenceOf(value: unknown): string | null {
  return typeof value === "string" && TOKEN.test(value) ? value : null;
}

/** The notice the consumer sends for a message it refuses for good. */
export function deadLetterNotice(
  input: DeadLetterNoticeInput
): DeadLetterNotice {
  const notice: DeadLetterNotice = {
    cause: input.cause,
    kind: DEAD_LETTER_NOTICE_KIND,
    version: DEAD_LETTER_NOTICE_VERSION,
  };
  const messageId = referenceOf(input.messageId);
  if (messageId) {
    notice.messageId = messageId;
  }
  // the event is named only whole, and only when its type is one the outbox declares
  if (
    input.eventId &&
    UUID.test(input.eventId) &&
    input.organizationId &&
    TOKEN.test(input.organizationId) &&
    isEventType(input.type)
  ) {
    notice.eventId = input.eventId;
    notice.organizationId = input.organizationId;
    notice.type = input.type;
  }
  return notice;
}

const TYPE_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/**
 * Why a body that is no valid envelope is refused: `unknown_type` when it names an event type the outbox
 * does not declare (well formed, from a producer newer than this deploy) or a version this deploy does not
 * read, `invalid_envelope` for anything else. Neither value is kept, only the cause.
 */
export function refusalCauseOf(
  body: unknown
): Extract<RefusalCause, "invalid_envelope" | "unknown_type"> {
  if (!isRecord(body)) {
    return "invalid_envelope";
  }
  const unknownType =
    typeof body.type === "string" &&
    body.type.length <= 80 &&
    TYPE_NAME.test(body.type) &&
    !isEventType(body.type);
  const unknownVersion =
    typeof body.version === "number" &&
    Number.isSafeInteger(body.version) &&
    body.version > QUEUE_ENVELOPE_VERSION;
  return unknownType || unknownVersion ? "unknown_type" : "invalid_envelope";
}

/** A notice that does not hold exactly what the consumer sends is no notice: it is classified as an invalid envelope. */
function parseNotice(raw: Record<string, unknown>): DeadLetterRecord | null {
  if (
    raw.kind !== DEAD_LETTER_NOTICE_KIND ||
    raw.version !== DEAD_LETTER_NOTICE_VERSION ||
    Object.keys(raw).some((field) => !NOTICE_FIELDS.has(field)) ||
    typeof raw.cause !== "string" ||
    !REFUSAL_CAUSES.includes(raw.cause)
  ) {
    return null;
  }
  const named = [raw.eventId, raw.organizationId, raw.type].filter(
    (value) => value !== undefined
  );
  if (named.length !== 0 && named.length !== 3) {
    return null;
  }
  if (named.length === 3) {
    if (
      typeof raw.eventId !== "string" ||
      !UUID.test(raw.eventId) ||
      typeof raw.organizationId !== "string" ||
      !TOKEN.test(raw.organizationId) ||
      !isEventType(raw.type)
    ) {
      return null;
    }
    return {
      cause: raw.cause as DeadLetterCause,
      event: { id: raw.eventId, organizationId: raw.organizationId },
      reference: referenceOf(raw.messageId) ?? raw.eventId,
      subject: raw.type,
    };
  }
  return {
    cause: raw.cause as DeadLetterCause,
    event: null,
    reference: referenceOf(raw.messageId),
    subject: "unknown",
  };
}

/**
 * What a message on the dead-letter queue means. A notice from the consumer says its own cause; a valid
 * envelope is a message the platform moved after its retries; anything else is an envelope that never
 * validated (the platform moved a message the consumer kept retrying, or someone wrote to the queue).
 * The `messageId` is the dead-letter queue's own ID of the message, the reference when the body has none.
 */
export function classifyDeadLetter(
  body: unknown,
  messageId: string
): DeadLetterRecord {
  const fallback = referenceOf(messageId);
  if (isRecord(body)) {
    if (body.kind === DEAD_LETTER_NOTICE_KIND) {
      const notice = parseNotice(body);
      if (notice) {
        return { ...notice, reference: notice.reference ?? fallback };
      }
    } else {
      try {
        const envelope = parseQueueEnvelope(body);
        return {
          cause: "retries_exhausted",
          event: {
            id: envelope.eventId,
            organizationId: envelope.organizationId,
          },
          reference: envelope.eventId,
          subject: envelope.type,
        };
      } catch {
        // not an envelope: classified below
      }
    }
  }
  return {
    cause: "invalid_envelope",
    event: null,
    reference: fallback,
    subject: "unknown",
  };
}
