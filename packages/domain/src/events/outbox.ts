/**
 * The transactional outbox (plan PR108, ADR 0082): an event is written in the same transaction as the
 * command that causes it, and something else (the dispatcher of PR110) takes it from there. This is the
 * executable statement of what an event can be. The database repeats the shape rules (CHECKs of
 * `event_outbox`).
 *
 * An event is a hint that something happened, never the data: it names the thing with opaque IDs and
 * the consumer reads the current state itself, with its own authority. So the body holds only opaque
 * IDs (letters, digits, `-` and `_`, up to 64), integers and booleans: free text, which is where a
 * name, an e-mail or a note would be, cannot be written.
 */

/** The events the tenant runtime may write. A new one is a reviewed migration (the policy lists them). */
export const OUTBOX_EVENT_TYPES = Object.freeze([
  "data_export.requested",
] as const);

export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];

/**
 * The keys the body of each type holds, exactly: a key the type does not declare is refused, even with
 * a valid value, so nothing rides along a hint (the database policy repeats it per type).
 */
const OUTBOX_EVENT_KEYS: Readonly<Record<OutboxEventType, readonly string[]>> =
  Object.freeze({
    "data_export.requested": Object.freeze(["exportId"]),
  });
export type OutboxEventValue = string | number | boolean;
export type OutboxEventBody = Readonly<Record<string, OutboxEventValue>>;

export interface OutboxEventInput {
  /** The trace of the request that caused it; a new one starts when the caller has none. */
  correlationId?: string | null;
  event: OutboxEventBody;
  /** One per event: writing the same key again changes nothing. Build it with `outboxIdempotencyKey`. */
  idempotencyKey: string;
  organizationId: string;
  type: string;
}

export interface OutboxEvent {
  correlationId: string | null;
  event: OutboxEventBody;
  idempotencyKey: string;
  organizationId: string;
  type: OutboxEventType;
}

export class InvalidOutboxEventError extends Error {
  readonly code = "invalid_outbox_event";

  constructor() {
    super("invalid_outbox_event");
    this.name = "InvalidOutboxEventError";
  }
}

export const OUTBOX_EVENT_MAX_KEYS = 16;
export const OUTBOX_EVENT_MAX_BYTES = 2048;

const OPAQUE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const BODY_KEY = /^[a-z][A-Za-z0-9]{0,31}$/;
const TOKEN = /^[A-Za-z0-9._:-]{1,128}$/;
const INPUT_FIELDS = new Set([
  "correlationId",
  "event",
  "idempotencyKey",
  "organizationId",
  "type",
]);

function isEventType(type: string): type is OutboxEventType {
  return (OUTBOX_EVENT_TYPES as readonly string[]).includes(type);
}

function isBodyValue(value: unknown): value is OutboxEventValue {
  return (
    typeof value === "boolean" ||
    Number.isSafeInteger(value) ||
    (typeof value === "string" && OPAQUE_ID.test(value))
  );
}

function hasDeclaredKeys(
  type: OutboxEventType,
  body: readonly [string, unknown][]
): boolean {
  const declared = OUTBOX_EVENT_KEYS[type];
  return (
    body.length === declared.length &&
    body.every(([key]) => declared.includes(key))
  );
}

/** The key of an event about one thing: the type and the ID of the thing, so a repeated command repeats the key. */
export function outboxIdempotencyKey(type: string, entityId: string): string {
  return `${type}:${entityId}`;
}

/** Checks an event before it is written and returns it with every field present. */
export function outboxEvent(input: OutboxEventInput): OutboxEvent {
  if (Object.keys(input as object).some((field) => !INPUT_FIELDS.has(field))) {
    throw new InvalidOutboxEventError();
  }
  const { idempotencyKey, organizationId, type } = input;
  const event: unknown = input.event;
  const correlationId = input.correlationId ?? null;
  const body =
    typeof event === "object" && event !== null && !Array.isArray(event)
      ? Object.entries(event)
      : null;
  if (
    !(
      body &&
      isEventType(String(type)) &&
      OPAQUE_ID.test(String(organizationId)) &&
      TOKEN.test(String(idempotencyKey)) &&
      (correlationId === null || TOKEN.test(String(correlationId))) &&
      body.length <= OUTBOX_EVENT_MAX_KEYS &&
      body.every(([key, value]) => BODY_KEY.test(key) && isBodyValue(value)) &&
      hasDeclaredKeys(type as OutboxEventType, body) &&
      JSON.stringify(event).length <= OUTBOX_EVENT_MAX_BYTES
    )
  ) {
    throw new InvalidOutboxEventError();
  }
  return {
    correlationId,
    event: input.event,
    idempotencyKey,
    organizationId,
    type: type as OutboxEventType,
  };
}
