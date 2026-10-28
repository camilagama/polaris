import { describe, expect, it } from "vitest";
import { clientErrorEventSchema } from "./client-error";
import { chunkNameOfFrame } from "./client-error-fields";

const PERSONAL_WORDS = /organization|user|session|device/i;

const valid = {
  errorName: "Error",
  kind: "error",
  routeId: "home",
  v: 1,
} as const;

describe("clientErrorEventSchema", () => {
  it("has no key that names a store or a person", () => {
    const keys = Object.keys(
      (clientErrorEventSchema as unknown as { def: { shape: object } }).def
        .shape
    );

    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).not.toMatch(PERSONAL_WORDS);
    }
  });

  it.each([
    "organizationId",
    "userId",
    "sessionId",
    "deviceId",
    "user",
    "session",
  ])("refuses an event with the key %s", (key) => {
    expect(
      clientErrorEventSchema.safeParse({ ...valid, [key]: "x" }).success
    ).toBe(false);
  });

  it("accepts the event without extra keys and refuses any extra key", () => {
    expect(clientErrorEventSchema.safeParse(valid).success).toBe(true);
    expect(
      clientErrorEventSchema.safeParse({ ...valid, extra: 1 }).success
    ).toBe(false);
  });
});

describe("chunkNameOfFrame", () => {
  it("drops the hash, the line and the column", () => {
    expect(chunkNameOfFrame("sale-form-model-BX3k9a1Z.js:1:2")).toBe(
      "sale-form-model"
    );
  });

  it("is null for a text that is not a frame", () => {
    expect(chunkNameOfFrame("https://x.example/a.js:1:2")).toBeNull();
  });
});
