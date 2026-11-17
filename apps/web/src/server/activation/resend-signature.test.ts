import { describe, expect, it } from "vitest";
import {
  SVIX_TOLERANCE_SECONDS,
  svixKeyOf,
  verifySvixSignature,
} from "./resend-signature";

/**
 * The vector of Svix's own documentation (secret, id, timestamp, body and signature), pasted as constants: the
 * signature was also recomputed outside the repository with a separate HMAC implementation.
 */
const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const ID = "msg_p5jXN8AQM9LWM0D4loKWxJek";
const TIMESTAMP = "1614265330";
const BODY = '{"test": 2432232314}';
const SIGNATURE = "g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=";
const NOW_MS = Number(TIMESTAMP) * 1000;

const vectorKey = svixKeyOf(SECRET);
if (!vectorKey) {
  throw new Error("the vector's secret must be usable");
}
const key = vectorKey;

function verify(
  overrides: {
    body?: string;
    id?: string | null;
    nowMs?: number;
    signature?: string | null;
    timestamp?: string | null;
  } = {}
) {
  return verifySvixSignature({
    body: overrides.body ?? BODY,
    headers: {
      id: "id" in overrides ? overrides.id : ID,
      signature:
        "signature" in overrides ? overrides.signature : `v1,${SIGNATURE}`,
      timestamp: "timestamp" in overrides ? overrides.timestamp : TIMESTAMP,
    },
    key,
    nowMs: overrides.nowMs ?? NOW_MS,
  });
}

describe("the key of the webhook's secret", () => {
  it("reads the key bytes of a whsec_ secret", () => {
    expect(key?.byteLength).toBe(24);
  });

  it.each([
    ["undefined", undefined],
    ["empty", ""],
    ["without the prefix", "MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"],
    ["not base64", "whsec_!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"],
    ["under 24 bytes", "whsec_c2hvcnQ="],
    ["bad padding", "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaS"],
  ])("refuses a secret that is %s", (_label, secret) => {
    expect(svixKeyOf(secret)).toBeNull();
  });
});

describe("the signature of the provider's delivery", () => {
  it("accepts the documented vector", async () => {
    expect(await verify()).toBe(true);
  });

  it("refuses a body changed by one byte", async () => {
    expect(await verify({ body: '{"test": 2432232315}' })).toBe(false);
    expect(await verify({ body: `${BODY} ` })).toBe(false);
  });

  it("refuses another id or another timestamp, which are part of the signed text", async () => {
    expect(await verify({ id: "msg_p5jXN8AQM9LWM0D4loKWxJeX" })).toBe(false);
    expect(await verify({ timestamp: "1614265331" })).toBe(false);
  });

  it.each([
    ["no id", { id: null }],
    ["no signature", { signature: null }],
    ["no timestamp", { timestamp: null }],
    ["an empty signature", { signature: "" }],
    [
      "an id with a character outside the alphabet",
      { id: "msg_p5jXN8AQM9 LW" },
    ],
    ["an id that is too short", { id: "msg_1" }],
    ["a timestamp with a sign", { timestamp: "-1614265330" }],
    ["a timestamp with a decimal point", { timestamp: "1614265330.5" }],
    ["a timestamp of 11 digits", { timestamp: "16142653300" }],
    ["a timestamp with a leading plus", { timestamp: "+161426533" }],
    ["a signature of another version", { signature: `v2,${SIGNATURE}` }],
    ["a signature without a version", { signature: SIGNATURE }],
    ["a signature that is not base64", { signature: "v1,%%%%" }],
    ["a signature with a third part", { signature: `v1,${SIGNATURE},extra` }],
  ])("refuses %s", async (_label, overrides) => {
    expect(await verify(overrides)).toBe(false);
  });

  it("accepts a timestamp exactly at the edge of the window, in both directions, and refuses one second beyond", async () => {
    const limit = SVIX_TOLERANCE_SECONDS * 1000;
    expect(await verify({ nowMs: NOW_MS + limit })).toBe(true);
    expect(await verify({ nowMs: NOW_MS - limit })).toBe(true);
    expect(await verify({ nowMs: NOW_MS + limit + 1000 })).toBe(false);
    expect(await verify({ nowMs: NOW_MS - limit - 1000 })).toBe(false);
  });

  it("accepts the list of a rotation when any v1 entry matches, in any position", async () => {
    const wrong = "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    expect(await verify({ signature: `${wrong} v1,${SIGNATURE}` })).toBe(true);
    expect(await verify({ signature: `v1,${SIGNATURE} ${wrong}` })).toBe(true);
    expect(await verify({ signature: `v2,x ${wrong} v1,${SIGNATURE}` })).toBe(
      true
    );
  });

  it("reads at most five entries: a match after them is not seen", async () => {
    const wrong = "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const five = Array.from({ length: 5 }, () => wrong).join(" ");
    expect(await verify({ signature: `${five} v1,${SIGNATURE}` })).toBe(false);
  });

  it("refuses a signature made with another key", async () => {
    const other = svixKeyOf(`whsec_${btoa("another-signing-key-0123456789")}`);
    if (!other) {
      throw new Error("the other secret must be usable");
    }
    expect(
      await verifySvixSignature({
        body: BODY,
        headers: {
          id: ID,
          signature: `v1,${SIGNATURE}`,
          timestamp: TIMESTAMP,
        },
        key: other,
        nowMs: NOW_MS,
      })
    ).toBe(false);
  });
});
