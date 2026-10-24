import { describe, expect, it } from "vitest";
import { outboxIdempotencyKey } from "./outbox";
import {
  InvalidQueueEnvelopeError,
  parseQueueEnvelope,
  QUEUE_ENVELOPE_MAX_ATTEMPT,
  QUEUE_NAMES,
  queueEnvelope,
  queueForEventType,
} from "./queue-envelope";

const EXPORT = "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b";
const EVENT = "0199a1b2-c3d4-7e5f-9a6b-7c8d9e0f1a2c";
const REQUEST = "0199a1b2-c3d4-7e5f-aa6b-7c8d9e0f1a2d";

const input = {
  attempt: 1,
  correlationId: REQUEST,
  event: { exportId: EXPORT },
  eventId: EVENT,
  idempotencyKey: outboxIdempotencyKey("data_export.requested", EXPORT),
  organizationId: "org_AbC123-xyz",
  type: "data_export.requested",
} as const;

const refuses = (raw: unknown) =>
  expect(() => parseQueueEnvelope(raw)).toThrow(InvalidQueueEnvelopeError);

describe("the queues", () => {
  it("are the three of the plan", () => {
    expect([...QUEUE_NAMES]).toEqual(["critical", "default", "media"]);
  });

  it("route every event type to one of them", () => {
    expect(queueForEventType("data_export.requested")).toBe("default");
    // a renewal left alive charges the person: the critical queue
    expect(queueForEventType("billing.renewal_cancel_requested")).toBe(
      "critical"
    );
    expect(queueForEventType("organization.closure_notice")).toBe("default");
    expect(queueForEventType("billing.notice")).toBe("default");
  });
});

describe("queueEnvelope and parseQueueEnvelope", () => {
  it("builds a versioned envelope that parses back to itself", () => {
    const envelope = queueEnvelope(input);
    expect(envelope).toEqual({ ...input, version: 1 });
    expect(parseQueueEnvelope(JSON.parse(JSON.stringify(envelope)))).toEqual(
      envelope
    );
  });

  it("refuses what is not an object", () => {
    for (const raw of [null, undefined, "x", 1, [], [input]]) {
      refuses(raw);
    }
  });

  it("refuses a missing or other version", () => {
    refuses(input);
    refuses({ ...input, version: 2 });
    refuses({ ...input, version: "1" });
  });

  it("refuses a field it does not know", () => {
    refuses({ ...input, version: 1, email: "ana@example.com" });
  });

  it("refuses a missing field", () => {
    for (const field of Object.keys(input)) {
      const { [field as keyof typeof input]: _dropped, ...rest } = input;
      refuses({ ...rest, version: 1 });
    }
  });

  it("refuses an attempt that is not a count from 1", () => {
    for (const attempt of [
      0,
      -1,
      1.5,
      "1",
      Number.NaN,
      QUEUE_ENVELOPE_MAX_ATTEMPT + 1,
    ]) {
      refuses({ ...input, attempt, version: 1 });
    }
    expect(
      queueEnvelope({ ...input, attempt: QUEUE_ENVELOPE_MAX_ATTEMPT })
    ).toBeDefined();
  });

  it("refuses an event ID that is not a UUID", () => {
    refuses({ ...input, eventId: "not-a-uuid", version: 1 });
    refuses({ ...input, eventId: EVENT.toUpperCase(), version: 1 });
  });

  it("refuses a type the outbox does not declare", () => {
    refuses({ ...input, type: "sale.confirmed", version: 1 });
    refuses({ ...input, type: ["data_export.requested"], version: 1 });
  });

  it("refuses a correlation, a key or an organization that is not a token", () => {
    refuses({ ...input, correlationId: "has space", version: 1 });
    refuses({ ...input, correlationId: 7, version: 1 });
    refuses({ ...input, idempotencyKey: "a\nb", version: 1 });
    refuses({ ...input, organizationId: "org@example.com", version: 1 });
  });

  it("refuses an event body that carries free text, nested data or a decimal", () => {
    for (const event of [
      { email: "ana@example.com" },
      { name: "Ana Souza" },
      { exportId: EXPORT, note: "line\nbreak" },
      { exportId: { nested: EXPORT } },
      { exportId: [EXPORT] },
      { exportId: null },
      { amount: 1.5 },
      { "Bad-Key": EXPORT },
      [],
      null,
      "text",
    ]) {
      refuses({ ...input, event, version: 1 });
    }
  });

  it("refuses a body past the outbox size limit", () => {
    const event = Object.fromEntries(
      Array.from({ length: 17 }, (_, index) => [`k${index}`, index])
    );
    refuses({ ...input, event, version: 1 });
  });

  it("says nothing about the content in its error", () => {
    try {
      parseQueueEnvelope({ ...input, event: { email: "ana@example.com" } });
      expect.unreachable();
    } catch (error: unknown) {
      expect(String((error as Error).message)).toBe("invalid_queue_envelope");
      expect(JSON.stringify(error)).not.toContain("ana@example.com");
    }
  });
});
