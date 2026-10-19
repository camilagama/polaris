import { outboxIdempotencyKey } from "@polaris/domain/events/outbox";
import { queueEnvelope } from "@polaris/domain/events/queue-envelope";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DeadLetterProducer,
  handleQueueBatch,
  PermanentHandlerError,
  type QueueHandler,
  type QueueMessage,
  retryDelaySeconds,
} from "./consumer";
import {
  createInMemoryProcessingLedger,
  type ProcessingLedger,
} from "./processing-ledger";

const EXPORT = "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b";

function envelope(exportId = EXPORT) {
  return queueEnvelope({
    attempt: 1,
    correlationId: "req-1",
    event: { exportId },
    eventId: "0199a1b2-c3d4-7e5f-9a6b-7c8d9e0f1a2c",
    idempotencyKey: outboxIdempotencyKey("data_export.requested", exportId),
    organizationId: "org_1",
    type: "data_export.requested",
  });
}

function keyOf(sent: ReturnType<typeof envelope>) {
  return {
    attempt: sent.attempt,
    eventId: sent.eventId,
    idempotencyKey: sent.idempotencyKey,
    organizationId: sent.organizationId,
    type: sent.type,
  };
}

function message(body: unknown, attempts = 1) {
  const sent = {
    ack: vi.fn(),
    attempts,
    body,
    id: "msg-1",
    retry: vi.fn(),
  } satisfies QueueMessage;
  return sent;
}

describe("handleQueueBatch", () => {
  let ledger: ProcessingLedger;
  let handler: ReturnType<typeof vi.fn<QueueHandler>>;

  beforeEach(() => {
    ledger = createInMemoryProcessingLedger();
    handler = vi.fn<QueueHandler>().mockResolvedValue(undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const run = (messages: QueueMessage[]) =>
    handleQueueBatch(
      { messages, queue: "polaris-default" },
      { handlers: { "data_export.requested": handler }, ledger }
    );

  it("runs the handler of the type with the validated envelope and acks", async () => {
    const sent = message(envelope(), 2);
    await run([sent]);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(envelope());
    expect(sent.ack).toHaveBeenCalledOnce();
    expect(sent.retry).not.toHaveBeenCalled();
  });

  it("runs a duplicate delivery once, and acks both", async () => {
    const first = message(envelope());
    const second = message(envelope());
    await run([first, second]);
    expect(handler).toHaveBeenCalledOnce();
    expect(first.ack).toHaveBeenCalledOnce();
    expect(second.ack).toHaveBeenCalledOnce();
  });

  it("keeps the key per organization", async () => {
    const other = queueEnvelope({ ...envelope(), organizationId: "org_2" });
    await run([message(envelope()), message(other)]);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("acks and never runs a body that is not a valid envelope, without logging its content", async () => {
    const sent = message({
      ...envelope(),
      event: { email: "ana@example.com" },
    });
    await run([sent]);
    expect(handler).not.toHaveBeenCalled();
    expect(sent.ack).toHaveBeenCalledOnce();
    expect(sent.retry).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(
      "ana@example.com"
    );
  });

  it("acks, without running, a message that came on the queue of another type", async () => {
    const sent = message(envelope());
    for (const queue of ["polaris-media", "polaris-critical", "other", ""]) {
      // biome-ignore lint/performance/noAwaitInLoops: the same message on each queue, in order.
      await handleQueueBatch(
        { messages: [sent], queue },
        { handlers: { "data_export.requested": handler }, ledger }
      );
    }
    expect(handler).not.toHaveBeenCalled();
    expect(sent.ack).toHaveBeenCalledTimes(4);
    expect(sent.retry).not.toHaveBeenCalled();
  });

  it("accepts the queue of an environment with a suffix", async () => {
    const sent = message(envelope());
    await handleQueueBatch(
      { messages: [sent], queue: "polaris-default-staging" },
      { handlers: { "data_export.requested": handler }, ledger }
    );
    expect(handler).toHaveBeenCalledOnce();
  });

  it("acks a body that is not even an object", async () => {
    const sent = message("not json");
    await run([sent]);
    expect(sent.ack).toHaveBeenCalledOnce();
  });

  it("retries, with the key given back, when the handler fails", async () => {
    handler.mockRejectedValueOnce(new Error("secret@example.com"));
    const failed = message(envelope(), 1);
    await run([failed]);
    expect(failed.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(failed.ack).not.toHaveBeenCalled();
    // the error text, which may carry data, is not logged: only its class
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      "secret@example.com"
    );

    const again = message(envelope(), 2);
    await run([again]);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(again.ack).toHaveBeenCalledOnce();
  });

  it("acks a permanent failure, and lets a later delivery try again", async () => {
    handler.mockRejectedValueOnce(new PermanentHandlerError("not_configured"));
    const failed = message(envelope());
    await run([failed]);
    expect(failed.ack).toHaveBeenCalledOnce();
    expect(failed.retry).not.toHaveBeenCalled();

    await run([message(envelope())]);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("does not stop the batch at a failure", async () => {
    handler.mockRejectedValueOnce(new Error("boom"));
    const first = message(envelope("a-1"));
    const second = message(envelope("b-2"));
    await run([first, second]);
    expect(first.retry).toHaveBeenCalledOnce();
    expect(second.ack).toHaveBeenCalledOnce();
  });

  it("retries a type that has no handler yet", async () => {
    const sent = message(envelope());
    await handleQueueBatch(
      { messages: [sent], queue: "polaris-default" },
      { handlers: {}, ledger }
    );
    expect(sent.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(sent.ack).not.toHaveBeenCalled();
  });

  it("asks again later when another delivery holds the key", async () => {
    await ledger.claim(keyOf(envelope()), 600);
    const sent = message(envelope());
    await run([sent]);
    expect(handler).not.toHaveBeenCalled();
    expect(sent.retry).toHaveBeenCalledOnce();
    expect(sent.ack).not.toHaveBeenCalled();
  });

  it("acks without running when the ledger does not know the event, and logs no content", async () => {
    const unknown: ProcessingLedger = {
      claim: () =>
        Promise.resolve({ reason: "event_not_held", result: "unknown" }),
      complete: vi.fn(() => Promise.resolve()),
      release: vi.fn(() => Promise.resolve()),
    };
    const sent = message(envelope());
    await handleQueueBatch(
      { messages: [sent], queue: "polaris-default" },
      { handlers: { "data_export.requested": handler }, ledger: unknown }
    );
    expect(handler).not.toHaveBeenCalled();
    expect(sent.ack).toHaveBeenCalledOnce();
    expect(sent.retry).not.toHaveBeenCalled();
    expect(unknown.complete).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "queue_message_unknown_event",
        eventId: envelope().eventId,
        messageId: "msg-1",
        reason: "event_not_held",
      })
    );
    // only the IDs and the type are logged, never the body of the message
    const logged = JSON.stringify(vi.mocked(console.warn).mock.calls);
    expect(logged).not.toContain("req-1");
    expect(logged).not.toContain(EXPORT);
  });

  it("gives the ledger the key of the envelope and the default lease of 960 seconds", async () => {
    const claim = vi.fn<ProcessingLedger["claim"]>(() =>
      Promise.resolve({ result: "claimed", token: "t" })
    );
    const complete = vi.fn<ProcessingLedger["complete"]>(() =>
      Promise.resolve()
    );
    const spy: ProcessingLedger = {
      claim,
      complete,
      release: () => Promise.resolve(),
    };
    const sent = queueEnvelope({ ...envelope(), attempt: 3 });
    await handleQueueBatch(
      { messages: [message(sent)], queue: "polaris-default" },
      { handlers: { "data_export.requested": handler }, ledger: spy }
    );
    const expected = {
      attempt: 3,
      eventId: "0199a1b2-c3d4-7e5f-9a6b-7c8d9e0f1a2c",
      idempotencyKey: `data_export.requested:${EXPORT}`,
      organizationId: "org_1",
      type: "data_export.requested",
    };
    expect(claim).toHaveBeenCalledWith(expected, 960);
    expect(complete).toHaveBeenCalledWith(expected);
  });

  it("uses the lease it is given instead of the default", async () => {
    const claim = vi.fn<ProcessingLedger["claim"]>(() =>
      Promise.resolve({ result: "claimed", token: "t" })
    );
    await handleQueueBatch(
      { messages: [message(envelope())], queue: "polaris-default" },
      {
        handlers: { "data_export.requested": handler },
        leaseSeconds: 120,
        ledger: { ...ledger, claim },
      }
    );
    expect(claim).toHaveBeenCalledWith(expect.anything(), 120);
  });

  it("runs a re-dispatched attempt again, but not a duplicate of an attempt already done", async () => {
    await run([message(envelope())]);
    expect(handler).toHaveBeenCalledTimes(1);

    const duplicate = message(envelope());
    await run([duplicate]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(duplicate.ack).toHaveBeenCalledOnce();

    const second = message(queueEnvelope({ ...envelope(), attempt: 2 }));
    await run([second]);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(second.ack).toHaveBeenCalledOnce();

    // a late copy of the first attempt is still a duplicate
    await run([message(envelope())]);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("retries without running the handler when the ledger is unavailable", async () => {
    const broken: ProcessingLedger = {
      claim: () => Promise.reject(new Error("down")),
      complete: () => Promise.resolve(),
      release: () => Promise.resolve(),
    };
    const sent = message(envelope());
    await handleQueueBatch(
      { messages: [sent], queue: "polaris-default" },
      { handlers: { "data_export.requested": handler }, ledger: broken }
    );
    expect(handler).not.toHaveBeenCalled();
    expect(sent.retry).toHaveBeenCalledOnce();
  });

  it("retries a contended claim instead of dropping it, and logs the SQLSTATE and nothing of the error text", async () => {
    const contended: ProcessingLedger = {
      claim: () =>
        Promise.reject(
          Object.assign(new Error("secret@example.com"), { code: "40001" })
        ),
      complete: () => Promise.resolve(),
      release: () => Promise.resolve(),
    };
    const sent = message(envelope());
    await handleQueueBatch(
      { messages: [sent], queue: "polaris-default" },
      { handlers: { "data_export.requested": handler }, ledger: contended }
    );
    expect(handler).not.toHaveBeenCalled();
    expect(sent.retry).toHaveBeenCalledOnce();
    expect(sent.ack).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "queue_ledger_unavailable",
        sqlState: "40001",
      })
    );
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      "secret@example.com"
    );
  });

  it("retries when the work is done but the ledger cannot record it", async () => {
    const base = createInMemoryProcessingLedger();
    const broken: ProcessingLedger = {
      ...base,
      complete: () => Promise.reject(new Error("down")),
    };
    const sent = message(envelope());
    await handleQueueBatch(
      { messages: [sent], queue: "polaris-default" },
      { handlers: { "data_export.requested": handler }, ledger: broken }
    );
    expect(handler).toHaveBeenCalledOnce();
    expect(sent.retry).toHaveBeenCalledOnce();
    expect(sent.ack).not.toHaveBeenCalled();
  });
});

describe("the dead-letter queue of a message refused for good", () => {
  const SECRET = "ana@example.com";
  let ledger: ProcessingLedger;
  let handler: ReturnType<typeof vi.fn<QueueHandler>>;
  let send: ReturnType<typeof vi.fn<DeadLetterProducer["send"]>>;

  beforeEach(() => {
    ledger = createInMemoryProcessingLedger();
    handler = vi.fn<QueueHandler>().mockResolvedValue(undefined);
    send = vi.fn<DeadLetterProducer["send"]>().mockResolvedValue(undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const run = (
    messages: QueueMessage[],
    queue = "polaris-default",
    withProducer = true
  ) =>
    handleQueueBatch(
      { messages, queue },
      {
        deadLetters: withProducer ? { send } : undefined,
        handlers: { "data_export.requested": handler },
        ledger,
      }
    );

  it("sends a notice, never the body, for an envelope that is not valid, and only then acks", async () => {
    const sent = message({
      ...envelope(),
      event: { note: SECRET, random: "zq9-random-body-text" },
    });
    send.mockImplementation(() => {
      // the message is not acknowledged before the queue took the notice
      expect(sent.ack).not.toHaveBeenCalled();
      return Promise.resolve();
    });
    await run([sent]);
    expect(handler).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      {
        cause: "invalid_envelope",
        kind: "polaris.dead_letter",
        messageId: "msg-1",
        version: 1,
      },
      { contentType: "json" }
    );
    expect(sent.ack).toHaveBeenCalledOnce();
    expect(sent.retry).not.toHaveBeenCalled();
    const everything = JSON.stringify([
      send.mock.calls,
      vi.mocked(console.warn).mock.calls,
      vi.mocked(console.error).mock.calls,
    ]);
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain("zq9-random-body-text");
    expect(everything).not.toContain(EXPORT);
  });

  it("sends the cause unknown_type for a type this deploy does not declare", async () => {
    const sent = message({ ...envelope(), type: "sale.confirmed" });
    await run([sent]);
    expect(send.mock.calls[0]?.[0]).toMatchObject({ cause: "unknown_type" });
    expect(sent.ack).toHaveBeenCalledOnce();
  });

  it("sends the cause unknown_type for a version this deploy does not read", async () => {
    const sent = message({ ...envelope(), version: 2 });
    await run([sent]);
    expect(send.mock.calls[0]?.[0]).toMatchObject({ cause: "unknown_type" });
    expect(sent.ack).toHaveBeenCalledOnce();
  });

  it("sends invalid_envelope for a body that is not even an object", async () => {
    const sent = message("not json");
    await run([sent]);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      cause: "invalid_envelope",
    });
    expect(JSON.stringify(send.mock.calls)).not.toContain("not json");
    expect(sent.ack).toHaveBeenCalledOnce();
  });

  it("sends wrong_queue with the IDs and type of the envelope for a message on another type's queue", async () => {
    const sent = message(envelope());
    await run([sent], "polaris-media");
    expect(handler).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      {
        cause: "wrong_queue",
        eventId: envelope().eventId,
        kind: "polaris.dead_letter",
        messageId: "msg-1",
        organizationId: "org_1",
        type: "data_export.requested",
        version: 1,
      },
      { contentType: "json" }
    );
    expect(sent.ack).toHaveBeenCalledOnce();
    // IDs and type, not the body
    expect(JSON.stringify(send.mock.calls)).not.toContain(EXPORT);
    expect(JSON.stringify(send.mock.calls)).not.toContain("req-1");
  });

  it("retries with the back-off, and does not ack, when the dead-letter queue refuses the notice", async () => {
    send.mockRejectedValue(new Error(SECRET));
    const sent = message("junk", 3);
    await run([sent]);
    expect(sent.retry).toHaveBeenCalledOnce();
    expect(sent.retry).toHaveBeenCalledWith({
      delaySeconds: retryDelaySeconds(3),
    });
    expect(sent.ack).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.objectContaining({
        cause: "invalid_envelope",
        event: "queue_dead_letter_send_failed",
        messageId: "msg-1",
      })
    );
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      SECRET
    );
  });

  it("does the same for a wrong queue whose notice is refused", async () => {
    send.mockRejectedValue(new Error("down"));
    const sent = message(envelope(), 1);
    await run([sent], "polaris-critical");
    expect(sent.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(sent.ack).not.toHaveBeenCalled();
  });

  it("acks and warns queue_dead_letter_not_configured without a producer", async () => {
    const sent = message("junk");
    await run([sent], "polaris-default", false);
    expect(sent.ack).toHaveBeenCalledOnce();
    expect(sent.retry).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "queue_dead_letter_not_configured",
        messageId: "msg-1",
      })
    );
  });

  it("sends nothing for a valid message that runs, and keeps going after a refused notice", async () => {
    send.mockRejectedValueOnce(new Error("down"));
    const refused = message("junk");
    const good = message(envelope());
    await run([refused, good]);
    expect(refused.retry).toHaveBeenCalledOnce();
    expect(good.ack).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
  });
});

describe("retryDelaySeconds", () => {
  it("doubles from thirty seconds and stops at an hour", () => {
    expect(retryDelaySeconds(1)).toBe(30);
    expect(retryDelaySeconds(2)).toBe(60);
    expect(retryDelaySeconds(3)).toBe(120);
    expect(retryDelaySeconds(50)).toBe(3600);
    expect(retryDelaySeconds(0)).toBe(30);
  });
});
