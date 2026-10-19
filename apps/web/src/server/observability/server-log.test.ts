import { afterEach, describe, expect, it, vi } from "vitest";
import { logServerError } from "./server-log";

function logged(error: unknown) {
  const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  logServerError({
    error,
    method: "POST",
    requestId: "req-1",
    route: "/rpc/sale/confirm",
    status: 500,
  });
  expect(spy).toHaveBeenCalledOnce();
  return spy.mock.calls[0]?.[0] as Record<string, unknown>;
}

const withCode = (code: string, cause?: unknown) =>
  Object.assign(new Error("message with ana@example.com"), { cause, code });

describe("logServerError sqlState", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["23505", "40001", "08006", "XX000", "57014"])(
    "puts the SQLSTATE %s of the error itself in sqlState",
    (code) => {
      const entry = logged(withCode(code));

      expect(entry).toMatchObject({
        errorCode: code,
        event: "server_error",
        sqlState: code,
      });
    }
  );

  it("finds the SQLSTATE in the cause of an ORM error", () => {
    const entry = logged(
      new Error("Failed query", { cause: withCode("23505") })
    );

    expect(entry.sqlState).toBe("23505");
    expect(entry.errorCode).toBeUndefined();
  });

  it("finds the SQLSTATE deeper in the chain, past a Node code", () => {
    const entry = logged(
      withCode("ECONNRESET", new Error("x", { cause: withCode("08006") }))
    );

    expect(entry).toMatchObject({ errorCode: "ECONNRESET", sqlState: "08006" });
  });

  it.each([
    "EPERM",
    "ECONNRESET",
    "ENOTFOUND",
    "SERVICE_UNAVAILABLE",
    "9422",
    "10001",
  ])("does not take the code %s for a SQLSTATE", (code) => {
    const entry = logged(withCode(code, withCode("EPERM")));

    expect(entry).not.toHaveProperty("sqlState");
  });

  it("omits sqlState when no error in the chain has a code", () => {
    const entry = logged(new Error("plain"));

    expect(entry).not.toHaveProperty("sqlState");
  });

  it("keeps the message out of the event", () => {
    const entry = logged(withCode("23505"));

    expect(JSON.stringify(entry)).not.toContain("ana@example.com");
  });
});
