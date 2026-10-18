import { describe, expect, it } from "vitest";
import {
  canonicalNameFor,
  forbiddenAliases,
  isOpaqueId,
  opaqueIdFields,
  outcomes,
} from "./fields";

describe("field schema", () => {
  it("names the canonical field for each forbidden alias", () => {
    expect(canonicalNameFor("orgId")).toBe("organizationId");
    expect(canonicalNameFor("userId")).toBe("actorId");
    expect(canonicalNameFor("reqId")).toBe("requestId");
    expect(canonicalNameFor("duration")).toBe("durationMs");
    expect(canonicalNameFor("ms")).toBe("durationMs");
    expect(canonicalNameFor("status")).toBe("outcome");
    expect(canonicalNameFor("statusCode")).toBe("httpStatus");
    expect(canonicalNameFor("errorName")).toBe("errorClass");
  });

  it("catches other spellings of a canonical name", () => {
    expect(canonicalNameFor("organization_id")).toBe("organizationId");
    expect(canonicalNameFor("Request_Id")).toBe("requestId");
    expect(canonicalNameFor("DURATIONMS")).toBe("durationMs");
  });

  it("leaves canonical names and free metrics alone", () => {
    for (const key of [
      "organizationId",
      "durationMs",
      "outcome",
      "missedWindows",
      "retry",
      "scanned",
    ]) {
      expect(canonicalNameFor(key)).toBeUndefined();
    }
  });

  it("never lists a canonical name as an alias of itself", () => {
    for (const [alias, canonical] of Object.entries(forbiddenAliases)) {
      expect(alias).not.toBe(canonical);
    }
  });

  it("has the values the plan asks for", () => {
    expect(outcomes).toEqual([
      "success",
      "partial",
      "rejected",
      "skipped",
      "failure",
    ]);
    for (const field of [
      "requestId",
      "correlationId",
      "organizationId",
      "actorId",
      "deviceId",
      "commandId",
    ]) {
      expect(opaqueIdFields).toContain(field);
    }
  });

  it("accepts ids and refuses e-mails, names and phones", () => {
    expect(isOpaqueId("0192f3c0-7b1e-7c3a-9d52-1f0a4b6c8e21")).toBe(true);
    expect(isOpaqueId("req_01HZ")).toBe(true);
    expect(isOpaqueId("maria@example.com")).toBe(false);
    expect(isOpaqueId("Maria Souza")).toBe(false);
    expect(isOpaqueId("+55 11 99999-0000")).toBe(false);
    expect(isOpaqueId("")).toBe(false);
    expect(isOpaqueId("a".repeat(129))).toBe(false);
    expect(isOpaqueId(42)).toBe(false);
  });
});
