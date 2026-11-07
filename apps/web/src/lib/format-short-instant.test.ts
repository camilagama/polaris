import { describe, expect, it } from "vitest";
import { formatShortInstant } from "./format";

describe("formatShortInstant", () => {
  it("writes day, month and the time of the device, without the year", () => {
    expect(
      formatShortInstant(new Date(2026, 10, 1, 14, 20).toISOString())
    ).toBe("01/11 14:20");
  });

  it("writes midnight as 00, never 24", () => {
    expect(formatShortInstant(new Date(2026, 9, 3, 0, 5).toISOString())).toBe(
      "03/10 00:05"
    );
  });

  it("returns what it was given when it is not an instant", () => {
    expect(formatShortInstant("ontem")).toBe("ontem");
  });
});
