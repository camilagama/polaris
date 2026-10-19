import { outboxIdempotencyKey } from "@polaris/domain/events/outbox";
import { queueEnvelope } from "@polaris/domain/events/queue-envelope";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueueMessage } from "./consumer";
import {
  type DeadLetterStore,
  handleDeadLetterBatch,
  isDeadLetterQueue,
} from "./dead-letter";

const EXPORT = "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b";
const EVENT = "0199a1b2-c3d4-7e5f-9a6b-7c8d9e0f1a2c";
const SECRET = "ana@example.com";

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

function message(body: unknown, id = "dlq-1", attempts = 1) {
  return {
    ack: vi.fn(),
    attempts,
    body,
    id,
    retry: vi.fn(),
  } satisfies QueueMessage;
}

describe("isDeadLetterQueue", () => {
  it("accepts the dead-letter queue, with or without an environment suffix", () => {
    expect(isDeadLetterQueue("polaris-dlq")).toBe(true);
    expect(isDeadLetterQueue("polaris-dlq-staging")).toBe(true);
  });

  it("refuses every other queue name", () => {
    for (const name of [
      "staging-polaris-dlq",
      "polaris-default",
      "polaris-dlq_x",
      "polaris-dlqx",
      "polaris-dlq-",
      "",
    ]) {
      expect(isDeadLetterQueue(name)).toBe(false);
    }
  });
});

describe("handleDeadLetterBatch", () => {
  let store: { recordDeadLetter: ReturnType<typeof vi.fn> } & DeadLetterStore;

  beforeEach(() => {
    store = { recordDeadLetter: vi.fn().mockResolvedValue(undefined) };
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const run = (messages: QueueMessage[]) =>
    handleDeadLetterBatch({ messages, queue: "polaris-dlq" }, store);

  it("records a valid envelope as retries exhausted, with its event, and acks", async () => {
    const sent = message(envelope());
    await run([sent]);
    expect(store.recordDeadLetter).toHaveBeenCalledOnce();
    expect(store.recordDeadLetter).toHaveBeenCalledWith({
      cause: "retries_exhausted",
      event: { id: EVENT, organizationId: "org_1" },
      reference: EVENT,
      subject: "data_export.requested",
    });
    expect(sent.ack).toHaveBeenCalledOnce();
    expect(sent.retry).not.toHaveBeenCalled();
  });

  it("records the cause of the consumer's notice", async () => {
    const sent = message({
      cause: "wrong_queue",
      eventId: EVENT,
      kind: "polaris.dead_letter",
      messageId: "msg-1",
      organizationId: "org_1",
      type: "data_export.requested",
      version: 1,
    });
    await run([sent]);
    expect(store.recordDeadLetter).toHaveBeenCalledWith({
      cause: "wrong_queue",
      event: { id: EVENT, organizationId: "org_1" },
      reference: "msg-1",
      subject: "data_export.requested",
    });
    expect(sent.ack).toHaveBeenCalledOnce();
  });

  it("records junk as an invalid envelope with no event", async () => {
    const sent = message({ junk: SECRET });
    await run([sent]);
    expect(store.recordDeadLetter).toHaveBeenCalledWith({
      cause: "invalid_envelope",
      event: null,
      reference: "dlq-1",
      subject: "unknown",
    });
    expect(sent.ack).toHaveBeenCalledOnce();
  });

  it("retries with the back-off, without ack, when the store fails, and still handles the next message", async () => {
    store.recordDeadLetter
      .mockRejectedValueOnce(new Error(SECRET))
      .mockResolvedValueOnce(undefined);
    const failed = message({ junk: true }, "dlq-1", 3);
    const next = message(envelope(), "dlq-2");
    await run([failed, next]);
    expect(failed.retry).toHaveBeenCalledOnce();
    expect(failed.retry).toHaveBeenCalledWith({ delaySeconds: 120 });
    expect(failed.ack).not.toHaveBeenCalled();
    expect(store.recordDeadLetter).toHaveBeenCalledTimes(2);
    expect(next.ack).toHaveBeenCalledOnce();
    expect(next.retry).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.objectContaining({
        errorClass: "Error",
        event: "queue_dead_letter_not_recorded",
        messageId: "dlq-1",
      })
    );
  });

  it("logs nothing of the body or of an error text", async () => {
    store.recordDeadLetter.mockRejectedValueOnce(new Error(SECRET));
    await run([
      message({ note: SECRET, random: "zq9-random-body-text" }, "dlq-1"),
      message({ note: SECRET, random: "zq9-random-body-text" }, "dlq-2"),
    ]);
    const logged = JSON.stringify([
      vi.mocked(console.warn).mock.calls,
      vi.mocked(console.error).mock.calls,
    ]);
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain("zq9-random-body-text");
    expect(console.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        cause: "invalid_envelope",
        event: "queue_dead_letter_recorded",
        messageId: "dlq-2",
        subject: "unknown",
      })
    );
  });
});
