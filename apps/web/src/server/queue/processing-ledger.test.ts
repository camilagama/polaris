import { describe, expect, it, vi } from "vitest";
import {
  createDurableProcessingLedger,
  createInMemoryProcessingLedger,
  type ProcessingKey,
  type ProcessingLedger,
  type ProcessingStore,
} from "./processing-ledger";

const EVENT = "0199a1b2-c3d4-7e5f-9a6b-7c8d9e0f1a2c";

function keyOf(name: string, overrides: Partial<ProcessingKey> = {}) {
  return {
    attempt: 1,
    eventId: EVENT,
    idempotencyKey: name,
    organizationId: "org_1",
    type: "data_export.requested",
    ...overrides,
  } satisfies ProcessingKey;
}

function tokenOf(claim: Awaited<ReturnType<ProcessingLedger["claim"]>>) {
  if (claim.result !== "claimed") {
    throw new Error("not claimed");
  }
  return claim.token;
}

describe("the in-memory processing ledger", () => {
  it("lets one claim take a key and says busy to the next", async () => {
    const ledger = createInMemoryProcessingLedger(() => 0);
    expect(await ledger.claim(keyOf("k"), 60)).toMatchObject({
      result: "claimed",
    });
    expect(await ledger.claim(keyOf("k"), 60)).toEqual({ result: "busy" });
  });

  it("frees a key whose lease ended, so a dead consumer does not block it", async () => {
    let now = 0;
    const ledger = createInMemoryProcessingLedger(() => now);
    await ledger.claim(keyOf("k"), 60);
    now = 59_999;
    expect(await ledger.claim(keyOf("k"), 60)).toEqual({ result: "busy" });
    now = 60_000;
    expect(await ledger.claim(keyOf("k"), 60)).toMatchObject({
      result: "claimed",
    });
  });

  it("says done for good after complete, whatever the clock", async () => {
    let now = 0;
    const ledger = createInMemoryProcessingLedger(() => now);
    await ledger.claim(keyOf("k"), 1);
    await ledger.complete(keyOf("k"));
    now = 10 ** 9;
    expect(await ledger.claim(keyOf("k"), 1)).toEqual({ result: "done" });
  });

  it("gives a claimed key back on release, but never undoes a done one", async () => {
    const ledger = createInMemoryProcessingLedger(() => 0);
    const held = await ledger.claim(keyOf("a"), 60);
    await ledger.release(keyOf("a"), tokenOf(held));
    expect(await ledger.claim(keyOf("a"), 60)).toMatchObject({
      result: "claimed",
    });
    await ledger.complete(keyOf("b"));
    await ledger.release(keyOf("b"), "1");
    expect(await ledger.claim(keyOf("b"), 60)).toEqual({ result: "done" });
  });

  it("lets only the holder of a claim give it back", async () => {
    let now = 0;
    const ledger = createInMemoryProcessingLedger(() => now);
    const first = tokenOf(await ledger.claim(keyOf("k"), 60));
    now = 60_000;
    const second = tokenOf(await ledger.claim(keyOf("k"), 60));
    // the first holder fails late: its release must not free the second one's claim
    await ledger.release(keyOf("k"), first);
    expect(await ledger.claim(keyOf("k"), 60)).toEqual({ result: "busy" });
    await ledger.release(keyOf("k"), second);
    expect(await ledger.claim(keyOf("k"), 60)).toMatchObject({
      result: "claimed",
    });
  });

  it("does not forget a claim in progress when it is over its bound", async () => {
    const ledger = createInMemoryProcessingLedger(() => 0);
    await ledger.claim(keyOf("running"), 600);
    for (let index = 0; index < 2100; index += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: the order of the keys is the point.
      await ledger.complete(keyOf(`key-${index}`));
    }
    expect(await ledger.claim(keyOf("running"), 600)).toEqual({
      result: "busy",
    });
  });

  it("keeps the keys apart and forgets the oldest past its bound", async () => {
    const ledger = createInMemoryProcessingLedger(() => 0);
    await ledger.complete(keyOf("first"));
    for (let index = 0; index < 2000; index += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: the order of the keys is the point.
      await ledger.complete(keyOf(`key-${index}`));
    }
    expect(await ledger.claim(keyOf("key-1999"), 60)).toEqual({
      result: "done",
    });
    expect(await ledger.claim(keyOf("first"), 60)).toMatchObject({
      result: "claimed",
    });
  });

  it("answers unknown for the same key under another event, and does not overwrite it on complete", async () => {
    const ledger = createInMemoryProcessingLedger(() => 0);
    const other = keyOf("k", {
      eventId: "0199a1b2-c3d4-7e5f-9a6b-000000000001",
    });
    await ledger.claim(keyOf("k"), 60);
    expect(await ledger.claim(other, 60)).toEqual({ result: "unknown" });
    await ledger.complete(other);
    // the original event still holds its claim: the other one's complete did not mark it done
    expect(await ledger.claim(keyOf("k"), 60)).toEqual({ result: "busy" });
    await ledger.complete(keyOf("k"));
    expect(await ledger.claim(other, 60)).toEqual({ result: "unknown" });
    expect(await ledger.claim(keyOf("k"), 60)).toEqual({ result: "done" });
  });

  it("says done for an attempt up to the one completed, and lets a later attempt claim again", async () => {
    const ledger = createInMemoryProcessingLedger(() => 0);
    await ledger.claim(keyOf("k", { attempt: 3 }), 60);
    await ledger.complete(keyOf("k", { attempt: 3 }));
    expect(await ledger.claim(keyOf("k", { attempt: 3 }), 60)).toEqual({
      result: "done",
    });
    expect(await ledger.claim(keyOf("k", { attempt: 1 }), 60)).toEqual({
      result: "done",
    });
    const next = await ledger.claim(keyOf("k", { attempt: 4 }), 60);
    expect(next).toMatchObject({ result: "claimed" });
    await ledger.complete(keyOf("k", { attempt: 4 }));
    expect(await ledger.claim(keyOf("k", { attempt: 4 }), 60)).toEqual({
      result: "done",
    });
  });

  it("never lets the stored attempt go back when an older attempt completes late", async () => {
    const ledger = createInMemoryProcessingLedger(() => 0);
    await ledger.complete(keyOf("k", { attempt: 5 }));
    await ledger.complete(keyOf("k", { attempt: 2 }));
    expect(await ledger.claim(keyOf("k", { attempt: 5 }), 60)).toEqual({
      result: "done",
    });
    expect(await ledger.claim(keyOf("k", { attempt: 3 }), 60)).toEqual({
      result: "done",
    });
    expect(await ledger.claim(keyOf("k", { attempt: 6 }), 60)).toMatchObject({
      result: "claimed",
    });
  });

  it("keeps the same idempotency key apart per organization", async () => {
    const ledger = createInMemoryProcessingLedger(() => 0);
    await ledger.complete(keyOf("k"));
    expect(
      await ledger.claim(keyOf("k", { organizationId: "org_2" }), 60)
    ).toMatchObject({ result: "claimed" });
    expect(await ledger.claim(keyOf("k"), 60)).toEqual({ result: "done" });
  });
});

describe("the durable processing ledger", () => {
  function fakeStore() {
    return {
      claimProcessing: vi.fn<ProcessingStore["claimProcessing"]>(() =>
        Promise.resolve({ result: "claimed", token: "t-1" })
      ),
      completeProcessing: vi.fn<ProcessingStore["completeProcessing"]>(() =>
        Promise.resolve()
      ),
      releaseProcessing: vi.fn<ProcessingStore["releaseProcessing"]>(() =>
        Promise.resolve()
      ),
    } satisfies ProcessingStore;
  }

  it("hands the key and the lease to the store and returns what it says", async () => {
    const store = fakeStore();
    const ledger = createDurableProcessingLedger(store);
    const key = keyOf("k", { attempt: 2 });
    expect(await ledger.claim(key, 960)).toEqual({
      result: "claimed",
      token: "t-1",
    });
    expect(store.claimProcessing).toHaveBeenCalledWith(key, 960);

    store.claimProcessing.mockResolvedValueOnce({ result: "unknown" });
    expect(await ledger.claim(key, 960)).toEqual({ result: "unknown" });
  });

  it("completes and releases through the store with the key and the token", async () => {
    const store = fakeStore();
    const ledger = createDurableProcessingLedger(store);
    const key = keyOf("k");
    await ledger.complete(key);
    await ledger.release(key, "t-1");
    expect(store.completeProcessing).toHaveBeenCalledWith(key);
    expect(store.releaseProcessing).toHaveBeenCalledWith(key, "t-1");
  });

  it("lets a store failure reach the caller", async () => {
    const store = fakeStore();
    store.claimProcessing.mockRejectedValueOnce(new Error("down"));
    const ledger = createDurableProcessingLedger(store);
    await expect(ledger.claim(keyOf("k"), 60)).rejects.toThrow("down");
  });
});
