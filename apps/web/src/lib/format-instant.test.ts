import { describe, expect, it } from "vitest";
import { formatInstant } from "./format";

describe("formatInstant", () => {
  const instant = "2026-10-14T12:00:00.000Z";

  it("writes date, a comma and the time in the zone it is given", () => {
    expect(formatInstant(instant, "America/Sao_Paulo")).toBe(
      "14/10/2026, 09:00"
    );
    expect(formatInstant(instant, "UTC")).toBe("14/10/2026, 12:00");
  });

  it("writes the same form in the device zone without one", () => {
    expect(formatInstant(new Date(2026, 9, 14, 9, 0).toISOString())).toBe(
      "14/10/2026, 09:00"
    );
    expect(formatInstant(instant, null)).toBe(formatInstant(instant));
  });

  it("falls back to the device zone for a zone it does not know", () => {
    expect(formatInstant(instant, "Nowhere/Land")).toBe(formatInstant(instant));
  });

  it("returns what it was given when it is not an instant", () => {
    expect(formatInstant("ontem", "UTC")).toBe("ontem");
  });
});
