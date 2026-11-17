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
    ["a signature of another version", { signature: `v2,${SIGNATURE}` }],
    ["a signature without a version", { signature: SIGNATURE }],
    ["a signature that is not base64", { signature: "v1,%%%%" }],
    ["a signature with a third part", { signature: `v1,${SIGNATURE},extra` }],
  ])("refuses %s", async (_label, overrides) => {
    expect(await verify(overrides)).toBe(false);
  });

  describe("an id or a timestamp that is malformed but correctly signed", () => {
    async function signedFor(id: string, timestamp: string) {
      const hmacKey = await crypto.subtle.importKey(
        "raw",
        key,
        { hash: "SHA-256", name: "HMAC" },
        false,
        ["sign"]
      );
      const mac = new Uint8Array(
        await crypto.subtle.sign(
          "HMAC",
          hmacKey,
          new TextEncoder().encode(`${id}.${timestamp}.${BODY}`)
        )
      );
      return `v1,${btoa(String.fromCharCode(...mac))}`;
    }

    it("signs the controls the same way, so only the format can refuse", async () => {
      const signature = await signedFor(ID, TIMESTAMP);
      expect(signature).toBe(`v1,${SIGNATURE}`);
      expect(await verify({ signature })).toBe(true);
      const other = "msg_AAAAAAAAAAAA";
      expect(
        await verify({
          id: other,
          signature: await signedFor(other, TIMESTAMP),
        })
      ).toBe(true);
    });

    it.each([
      ["8 characters", "msg_AbC1"],
      ["100 characters", `msg_${"a".repeat(96)}`],
    ])(
      "accepts a correctly signed id of %s, the edges of the format",
      async (_label, id) => {
        const signature = await signedFor(id, TIMESTAMP);
        expect(await verify({ id, signature })).toBe(true);
      }
    );

    it.each([
      ["a space", "msg_p5jXN8AQM9 LW"],
      ["a dot, the separator of the signed text", "msg_p5jXN8.AQM9LWM0D4"],
      ["a character outside ASCII", "msg_p5jXN8AQM9LWMé0D4"],
      ["7 characters, one under the minimum", "msg_p5j"],
      ["101 characters, one over the maximum", `msg_${"a".repeat(97)}`],
    ])("refuses an id with %s", async (_label, id) => {
      const signature = await signedFor(id, TIMESTAMP);
      expect(await verify({ id, signature })).toBe(false);
    });

    it.each([
      ["a minus sign", "-161426533"],
      ["a leading plus", "+161426533"],
      ["a decimal point", "16142653.5"],
      ["an exponent", "1e9"],
      ["a hexadecimal prefix", "0x5B3CB9D1"],
      ["a leading space", " 161426533"],
      ["11 characters, a leading zero and the vector's value", `0${TIMESTAMP}`],
    ])(
      "refuses a timestamp with %s, though its value is inside the window",
      async (_label, timestamp) => {
        const signature = await signedFor(ID, timestamp);
        const nowMs = Number(timestamp) * 1000;
        expect(Number.isFinite(nowMs)).toBe(true);
        expect(await verify({ nowMs, signature, timestamp })).toBe(false);
      }
    );

    it("accepts a leading zero within 10 characters; the 11-character case above is refused by its length, not by the window", async () => {
      const timestamp = "0161426533";
      const signature = await signedFor(ID, timestamp);
      expect(
        await verify({ nowMs: 161_426_533_000, signature, timestamp })
      ).toBe(true);
    });
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
