import { outboxIdempotencyKey } from "@polaris/domain/events/outbox";
import { outboxRetryDelaySeconds } from "@polaris/domain/events/outbox-dispatch";
import { parseQueueEnvelope } from "@polaris/domain/events/queue-envelope";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DispatchedEvent,
  type DispatchStore,
  dispatchOutbox,
  type QueueProducer,
} from "./dispatcher";

const EXPORT_A = "0199a1b2-c3d4-7e5f-8a6b-aaaaaaaaaaaa";
const EXPORT_B = "0199a1b2-c3d4-7e5f-8a6b-bbbbbbbbbbbb";

function row(
  id: string,
  exportId: string,
  overrides: Partial<DispatchedEvent> = {}
): DispatchedEvent {
  return {
    attempts: 1,
    correlationId: "req-1",
    event: { exportId },
    id,
    idempotencyKey: outboxIdempotencyKey("data_export.requested", exportId),
    organizationId: "org_1",
    recovered: false,
    type: "data_export.requested",
    ...overrides,
  };
}

const ROW_A = row("0199a1b2-c3d4-7e5f-9a6b-00000000000a", EXPORT_A);
const ROW_B = row("0199a1b2-c3d4-7e5f-9a6b-00000000000b", EXPORT_B, {
  attempts: 3,
});

function fakeStore(claimed: DispatchedEvent[]) {
  return {
    claimOutboxEvents: vi.fn<DispatchStore["claimOutboxEvents"]>(() =>
      Promise.resolve(claimed)
    ),
    markOutboxEventsDispatched: vi.fn<
      DispatchStore["markOutboxEventsDispatched"]
    >((events) => Promise.resolve(events.length)),
    releaseOutboxEvents: vi.fn<DispatchStore["releaseOutboxEvents"]>((events) =>
      Promise.resolve(events.length)
    ),
  } satisfies DispatchStore;
}

function fakeProducer() {
  return {
    sendBatch: vi.fn<QueueProducer["sendBatch"]>(() => Promise.resolve()),
  } satisfies QueueProducer;
}

function logged() {
  return JSON.stringify([
    vi.mocked(console.warn).mock.calls,
    vi.mocked(console.error).mock.calls,
    vi.mocked(console.info).mock.calls,
  ]);
}

describe("dispatchOutbox", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports zero and touches nothing when no event is due", async () => {
    const store = fakeStore([]);
    const producer = fakeProducer();
    const report = await dispatchOutbox({
      queues: { default: producer },
      store,
    });
    expect(report).toEqual({
      claimed: 0,
      recovered: 0,
      released: 0,
      sent: 0,
      unmarked: 0,
      unsendable: 0,
    });
    expect(producer.sendBatch).not.toHaveBeenCalled();
    expect(store.markOutboxEventsDispatched).not.toHaveBeenCalled();
    expect(store.releaseOutboxEvents).not.toHaveBeenCalled();
  });

  it("claims 25 events with a lease of 960 seconds by default, or the limit it is given", async () => {
    const store = fakeStore([]);
    await dispatchOutbox({ queues: {}, store });
    expect(store.claimOutboxEvents).toHaveBeenCalledWith(25, 960);
    await dispatchOutbox({ limit: 7, queues: {}, store });
    expect(store.claimOutboxEvents).toHaveBeenLastCalledWith(7, 960);
  });

  it("sends the claimed events in one batch of valid envelopes on their queue, then marks them", async () => {
    const store = fakeStore([ROW_A, ROW_B]);
    const queue = fakeProducer();
    const other = fakeProducer();
    const report = await dispatchOutbox({
      queues: { critical: other, default: queue, media: other },
      store,
    });

    expect(queue.sendBatch).toHaveBeenCalledTimes(1);
    expect(other.sendBatch).not.toHaveBeenCalled();
    const messages = [...(queue.sendBatch.mock.calls[0]?.[0] ?? [])];
    expect(messages).toHaveLength(2);
    expect(messages.map((entry) => entry.contentType)).toEqual([
      "json",
      "json",
    ]);
    // each body is an envelope the consumer accepts, with the attempt the database counted
    const envelopes = messages.map((entry) => parseQueueEnvelope(entry.body));
    expect(envelopes.map((entry) => entry.eventId)).toEqual([
      ROW_A.id,
      ROW_B.id,
    ]);
    expect(envelopes.map((entry) => entry.attempt)).toEqual([1, 3]);
    expect(envelopes[0]).toMatchObject({
      correlationId: "req-1",
      event: { exportId: EXPORT_A },
      idempotencyKey: `data_export.requested:${EXPORT_A}`,
      organizationId: "org_1",
      type: "data_export.requested",
    });

    expect(store.markOutboxEventsDispatched).toHaveBeenCalledWith([
      { attempts: 1, id: ROW_A.id },
      { attempts: 3, id: ROW_B.id },
    ]);
    expect(store.releaseOutboxEvents).not.toHaveBeenCalled();
    expect(report).toEqual({
      claimed: 2,
      recovered: 0,
      released: 0,
      sent: 2,
      unmarked: 0,
      unsendable: 0,
    });
  });

  it("counts the events whose claim had run out as recovered", async () => {
    const store = fakeStore([{ ...ROW_A, recovered: true }, ROW_B]);
    const report = await dispatchOutbox({
      queues: { default: fakeProducer() },
      store,
    });
    expect(report).toMatchObject({ claimed: 2, recovered: 1, sent: 2 });
  });

  it("gives the events back with a delay, and marks nothing, when the queue refuses the batch", async () => {
    const store = fakeStore([ROW_A, ROW_B]);
    const producer = fakeProducer();
    producer.sendBatch.mockRejectedValue(new Error("quota ana@example.com"));
    const report = await dispatchOutbox({
      queues: { default: producer },
      store,
    });
    expect(store.releaseOutboxEvents).toHaveBeenCalledWith([
      { attempts: 1, delaySeconds: outboxRetryDelaySeconds(1), id: ROW_A.id },
      { attempts: 3, delaySeconds: outboxRetryDelaySeconds(3), id: ROW_B.id },
    ]);
    expect(store.releaseOutboxEvents.mock.calls[0]?.[0][1]?.delaySeconds).toBe(
      120
    );
    // nothing was sent, so nothing is marked as dispatched
    for (const [marked] of store.markOutboxEventsDispatched.mock.calls) {
      expect(marked).toEqual([]);
    }
    expect(report).toMatchObject({ released: 2, sent: 0, unmarked: 0 });
    // the class of the error is logged, never its text
    expect(console.error).toHaveBeenCalledWith(
      "outbox_send_failed",
      expect.objectContaining({ errorName: "Error", queue: "default" })
    );
    expect(logged()).not.toContain("ana@example.com");
  });

  it("gives the events back when their queue is not bound here", async () => {
    const store = fakeStore([ROW_A]);
    const report = await dispatchOutbox({ queues: {}, store });
    expect(store.releaseOutboxEvents).toHaveBeenCalledWith([
      { attempts: 1, delaySeconds: 30, id: ROW_A.id },
    ]);
    expect(report).toMatchObject({ released: 1, sent: 0 });
  });

  it("gives back with the longest delay an event this deploy cannot build, and still sends the others", async () => {
    const unknownType = row("0199a1b2-c3d4-7e5f-9a6b-0000000000c1", EXPORT_A, {
      type: "something.unknown",
    });
    const extraKey = row("0199a1b2-c3d4-7e5f-9a6b-0000000000c2", EXPORT_A, {
      attempts: 2,
      event: { exportId: EXPORT_A, other: "ana@example.com" },
    });
    const store = fakeStore([unknownType, ROW_A, extraKey]);
    const producer = fakeProducer();
    const report = await dispatchOutbox({
      queues: { default: producer },
      store,
    });

    expect(producer.sendBatch).toHaveBeenCalledTimes(1);
    expect([...(producer.sendBatch.mock.calls[0]?.[0] ?? [])]).toHaveLength(1);
    expect(store.markOutboxEventsDispatched).toHaveBeenCalledWith([
      { attempts: 1, id: ROW_A.id },
    ]);
    expect(store.releaseOutboxEvents).toHaveBeenCalledWith([
      { attempts: 1, delaySeconds: 3600, id: unknownType.id },
      { attempts: 2, delaySeconds: 3600, id: extraKey.id },
    ]);
    expect(report).toEqual({
      claimed: 3,
      recovered: 0,
      released: 2,
      sent: 1,
      unmarked: 0,
      unsendable: 2,
    });
    // the body is never logged, only the IDs
    expect(logged()).not.toContain("ana@example.com");
    expect(logged()).toContain(unknownType.id);
  });

  it("counts as unmarked what the database no longer lets it mark", async () => {
    const store = fakeStore([ROW_A, ROW_B]);
    store.markOutboxEventsDispatched.mockResolvedValue(1);
    const report = await dispatchOutbox({
      queues: { default: fakeProducer() },
      store,
    });
    expect(report).toMatchObject({ sent: 2, unmarked: 1 });
  });

  it("gives back what was not sent and rethrows when the mark fails", async () => {
    const unsendable = row("0199a1b2-c3d4-7e5f-9a6b-0000000000c1", EXPORT_A, {
      type: "something.unknown",
    });
    const store = fakeStore([ROW_A, unsendable]);
    store.markOutboxEventsDispatched.mockRejectedValue(new Error("db_down"));
    await expect(
      dispatchOutbox({ queues: { default: fakeProducer() }, store })
    ).rejects.toThrow("db_down");
    expect(store.releaseOutboxEvents).toHaveBeenCalledWith([
      { attempts: 1, delaySeconds: 3600, id: unsendable.id },
    ]);
  });

  it("does not release anything when the mark fails and every event was sent", async () => {
    const store = fakeStore([ROW_A]);
    store.markOutboxEventsDispatched.mockRejectedValue(new Error("db_down"));
    await expect(
      dispatchOutbox({ queues: { default: fakeProducer() }, store })
    ).rejects.toThrow("db_down");
    expect(store.releaseOutboxEvents).not.toHaveBeenCalled();
  });
});
