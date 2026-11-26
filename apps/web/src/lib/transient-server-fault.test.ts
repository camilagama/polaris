import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isTransientServerFault,
  TRANSIENT_REASON,
} from "./transient-server-fault";

const MODULE_REFERENCE =
  /^\s*(?:import\b|export\b[^;]*?\bfrom\b)|\brequire\(|\bimport\(/m;

const shapes: [number, string, string | undefined, boolean][] = [
  [503, "SERVICE_UNAVAILABLE", undefined, true],
  [503, "SERVICE_UNAVAILABLE", TRANSIENT_REASON, true],
  [503, "SERVICE_UNAVAILABLE", "billing_not_configured", false],
  [500, "INTERNAL_SERVER_ERROR", undefined, true],
  [500, "INTERNAL_SERVER_ERROR", TRANSIENT_REASON, false],
  [502, "BAD_GATEWAY", undefined, true],
  [429, "TOO_MANY_REQUESTS", undefined, false],
  [403, "FORBIDDEN", undefined, false],
  [400, "BAD_REQUEST", undefined, false],
  [503, "INTERNAL_SERVER_ERROR", TRANSIENT_REASON, false],
  [500, "SERVICE_UNAVAILABLE", TRANSIENT_REASON, true],
];

describe("isTransientServerFault", () => {
  it.each(shapes)(
    "%i %s with reason %s is %s",
    (status, code, reason, expected) => {
      expect(isTransientServerFault({ code, reason, status })).toBe(expected);
    }
  );

  it("counts a SERVICE_UNAVAILABLE with no reason whatever the status says", () => {
    expect(
      isTransientServerFault({
        code: "SERVICE_UNAVAILABLE",
        reason: undefined,
        status: undefined,
      })
    ).toBe(true);
  });

  it("needs a numeric status of 500 or more outside SERVICE_UNAVAILABLE", () => {
    expect(
      isTransientServerFault({
        code: undefined,
        reason: undefined,
        status: "500",
      })
    ).toBe(false);
    expect(
      isTransientServerFault({
        code: undefined,
        reason: undefined,
        status: undefined,
      })
    ).toBe(false);
    expect(
      isTransientServerFault({
        code: undefined,
        reason: undefined,
        status: 499,
      })
    ).toBe(false);
  });

  it.each([
    'import x from "./connection";',
    'import "./connection";',
    'export { x } from "./rpc-error";',
    'export * from "./rpc-error";',
    'const x = require("./connection");',
    'const x = await import("./connection");',
  ])("the detector of module references catches %s", (planted) => {
    expect(MODULE_REFERENCE.test(`const a = 1;\n${planted}\n`)).toBe(true);
  });

  it("imports nothing, so connection.ts and rpc-error.ts can both import it without a cycle", () => {
    const source = readFileSync(
      new URL("./transient-server-fault.ts", import.meta.url),
      "utf8"
    );
    expect(source).not.toMatch(MODULE_REFERENCE);
  });
});
