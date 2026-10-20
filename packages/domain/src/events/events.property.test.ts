import {
  anything,
  boolean,
  constant,
  constantFrom,
  double,
  integer,
  json,
  oneof,
  property,
  record,
  string,
  stringMatching,
  tuple,
  uuid,
} from "fast-check";
import { describe, expect, it } from "vitest";
import { assertProperty, minimumSeen } from "../testing/property";
import {
  classifyDeadLetter,
  DEAD_LETTER_CAUSES,
  deadLetterNotice,
  type RefusalCause,
} from "./dead-letter";
import {
  OUTBOX_MAX_DISPATCH_ATTEMPTS,
  OUTBOX_UNSENDABLE_DELAY_SECONDS,
  outboxRetryDelaySeconds,
} from "./outbox-dispatch";
import {
  InvalidOutboxEventError,
  OUTBOX_EVENT_TYPES,
  outboxEvent,
  outboxIdempotencyKey,
} from "./outbox";
import {
  InvalidQueueEnvelopeError,
  parseQueueEnvelope,
  QUEUE_ENVELOPE_MAX_ATTEMPT,
  QUEUE_NAMES,
  queueEnvelope,
  queueForEventType,
} from "./queue-envelope";

/*
 * Invariants of the events area (docs/testing/property-invariants.md, EVT-1 to EVT-7): the retry
 * schedule, the shape of an outbox event, the queue envelope and the dead-letter classification. The
 * oracles are a loop for the schedule and character-set loops for the identifier rules.
 */

const OPAQUE_CHARACTERS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
const TOKEN_CHARACTERS = `${OPAQUE_CHARACTERS}.:`;
const LOWER_HEX = "0123456789abcdef";

function allIn(text: unknown, characters: string, maxLength: number): boolean {
  return (
    typeof text === "string" &&
    text.length >= 1 &&
    text.length <= maxLength &&
    [...text].every((char) => characters.includes(char))
  );
}
const isOpaqueId = (text: unknown) => allIn(text, OPAQUE_CHARACTERS, 64);
const isToken = (text: unknown) => allIn(text, TOKEN_CHARACTERS, 128);
/** 8-4-4-4-12 lowercase hex (the envelope does not check the version digit). */
function isLowerHexUuid(text: unknown): boolean {
  if (typeof text !== "string" || text.length !== 36) {
    return false;
  }
  return [...text].every((char, index) =>
    [8, 13, 18, 23].includes(index) ? char === "-" : LOWER_HEX.includes(char)
  );
}

const opaqueId = stringMatching(/^[A-Za-z0-9_-]{1,64}$/);
const token = stringMatching(/^[A-Za-z0-9._:-]{1,128}$/);
// a value that is usually wrong: free text, spaces, e-mail-like, empty, too long
const looseText = oneof(
  string({ maxLength: 80 }),
  constantFrom(
    "",
    "a b",
    "ana@example.com",
    "x".repeat(65),
    "x".repeat(129),
    "ação",
    "a/b",
    "a.b"
  )
);

// ---------------------------------------------------------------------------------------------
// Dispatch schedule
// ---------------------------------------------------------------------------------------------

/** Thirty seconds, doubling with each claim after the first, never over an hour. */
function modelDelay(attempts: number): number {
  let delay = 30;
  for (let claim = 2; claim <= Math.min(attempts, 17); claim += 1) {
    delay = Math.min(delay * 2, 3600);
  }
  return delay;
}

describe("outbox retry schedule (EVT-1)", () => {
  it("EVT-1: the delay follows the doubling model, never drops with more attempts, and stays between 30 s and an hour", () => {
    const attempts = oneof(
      integer({ max: 40, min: -3 }),
      integer({ max: OUTBOX_MAX_DISPATCH_ATTEMPTS, min: 0 })
    );
    assertProperty(
      property(attempts, (count) => {
        const delay = outboxRetryDelaySeconds(count);
        expect(delay).toBe(modelDelay(count));
        expect(delay).toBeGreaterThanOrEqual(30);
        expect(delay).toBeLessThanOrEqual(OUTBOX_UNSENDABLE_DELAY_SECONDS);
        expect(outboxRetryDelaySeconds(count + 1)).toBeGreaterThanOrEqual(
          delay
        );
      })
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Outbox event
// ---------------------------------------------------------------------------------------------

const bodyValue = oneof(
  opaqueId,
  looseText,
  integer(),
  double({ noNaN: true }),
  boolean(),
  constant(null),
  constant(undefined),
  constant({ nested: "x" })
);
const eventBody = oneof(
  record({ exportId: bodyValue }),
  record({ exportId: opaqueId }),
  record({ exportId: opaqueId, note: bodyValue }),
  record({ other: bodyValue }),
  constant({}),
  constant(null),
  constant(["exportId"])
);
// a valid event with at most one part spoiled, so most cases reach the deep checks; the text fields are
// spoiled with text, because the types promise strings (see "Achados" in docs/testing/property-invariants.md)
const outboxInput = tuple(
  record({
    correlationId: oneof(constant(undefined), constant(null), token),
    event: opaqueId.map((exportId) => ({ exportId })),
    idempotencyKey: token,
    organizationId: opaqueId,
    type: constantFrom(...OUTBOX_EVENT_TYPES),
  }),
  constantFrom(
    "correlationId",
    "event",
    "idempotencyKey",
    "organizationId",
    "type",
    "none",
    "none"
  ),
  looseText,
  eventBody
).map(([event, part, text, body]) => {
  const input: Record<string, unknown> & {
    event: unknown;
    idempotencyKey: unknown;
    organizationId: unknown;
    type: unknown;
  } = { ...event };
  if (part === "event") {
    input.event = body;
  } else if (part !== "none") {
    input[part] = text;
  }
  return input;
});

/** An event is valid when its type is declared, its body holds exactly the declared keys and only opaque IDs, integers or booleans. */
function outboxModelAccepts(input: {
  correlationId?: unknown;
  event: unknown;
  idempotencyKey: unknown;
  organizationId: unknown;
  type: unknown;
}): boolean {
  const { event } = input;
  if (typeof event !== "object" || event === null || Array.isArray(event)) {
    return false;
  }
  const entries = Object.entries(event);
  const valueOk = (value: unknown) =>
    typeof value === "boolean" ||
    Number.isSafeInteger(value) ||
    isOpaqueId(value);
  return (
    (OUTBOX_EVENT_TYPES as readonly unknown[]).includes(input.type) &&
    isOpaqueId(input.organizationId) &&
    isToken(input.idempotencyKey) &&
    (input.correlationId === undefined ||
      input.correlationId === null ||
      isToken(input.correlationId)) &&
    entries.length === 1 &&
    entries[0]?.[0] === "exportId" &&
    valueOk(entries[0]?.[1])
  );
}

describe("outbox event (EVT-2 to EVT-3)", () => {
  it("EVT-2: an event is accepted exactly when the model says so (declared type, declared keys, opaque values), and comes back whole", () => {
    let accepted = 0;
    assertProperty(
      property(outboxInput, (input) => {
        const run = () =>
          outboxEvent(input as Parameters<typeof outboxEvent>[0]);
        if (outboxModelAccepts(input)) {
          accepted += 1;
          expect(run()).toEqual({
            ...input,
            correlationId: input.correlationId ?? null,
          });
        } else {
          expect(run).toThrow(InvalidOutboxEventError);
        }
      })
    );
    expect(accepted).toBeGreaterThanOrEqual(minimumSeen());
  });

  it("EVT-3: the idempotency key of a declared type and an opaque ID is itself a valid key, the same for the same thing and different for another", () => {
    assertProperty(
      property(
        constantFrom(...OUTBOX_EVENT_TYPES),
        opaqueId,
        opaqueId,
        (type, id, other) => {
          const key = outboxIdempotencyKey(type, id);
          expect(key).toBe(outboxIdempotencyKey(type, id));
          expect(isToken(key)).toBe(true);
          expect(() =>
            outboxEvent({
              event: { exportId: id },
              idempotencyKey: key,
              organizationId: "org1",
              type,
            })
          ).not.toThrow();
          if (other !== id) {
            expect(outboxIdempotencyKey(type, other)).not.toBe(key);
          }
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Queue envelope
// ---------------------------------------------------------------------------------------------

const validEnvelope = record({
  attempt: integer({ max: QUEUE_ENVELOPE_MAX_ATTEMPT, min: 1 }),
  correlationId: token,
  event: opaqueId.map((exportId) => ({ exportId })),
  eventId: uuid(),
  idempotencyKey: token,
  organizationId: opaqueId,
  type: constantFrom(...OUTBOX_EVENT_TYPES),
});

describe("queue envelope (EVT-4 to EVT-5)", () => {
  it("EVT-4: an envelope survives the queue (JSON out and in) unchanged, and parsing it again changes nothing", () => {
    assertProperty(
      property(validEnvelope, (input) => {
        const built = queueEnvelope(input);
        expect(built).toEqual({ ...input, version: 1 });
        const afterQueue = parseQueueEnvelope(
          JSON.parse(JSON.stringify(built))
        );
        expect(afterQueue).toEqual(built);
        expect(parseQueueEnvelope(afterQueue)).toEqual(built);
        expect(QUEUE_NAMES).toContain(queueForEventType(built.type));
      })
    );
  });

  it("EVT-5: a message is accepted exactly when its version, attempt, IDs and fields are the model's, and nothing else rides along", () => {
    // a valid envelope with at most one field spoiled, so most cases reach the deep checks
    const spoiled = oneof(
      integer({ max: 1010, min: -2 }),
      constantFrom(0.5, Number.NaN, "1", null, 2),
      looseText,
      uuid().map((value) => value.toUpperCase()),
      constant({ exportId: "a b" })
    );
    const fields = [
      "attempt",
      "correlationId",
      "event",
      "eventId",
      "idempotencyKey",
      "organizationId",
      "type",
      "version",
      "extra",
      "none",
      "none",
    ] as const;
    const messages = tuple(validEnvelope, constantFrom(...fields), spoiled).map(
      ([envelope, field, value]) => {
        const raw: Record<string, unknown> = { ...envelope, version: 1 };
        if (field !== "none") {
          raw[field] = value;
        }
        return raw;
      }
    );
    let accepted = 0;
    assertProperty(
      property(messages, (raw) => {
        const attemptOk =
          typeof raw.attempt === "number" &&
          Number.isSafeInteger(raw.attempt) &&
          raw.attempt >= 1 &&
          raw.attempt <= 1000;
        const valid =
          raw.version === 1 &&
          Object.keys(raw).length === 8 &&
          attemptOk &&
          isLowerHexUuid(raw.eventId) &&
          isToken(raw.correlationId) &&
          outboxModelAccepts({
            correlationId: raw.correlationId,
            event: raw.event,
            idempotencyKey: raw.idempotencyKey,
            organizationId: raw.organizationId,
            type: raw.type,
          });
        const message = raw;
        const run = () => parseQueueEnvelope(message);
        if (valid) {
          accepted += 1;
          expect(run()).toEqual(raw);
        } else {
          expect(run).toThrow(InvalidQueueEnvelopeError);
        }
      })
    );
    expect(accepted).toBeGreaterThanOrEqual(minimumSeen());
  });
});

// ---------------------------------------------------------------------------------------------
// Dead letters
// ---------------------------------------------------------------------------------------------

const refusalCause = constantFrom<RefusalCause>(
  "invalid_envelope",
  "unknown_type",
  "wrong_queue"
);

describe("dead letters (EVT-6 to EVT-7)", () => {
  it("EVT-6: whatever lands on the dead-letter queue is classified without throwing, with a plain-token reference at most and a known cause", () => {
    assertProperty(
      property(
        oneof(
          anything(),
          json().map((text) => JSON.parse(text))
        ),
        oneof(token, looseText),
        (body, messageId) => {
          const classified = classifyDeadLetter(body, messageId);
          expect(DEAD_LETTER_CAUSES).toContain(classified.cause);
          expect(
            classified.reference === null || isToken(classified.reference)
          ).toBe(true);
          // an event is named whole or not at all
          if (classified.event === null) {
            expect(classified.subject).toBe("unknown");
          } else {
            expect(isToken(classified.event.organizationId)).toBe(true);
            expect(isLowerHexUuid(classified.event.id)).toBe(true);
            expect(OUTBOX_EVENT_TYPES).toContain(classified.subject);
          }
        }
      )
    );
  });

  it("EVT-7: a notice keeps the cause and names the event only whole, and a valid envelope on the queue always means retries exhausted", () => {
    assertProperty(
      property(
        refusalCause,
        oneof(token, looseText),
        oneof(constant(undefined), uuid(), looseText),
        oneof(constant(undefined), opaqueId, looseText),
        oneof(constant(undefined), constantFrom(...OUTBOX_EVENT_TYPES)),
        validEnvelope,
        (cause, messageId, eventId, organizationId, type, envelope) => {
          const notice = deadLetterNotice({
            cause,
            messageId,
            ...(eventId === undefined ? {} : { eventId }),
            ...(organizationId === undefined ? {} : { organizationId }),
            ...(type === undefined ? {} : { type }),
          });
          const classified = classifyDeadLetter(
            JSON.parse(JSON.stringify(notice)),
            "fallback-ref"
          );
          expect(classified.cause).toBe(cause);
          const whole =
            eventId !== undefined &&
            isLowerHexUuid(eventId) &&
            isToken(organizationId) &&
            type !== undefined;
          expect(classified.event !== null).toBe(whole);
          expect(
            Object.keys(notice).every((key) =>
              [
                "cause",
                "eventId",
                "kind",
                "messageId",
                "organizationId",
                "type",
                "version",
              ].includes(key)
            )
          ).toBe(true);

          const dead = classifyDeadLetter(
            queueEnvelope(envelope),
            "platform-id"
          );
          expect(dead.cause).toBe("retries_exhausted");
          expect(dead.event).toEqual({
            id: envelope.eventId,
            organizationId: envelope.organizationId,
          });
        }
      )
    );
  });
});
