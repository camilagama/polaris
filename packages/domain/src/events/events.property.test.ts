import {
  type Arbitrary,
  anything,
  bigInt,
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
  type OutboxEventType,
  outboxEvent,
  outboxIdempotencyKey,
} from "./outbox";
import {
  InvalidQueueEnvelopeError,
  parseQueueEnvelope,
  QUEUE_ENVELOPE_MAX_ATTEMPT,
  QUEUE_NAMES,
  queueEnvelope,
  type QueueName,
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
// the lengths where the identifier rules change: an opaque ID holds 1 to 64 characters, a token 1 to 128
const LENGTH_EDGES = [1, 63, 64, 65, 127, 128, 129] as const;
// a value that is usually wrong: free text, spaces, e-mail-like, empty, or at the edge of a length limit
const looseText = oneof(
  string({ maxLength: 80 }),
  constantFrom(
    "",
    "a b",
    "ana@example.com",
    "ação",
    "a/b",
    "a.b",
    ...LENGTH_EDGES.map((length) => "x".repeat(length))
  )
);
// what is not text at all, including numbers whose digits would pass a pattern if they were turned into text (EVT-2)
const notText = oneof(
  integer({ max: 99_999, min: 0 }),
  constantFrom(
    -1,
    0.5,
    Number.NaN,
    true,
    false,
    null,
    undefined,
    {},
    [],
    ["abc"],
    { toString: () => "abc" },
    10n
  ),
  bigInt({ max: 99_999n, min: 0n })
);

// ---------------------------------------------------------------------------------------------
// What each event type holds (EVT-0)
// ---------------------------------------------------------------------------------------------

/**
 * The model of the outbox types, written by hand and never read from the code under test: the keys the
 * body of each type holds, exactly, a generator of a valid value for each, and the queue it travels on.
 * A new type in `OUTBOX_EVENT_TYPES` fails EVT-0 until it has an entry here.
 */
interface EventModel {
  keys: Readonly<Record<string, Arbitrary<string | number>>>;
  queue: QueueName;
}
const EVENT_MODEL: Readonly<Record<string, EventModel>> = {
  "billing.renewal_cancel_requested": {
    // milliseconds since the epoch of the closure request
    keys: { requestedAt: integer({ max: 8_640_000_000_000_000, min: 1 }) },
    queue: "critical",
  },
  "data_export.requested": {
    keys: { exportId: stringMatching(/^[A-Za-z0-9_-]{1,64}$/) },
    queue: "default",
  },
  "organization.closure_notice": {
    keys: { noticeId: stringMatching(/^[A-Za-z0-9_-]{1,64}$/) },
    queue: "default",
  },
};
const MODEL_TYPES = Object.keys(EVENT_MODEL);
// the model's types, typed as the outbox's so an envelope can carry them (EVT-0 proves the two lists are the same)
const modelType = constantFrom(...MODEL_TYPES) as Arbitrary<OutboxEventType>;

function modelOf(type: string): EventModel {
  const model = EVENT_MODEL[type];
  if (!model) {
    throw new Error(
      `EVENT_MODEL has no entry for the outbox event type "${type}": add its body keys and queue to this test (EVT-0)`
    );
  }
  return model;
}

/** A valid body for the type: exactly its keys, each with a valid value. */
function validBody(type: string): Arbitrary<Record<string, string | number>> {
  const keys = Object.entries(modelOf(type).keys);
  return tuple(...keys.map(([, value]) => value)).map(
    (values) =>
      Object.fromEntries(
        keys.map(([key], index) => [key, values[index]])
      ) as Record<string, string | number>
  );
}

describe("what each event type holds (EVT-0)", () => {
  it("EVT-0: every type the outbox declares has a model entry here, and every entry is a declared type", () => {
    const declared: string[] = [...OUTBOX_EVENT_TYPES].sort();
    const modelled = [...MODEL_TYPES].sort();
    const missing = declared.filter((type) => !modelled.includes(type));
    const stale = modelled.filter((type) => !declared.includes(type));
    expect(
      missing,
      `outbox event type(s) without an entry in EVENT_MODEL: ${missing.join(", ")}. Add the keys of the body and the queue of each (EVT-0), so the oracle of EVT-2 to EVT-5 knows them`
    ).toEqual([]);
    expect(
      stale,
      `EVENT_MODEL entries for types the outbox no longer declares: ${stale.join(", ")}`
    ).toEqual([]);
  });

  it("EVT-0: each declared type travels on the queue the model says", () => {
    for (const type of OUTBOX_EVENT_TYPES) {
      expect(queueForEventType(type), `queue of ${type}`).toBe(
        modelOf(type).queue
      );
    }
  });
});

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
      integer({ max: OUTBOX_MAX_DISPATCH_ATTEMPTS, min: 0 }),
      // where the schedule turns: the first claim, the cap of an hour (the 8th claim), the cap of the exponent
      constantFrom(-1, 0, 1, 2, 7, 8, 9, 16, 17, 18, 999, 1000, 1001)
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
/** The body of an event of the type, valid or with a part spoiled: wrong keys (another type's, an extra one, none), or a wrong value. */
function eventBody(type: string): Arbitrary<unknown> {
  const [key = "exportId"] = Object.keys(modelOf(type).keys);
  const otherKeys = MODEL_TYPES.filter((other) => other !== type).flatMap(
    (other) => Object.keys(modelOf(other).keys)
  );
  return oneof(
    { arbitrary: validBody(type), weight: 3 },
    record({ [key]: bodyValue }),
    validBody(type).chain((body) =>
      oneof(bodyValue, opaqueId).map((note) => ({ ...body, note }))
    ),
    constantFrom(...otherKeys, "other").chain((wrong) =>
      record({ [wrong]: oneof(opaqueId, integer({ max: 9999, min: 1 })) })
    ),
    constant({}),
    constant(null),
    constant([key])
  );
}
// a valid event with at most one part spoiled, so most cases reach the deep checks; a text field is spoiled
// with text or with something that is not text, and a field that is not text must be refused as it is
// (no turning a number into an ID that passes the pattern)
const outboxInput = modelType.chain((type) =>
  tuple(
    record({
      correlationId: oneof(constant(undefined), constant(null), token),
      event: validBody(type),
      idempotencyKey: token,
      organizationId: opaqueId,
      type: constant(type),
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
    oneof(looseText, notText),
    eventBody(type)
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
  })
);

function sameKeys(actual: string[], expected: string[]): boolean {
  return (
    actual.length === expected.length &&
    [...actual].sort().join(",") === [...expected].sort().join(",")
  );
}

/** An event is valid when its type is modelled, its body holds exactly the keys of the type and only opaque IDs, integers or booleans, and every text field is text. */
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
    typeof input.type === "string" &&
    Object.hasOwn(EVENT_MODEL, input.type) &&
    isOpaqueId(input.organizationId) &&
    isToken(input.idempotencyKey) &&
    (input.correlationId === undefined ||
      input.correlationId === null ||
      isToken(input.correlationId)) &&
    sameKeys(
      entries.map(([key]) => key),
      Object.keys(modelOf(input.type).keys)
    ) &&
    entries.every(([, value]) => valueOk(value))
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

  it("EVT-2: a field that is not text is refused as it is, never turned into text (a number 123 is no organization ID)", () => {
    const fields = constantFrom(
      "correlationId",
      "idempotencyKey",
      "organizationId",
      "type"
    );
    assertProperty(
      property(modelType, fields, notText, (type, field, value) => {
        // no correlation (null or absent) is allowed: it starts a trace of its own
        if (
          field === "correlationId" &&
          (value === null || value === undefined)
        ) {
          return;
        }
        const input = {
          correlationId: "trace-1",
          event: Object.fromEntries(
            Object.keys(modelOf(type).keys).map((key) => [key, "a"])
          ),
          idempotencyKey: `${type}:a`,
          organizationId: "org1",
          type,
          [field]: value,
        };
        expect(() => outboxEvent(input as never)).toThrow(
          InvalidOutboxEventError
        );
      })
    );
  });

  it("EVT-2: the organization is 1 to 64 characters and the key and the correlation 1 to 128, at every edge", () => {
    // every type, field and edge length, not a draw; literals, so moving a limit in the code turns this red on every run
    const limits = {
      correlationId: 128,
      idempotencyKey: 128,
      organizationId: 64,
    } as const;
    const lengths = [0, 1, 2, 63, 64, 65, 127, 128, 129, 130];
    for (const type of MODEL_TYPES) {
      for (const field of Object.keys(limits) as (keyof typeof limits)[]) {
        for (const length of lengths) {
          const input = {
            correlationId: "trace-1",
            event: Object.fromEntries(
              Object.keys(modelOf(type).keys).map((key) => [key, "a"])
            ),
            idempotencyKey: `${type}:a`,
            organizationId: "org1",
            type,
            [field]: "a".repeat(length),
          };
          const label = `${type}, ${field}, length ${length}`;
          if (length >= 1 && length <= limits[field]) {
            expect(outboxEvent(input).type, label).toBe(type);
          } else {
            expect(() => outboxEvent(input), label).toThrow(
              InvalidOutboxEventError
            );
          }
        }
      }
    }
  });

  it("EVT-3: the idempotency key of a declared type and an opaque ID is itself a valid key, the same for the same thing and different for another", () => {
    assertProperty(
      property(modelType, opaqueId, opaqueId, (type, id, other) => {
        const key = outboxIdempotencyKey(type, id);
        expect(key).toBe(outboxIdempotencyKey(type, id));
        expect(isToken(key)).toBe(true);
        expect(() =>
          outboxEvent({
            event: Object.fromEntries(
              Object.keys(modelOf(type).keys).map((name) => [name, id])
            ),
            idempotencyKey: key,
            organizationId: "org1",
            type,
          })
        ).not.toThrow();
        if (other !== id) {
          expect(outboxIdempotencyKey(type, other)).not.toBe(key);
        }
      })
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Queue envelope
// ---------------------------------------------------------------------------------------------

const validEnvelope = modelType.chain((type) =>
  record({
    attempt: integer({ max: QUEUE_ENVELOPE_MAX_ATTEMPT, min: 1 }),
    correlationId: token,
    event: validBody(type),
    eventId: uuid(),
    idempotencyKey: token,
    organizationId: opaqueId,
    type: constant(type),
  })
);

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
        expect(queueForEventType(built.type)).toBe(modelOf(built.type).queue);
      })
    );
  });

  it("EVT-5: a message is accepted exactly when its version, attempt, IDs and fields are the model's, and nothing else rides along", () => {
    // a valid envelope with at most one field spoiled, so most cases reach the deep checks
    const spoiled = oneof(
      integer({ max: 1010, min: -2 }),
      constantFrom(0.5, Number.NaN, "1", null, 2),
      looseText,
      notText,
      uuid().map((value) => value.toUpperCase()),
      constant({ exportId: "a b" }),
      // the body of another type, which the envelope's type does not declare
      constantFrom({ exportId: "a" }, { requestedAt: 1 })
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

  it("EVT-5: the attempt is accepted from 1 to 1000 and refused at 0 and 1001, at every edge", () => {
    // written as literals: moving the limit in the code must turn this red
    const edges = constantFrom(-1, 0, 1, 2, 999, 1000, 1001, 1002, 2 ** 31);
    assertProperty(
      property(validEnvelope, edges, (envelope, attempt) => {
        const raw = { ...envelope, attempt, version: 1 };
        if (attempt >= 1 && attempt <= 1000) {
          expect(parseQueueEnvelope(raw).attempt).toBe(attempt);
        } else {
          expect(() => parseQueueEnvelope(raw)).toThrow(
            InvalidQueueEnvelopeError
          );
        }
      })
    );
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
