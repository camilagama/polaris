import { outboxIdempotencyKey } from "@polaris/domain/events/outbox";
import { queueEnvelope } from "@polaris/domain/events/queue-envelope";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
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
    await ledger.claim(`org_1:data_export.requested:${EXPORT}`, 600);
    const sent = message(envelope());
    await run([sent]);
    expect(handler).not.toHaveBeenCalled();
    expect(sent.retry).toHaveBeenCalledOnce();
    expect(sent.ack).not.toHaveBeenCalled();
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

describe("retryDelaySeconds", () => {
  it("doubles from thirty seconds and stops at an hour", () => {
    expect(retryDelaySeconds(1)).toBe(30);
    expect(retryDelaySeconds(2)).toBe(60);
    expect(retryDelaySeconds(3)).toBe(120);
    expect(retryDelaySeconds(50)).toBe(3600);
    expect(retryDelaySeconds(0)).toBe(30);
  });
});
