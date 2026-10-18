import { describe, expect, it } from "vitest";
import {
  createInMemoryProcessingLedger,
  type ProcessingLedger,
} from "./processing-ledger";

function tokenOf(claim: Awaited<ReturnType<ProcessingLedger["claim"]>>) {
  if (claim.result !== "claimed") {
    throw new Error("not claimed");
  }
  return claim.token;
}

describe("the in-memory processing ledger", () => {
  it("lets one claim take a key and says busy to the next", async () => {
    const ledger = createInMemoryProcessingLedger(() => 0);
    expect(await ledger.claim("k", 60)).toMatchObject({ result: "claimed" });
    expect(await ledger.claim("k", 60)).toEqual({ result: "busy" });
  });

  it("frees a key whose lease ended, so a dead consumer does not block it", async () => {
    let now = 0;
    const ledger = createInMemoryProcessingLedger(() => now);
    await ledger.claim("k", 60);
    now = 59_999;
    expect(await ledger.claim("k", 60)).toEqual({ result: "busy" });
    now = 60_000;
    expect(await ledger.claim("k", 60)).toMatchObject({ result: "claimed" });
  });

  it("says done for good after complete, whatever the clock", async () => {
    let now = 0;
    const ledger = createInMemoryProcessingLedger(() => now);
    await ledger.claim("k", 1);
    await ledger.complete("k");
    now = 10 ** 9;
    expect(await ledger.claim("k", 1)).toEqual({ result: "done" });
  });

  it("gives a claimed key back on release, but never undoes a done one", async () => {
    const ledger = createInMemoryProcessingLedger(() => 0);
    const held = await ledger.claim("a", 60);
    await ledger.release("a", tokenOf(held));
    expect(await ledger.claim("a", 60)).toMatchObject({ result: "claimed" });
    await ledger.complete("b");
    await ledger.release("b", "1");
    expect(await ledger.claim("b", 60)).toEqual({ result: "done" });
  });

  it("lets only the holder of a claim give it back", async () => {
    let now = 0;
    const ledger = createInMemoryProcessingLedger(() => now);
    const first = tokenOf(await ledger.claim("k", 60));
    now = 60_000;
    const second = tokenOf(await ledger.claim("k", 60));
    // the first holder fails late: its release must not free the second one's claim
    await ledger.release("k", first);
    expect(await ledger.claim("k", 60)).toEqual({ result: "busy" });
    await ledger.release("k", second);
    expect(await ledger.claim("k", 60)).toMatchObject({ result: "claimed" });
  });

  it("does not forget a claim in progress when it is over its bound", async () => {
    const ledger = createInMemoryProcessingLedger(() => 0);
    await ledger.claim("running", 600);
    for (let index = 0; index < 2100; index += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: the order of the keys is the point.
      await ledger.complete(`key-${index}`);
    }
    expect(await ledger.claim("running", 600)).toEqual({ result: "busy" });
  });

  it("keeps the keys apart and forgets the oldest past its bound", async () => {
    const ledger = createInMemoryProcessingLedger(() => 0);
    await ledger.complete("first");
    for (let index = 0; index < 2000; index += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: the order of the keys is the point.
      await ledger.complete(`key-${index}`);
    }
    expect(await ledger.claim("key-1999", 60)).toEqual({ result: "done" });
    expect(await ledger.claim("first", 60)).toMatchObject({
      result: "claimed",
    });
  });
});
