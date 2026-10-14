import { describe, expect, it } from "vitest";
import { uuidv7 } from "./uuidv7";

const uuidV7Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("uuidv7", () => {
  it("has the version 7 and variant bits", () => {
    for (let index = 0; index < 50; index += 1) {
      expect(uuidv7()).toMatch(uuidV7Pattern);
    }
  });

  it("encodes the timestamp in the first 48 bits", () => {
    const id = uuidv7(0x01_9c_2d_00_00_00, () => new Uint8Array(16));
    expect(id.startsWith("019c2d00-0000-7000-8000-")).toBe(true);
  });

  it("sorts by time", () => {
    const earlier = uuidv7(1_700_000_000_000);
    const later = uuidv7(1_700_000_000_001);
    expect(earlier < later).toBe(true);
  });

  it("does not repeat within the same millisecond", () => {
    const ids = new Set(
      Array.from({ length: 500 }, () => uuidv7(1_700_000_000_000))
    );
    expect(ids.size).toBe(500);
  });

  it("refuses timestamps that do not fit", () => {
    for (const bad of [-1, 2 ** 48, Number.NaN, 1.5]) {
      expect(() => uuidv7(bad)).toThrow(RangeError);
    }
  });
});
