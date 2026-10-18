import { describe, expect, it } from "vitest";
import {
  INCIDENT_RETRY_REASON_MAX_LENGTH,
  InvalidIncidentRetryError,
  normalizeIncidentRetryReason,
} from "./operational-incident";

describe("normalizeIncidentRetryReason", () => {
  it("returns the reason trimmed", () => {
    expect(normalizeIncidentRetryReason("  Fila voltou  ")).toBe("Fila voltou");
  });

  it("accepts exactly 150 code points, counting an emoji as one", () => {
    expect(INCIDENT_RETRY_REASON_MAX_LENGTH).toBe(150);
    const limit = `${"a".repeat(149)}😀`;
    expect(limit.length).toBe(151);
    expect(normalizeIncidentRetryReason(limit)).toBe(limit);
  });

  it("refuses 151 code points", () => {
    expect(() => normalizeIncidentRetryReason("a".repeat(151))).toThrow(
      InvalidIncidentRetryError
    );
  });

  it("refuses a missing, empty or blank reason, and anything that is not a string", () => {
    for (const reason of [undefined, null, "", "   ", "\t \n", 5, {}, ["x"]]) {
      expect(() => normalizeIncidentRetryReason(reason)).toThrow(
        InvalidIncidentRetryError
      );
    }
  });

  it("refuses a control character inside the reason", () => {
    for (const reason of ["a\u0000b", "a\nb", "a\u007fb", "a\u001bb"]) {
      expect(() => normalizeIncidentRetryReason(reason)).toThrow(
        InvalidIncidentRetryError
      );
    }
  });

  it("refuses invisible formatting: C1, line separators, zero-width and direction overrides", () => {
    for (const reason of [
      "a\u0085b",
      "a\u2028b",
      "a\u2029b",
      "a\u200bb",
      "a\u202eb",
      "a\u2066b",
      "a\ufeffb",
    ]) {
      expect(() => normalizeIncidentRetryReason(reason)).toThrow(
        InvalidIncidentRetryError
      );
    }
    expect(normalizeIncidentRetryReason("evento órfão — não é dado")).toBe(
      "evento órfão — não é dado"
    );
  });

  it("raises an error with the stable code invalid_incident_reason", () => {
    try {
      normalizeIncidentRetryReason("");
      throw new Error("expected a refusal");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(InvalidIncidentRetryError);
      expect((error as InvalidIncidentRetryError).code).toBe(
        "invalid_incident_reason"
      );
      expect((error as Error).message).toBe("invalid_incident_reason");
    }
  });
});
