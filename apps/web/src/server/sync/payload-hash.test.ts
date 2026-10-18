import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../lib/canonical-json";
import {
  commandPayloadHashes,
  SyncPayloadHashUnavailableError,
  syncPayloadHashKeys,
} from "./payload-hash";

const current = "c".repeat(32);
const previous = "p".repeat(32);
const hexPattern = /^[0-9a-f]{64}$/;

describe("syncPayloadHashKeys", () => {
  it("fails closed without a secret or with a short one", () => {
    expect(() => syncPayloadHashKeys({})).toThrow(
      SyncPayloadHashUnavailableError
    );
    expect(() =>
      syncPayloadHashKeys({ SYNC_PAYLOAD_HASH_SECRET: "short" })
    ).toThrow(SyncPayloadHashUnavailableError);
    expect(() =>
      syncPayloadHashKeys({
        SYNC_PAYLOAD_HASH_PREVIOUS_SECRET: "short",
        SYNC_PAYLOAD_HASH_SECRET: current,
      })
    ).toThrow(SyncPayloadHashUnavailableError);
  });

  it("keeps the previous secret only for comparing", () => {
    expect(
      syncPayloadHashKeys({
        SYNC_PAYLOAD_HASH_PREVIOUS_SECRET: previous,
        SYNC_PAYLOAD_HASH_SECRET: current,
      })
    ).toEqual({ current, previous: [previous] });
    expect(syncPayloadHashKeys({ SYNC_PAYLOAD_HASH_SECRET: current })).toEqual({
      current,
      previous: [],
    });
    expect(
      syncPayloadHashKeys({
        SYNC_PAYLOAD_HASH_PREVIOUS_SECRET: "",
        SYNC_PAYLOAD_HASH_SECRET: current,
      })
    ).toEqual({ current, previous: [] });
  });
});

describe("commandPayloadHashes", () => {
  it("stores a keyed hash, not the plain SHA-256 of the content", async () => {
    const hashes = await commandPayloadHashes('{"phone":"11999990000"}', {
      current,
      previous: [],
    });
    expect(hashes.stored).toMatch(hexPattern);
    expect(hashes.stored).not.toBe(await sha256Hex('{"phone":"11999990000"}'));
  });

  it("depends on the secret", async () => {
    const one = await commandPayloadHashes("x", { current, previous: [] });
    const other = await commandPayloadHashes("x", {
      current: previous,
      previous: [],
    });
    expect(one.stored).not.toBe(other.stored);
  });

  it("matches what older rows hold: a previous key and the unkeyed hash", async () => {
    const before = await commandPayloadHashes("x", {
      current: previous,
      previous: [],
    });
    const after = await commandPayloadHashes("x", {
      current,
      previous: [previous],
    });
    expect(after.equivalent).toContain(before.stored);
    expect(after.equivalent).toContain(await sha256Hex("x"));
    expect(after.equivalent).not.toContain(after.stored);
  });
});
