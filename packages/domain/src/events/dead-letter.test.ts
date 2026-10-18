import { describe, expect, it } from "vitest";
import {
  classifyDeadLetter,
  DEAD_LETTER_NOTICE_KIND,
  type DeadLetterNoticeInput,
  deadLetterNotice,
  refusalCauseOf,
} from "./dead-letter";
import { outboxIdempotencyKey } from "./outbox";
import { queueEnvelope } from "./queue-envelope";

const EXPORT = "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b";
const EVENT = "0199a1b2-c3d4-7e5f-9a6b-7c8d9e0f1a2c";

function envelope() {
  return queueEnvelope({
    attempt: 1,
    correlationId: "req-1",
    event: { exportId: EXPORT },
    eventId: EVENT,
    idempotencyKey: outboxIdempotencyKey("data_export.requested", EXPORT),
    organizationId: "org_1",
    type: "data_export.requested",
  });
}

const notice = {
  cause: "wrong_queue",
  eventId: EVENT,
  kind: DEAD_LETTER_NOTICE_KIND,
  messageId: "msg-1",
  organizationId: "org_1",
  type: "data_export.requested",
  version: 1,
};

describe("deadLetterNotice", () => {
  it("carries the cause and the message reference, and nothing else without an event", () => {
    expect(
      deadLetterNotice({ cause: "invalid_envelope", messageId: "msg-1" })
    ).toEqual({
      cause: "invalid_envelope",
      kind: "polaris.dead_letter",
      messageId: "msg-1",
      version: 1,
    });
  });

  it("names the event when it is whole and its type is declared", () => {
    expect(
      deadLetterNotice({
        cause: "wrong_queue",
        eventId: EVENT,
        messageId: "msg-1",
        organizationId: "org_1",
        type: "data_export.requested",
      })
    ).toEqual(notice);
  });

  it("drops a message ID that is not a plain token", () => {
    for (const messageId of [
      "ana@example.com",
      "has space",
      "",
      "x".repeat(129),
    ]) {
      const sent = deadLetterNotice({ cause: "unknown_type", messageId });
      expect(sent).not.toHaveProperty("messageId");
    }
  });

  it("names no part of an event that is not whole or whose type is not declared", () => {
    const whole = {
      cause: "wrong_queue",
      eventId: EVENT,
      messageId: "m",
      organizationId: "org_1",
      type: "data_export.requested",
    } as const;
    const { eventId: _event, ...withoutEvent } = whole;
    const { organizationId: _org, ...withoutOrganization } = whole;
    const { type: _type, ...withoutType } = whole;
    const cases: DeadLetterNoticeInput[] = [
      withoutEvent,
      withoutOrganization,
      withoutType,
      { ...whole, eventId: "not-a-uuid" },
      { ...whole, organizationId: "org with space" },
      { ...whole, type: "other.thing" as never },
    ];
    for (const input of cases) {
      const sent = deadLetterNotice(input);
      expect(sent).not.toHaveProperty("eventId");
      expect(sent).not.toHaveProperty("organizationId");
      expect(sent).not.toHaveProperty("type");
    }
  });
});

describe("classifyDeadLetter", () => {
  it("takes the cause of the consumer's notice, with the event it names", () => {
    expect(classifyDeadLetter(notice, "dlq-1")).toEqual({
      cause: "wrong_queue",
      event: { id: EVENT, organizationId: "org_1" },
      reference: "msg-1",
      subject: "data_export.requested",
    });
  });

  it("uses the event ID as the reference when the notice has no message ID", () => {
    const { messageId: _omitted, ...withoutMessage } = notice;
    expect(classifyDeadLetter(withoutMessage, "dlq-1").reference).toBe(EVENT);
  });

  it("takes the cause of a notice that names no event, with the queue's own message ID as the fallback reference", () => {
    const body = {
      cause: "unknown_type",
      kind: DEAD_LETTER_NOTICE_KIND,
      version: 1,
    };
    expect(classifyDeadLetter(body, "dlq-1")).toEqual({
      cause: "unknown_type",
      event: null,
      reference: "dlq-1",
      subject: "unknown",
    });
    expect(
      classifyDeadLetter({ ...body, messageId: "msg-9" }, "dlq-1").reference
    ).toBe("msg-9");
  });

  it("classifies as an invalid envelope a notice that is not exactly what the consumer sends", () => {
    const { cause: _cause, ...withoutCause } = notice;
    const { organizationId: _org, ...partial } = notice;
    const bad = [
      { ...notice, extra: "x" },
      { ...notice, version: 2 },
      { ...notice, cause: "retries_exhausted" },
      { ...notice, cause: "made_up" },
      { ...notice, cause: 5 },
      withoutCause,
      partial,
      { ...notice, eventId: "nope" },
      { ...notice, type: "other.thing" },
    ];
    for (const body of bad) {
      expect(classifyDeadLetter(body, "dlq-1")).toEqual({
        cause: "invalid_envelope",
        event: null,
        reference: "dlq-1",
        subject: "unknown",
      });
    }
  });

  it("calls a valid envelope retries exhausted, by its type and event ID", () => {
    expect(classifyDeadLetter(envelope(), "dlq-1")).toEqual({
      cause: "retries_exhausted",
      event: { id: EVENT, organizationId: "org_1" },
      reference: EVENT,
      subject: "data_export.requested",
    });
  });

  it("calls anything else an invalid envelope, referenced by the message", () => {
    for (const body of [{ junk: true }, [1, 2], null, "text", 5, undefined]) {
      expect(classifyDeadLetter(body, "dlq-1")).toEqual({
        cause: "invalid_envelope",
        event: null,
        reference: "dlq-1",
        subject: "unknown",
      });
    }
  });

  it("keeps no reference when the message ID is not a token", () => {
    expect(classifyDeadLetter("x", "has space").reference).toBeNull();
  });

  it("never lets the body reach the result", () => {
    const secret = "ana@example.com";
    const bodies = [
      { email: secret, kind: "x" },
      { ...envelope(), event: { email: secret } },
      { ...notice, messageId: secret, organizationId: secret },
      { cause: secret, kind: DEAD_LETTER_NOTICE_KIND, version: 1 },
      [secret],
      secret,
    ];
    for (const body of bodies) {
      expect(JSON.stringify(classifyDeadLetter(body, "dlq-1"))).not.toContain(
        secret
      );
    }
  });
});

describe("refusalCauseOf", () => {
  it("says unknown_type for a well formed type the outbox does not declare", () => {
    expect(refusalCauseOf({ type: "sale.confirmed" })).toBe("unknown_type");
  });

  it("says unknown_type for a version newer than this deploy reads", () => {
    expect(refusalCauseOf({ version: 2 })).toBe("unknown_type");
  });

  it("says invalid_envelope for everything else", () => {
    for (const body of [
      {},
      { version: 1 },
      { version: 0 },
      { version: 1.5 },
      { version: "2" },
      { type: "data_export.requested" },
      { type: "NoDots" },
      { type: "Bad.Type" },
      { type: 5 },
      [],
      null,
      "text",
    ]) {
      expect(refusalCauseOf(body)).toBe("invalid_envelope");
    }
  });

  it("says invalid_envelope for a type over 80 characters or badly formed", () => {
    const longType = `a.${"b".repeat(79)}`;
    expect(longType).toHaveLength(81);
    expect(refusalCauseOf({ type: longType })).toBe("invalid_envelope");
    expect(refusalCauseOf({ type: `a.${"b".repeat(78)}` })).toBe(
      "unknown_type"
    );
    expect(refusalCauseOf({ type: "sale. confirmed" })).toBe(
      "invalid_envelope"
    );
  });
});
