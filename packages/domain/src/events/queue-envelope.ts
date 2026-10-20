import {
  OUTBOX_EVENT_TYPES,
  type OutboxEventBody,
  type OutboxEventType,
  outboxEvent,
} from "./outbox";

/**
 * The envelope of a queue message (plan PR109, ADR 0083): what the dispatcher (PR110) sends for an
 * outbox event and what the consumer receives. It carries the event the outbox holds, nothing more:
 * the same opaque IDs, integers and booleans (never a name, an e-mail, a phone or a note), because a
 * message is a hint that something happened and the consumer reads the current state itself, with its
 * own authority. The consumer validates it at the edge, before trusting any field.
 */

/** The three queues of the plan, by how much a late message costs. */
export const QUEUE_NAMES = Object.freeze([
  "critical",
  "default",
  "media",
] as const);

export type QueueName = (typeof QUEUE_NAMES)[number];

export const QUEUE_ENVELOPE_VERSION = 1;

/** The most deliveries the envelope counts; past it the message is not valid. */
export const QUEUE_ENVELOPE_MAX_ATTEMPT = 1000;

/** The queue each event type travels on: a new type declares its queue here, with the type itself. */
const QUEUE_BY_EVENT_TYPE: Readonly<Record<OutboxEventType, QueueName>> =
  Object.freeze({
    "data_export.requested": "default",
    // a renewal left alive charges the person: the queue of what costs most when late
    "billing.renewal_cancel_requested": "critical",
    // an e-mail of a milestone: a late one is still on time for the dates it names (7 days at least)
    "organization.closure_notice": "default",
  });

export interface QueueEnvelope {
  /** The delivery try, from 1: the dispatcher counts it; the platform's own count is the consumer's to read. */
  attempt: number;
  /** The trace of the request that caused the event, carried from the outbox. */
  correlationId: string;
  event: OutboxEventBody;
  /** The ID of the outbox row (UUID v7). */
  eventId: string;
  /** One per event and organization: the consumer's key against a duplicate delivery. */
  idempotencyKey: string;
  organizationId: string;
  type: OutboxEventType;
  version: typeof QUEUE_ENVELOPE_VERSION;
}

export type QueueEnvelopeInput = Omit<QueueEnvelope, "version">;

export class InvalidQueueEnvelopeError extends Error {
  readonly code = "invalid_queue_envelope";

  constructor() {
    super("invalid_queue_envelope");
    this.name = "InvalidQueueEnvelopeError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENVELOPE_FIELDS = new Set([
  "attempt",
  "correlationId",
  "event",
  "eventId",
  "idempotencyKey",
  "organizationId",
  "type",
  "version",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The queue an event type travels on. */
export function queueForEventType(type: OutboxEventType): QueueName {
  return QUEUE_BY_EVENT_TYPE[type];
}

/**
 * Checks a message body that came from the queue (or an envelope about to be sent) and returns it
 * typed. Everything is checked: the version, every field (an unknown one is refused), the event type,
 * and the event itself by the rules of the outbox. It throws `InvalidQueueEnvelopeError`, which says
 * nothing about the content, so the message can be logged by its ID alone.
 */
export function parseQueueEnvelope(raw: unknown): QueueEnvelope {
  if (!isRecord(raw)) {
    throw new InvalidQueueEnvelopeError();
  }
  if (Object.keys(raw).some((field) => !ENVELOPE_FIELDS.has(field))) {
    throw new InvalidQueueEnvelopeError();
  }
  const { attempt, correlationId, eventId, idempotencyKey, organizationId } =
    raw;
  if (
    raw.version !== QUEUE_ENVELOPE_VERSION ||
    typeof attempt !== "number" ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    attempt > QUEUE_ENVELOPE_MAX_ATTEMPT ||
    typeof eventId !== "string" ||
    !UUID.test(eventId) ||
    typeof correlationId !== "string" ||
    typeof idempotencyKey !== "string" ||
    typeof organizationId !== "string" ||
    typeof raw.type !== "string" ||
    !(OUTBOX_EVENT_TYPES as readonly string[]).includes(raw.type)
  ) {
    throw new InvalidQueueEnvelopeError();
  }
  let event: ReturnType<typeof outboxEvent> | null;
  try {
    // the outbox owns the rules for the event, its key, its organization and its correlation
    event = outboxEvent({
      correlationId,
      event: raw.event as OutboxEventBody,
      idempotencyKey,
      organizationId,
      type: raw.type,
    });
  } catch {
    event = null;
  }
  if (!event) {
    throw new InvalidQueueEnvelopeError();
  }
  return {
    attempt,
    correlationId,
    event: event.event,
    eventId,
    idempotencyKey: event.idempotencyKey,
    organizationId: event.organizationId,
    type: event.type,
    version: QUEUE_ENVELOPE_VERSION,
  };
}

/** Builds the envelope of an outbox event for sending; it is checked by the same rules the consumer applies. */
export function queueEnvelope(input: QueueEnvelopeInput): QueueEnvelope {
  return parseQueueEnvelope({ ...input, version: QUEUE_ENVELOPE_VERSION });
}
