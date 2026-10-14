import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "./canonical-json";

const sha256Pattern = /^[0-9a-f]{64}$/;

describe("canonical json", () => {
  it("ignores key order at every depth and keeps array order", () => {
    expect(canonicalJson({ a: { c: null, d: [2, 1] }, b: 1 })).toBe(
      canonicalJson({ a: { c: null, d: [2, 1] }, b: 1 })
    );
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("distinguishes values that print alike", () => {
    expect(canonicalJson({ a: "1" })).not.toBe(canonicalJson({ a: 1 }));
    expect(canonicalJson({ a: null })).not.toBe(canonicalJson({}));
  });

  it("hashes to 64 lowercase hex characters, deterministically", async () => {
    const first = await sha256Hex(canonicalJson({ a: 1 }));
    expect(first).toMatch(sha256Pattern);
    expect(await sha256Hex(canonicalJson({ a: 1 }))).toBe(first);
    expect(await sha256Hex(canonicalJson({ a: 2 }))).not.toBe(first);
  });
});
