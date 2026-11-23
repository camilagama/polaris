import { describe, expect, it } from "vitest";
import {
  ACCOUNT_UNAVAILABLE_REASONS,
  DEVICE_CHECK_UNAVAILABLE_REASON,
  isBrowserFailure,
  LEGAL_ACCEPTANCE_REASON,
  PLAN_REFUSED_REASON,
  SERVER_FAILED_REASON,
  startFailureReason,
} from "./offline-runtime";
import { BootstrapResponseMismatchError } from "./runtime-api";

function reasonOf(error: Error, legal = false): string {
  return startFailureReason(error, legal, error.message);
}

describe("isBrowserFailure", () => {
  it("blames the browser for a reason that is not the account's, the store's or the plan's", () => {
    for (const reason of ["storage_unavailable", "indexeddb_failed", ""]) {
      expect(isBrowserFailure(reason)).toBe(true);
    }
  });

  it("blames the browser when there is no reason", () => {
    expect(isBrowserFailure(null)).toBe(true);
  });

  it("does not blame the browser for any reason of the account or the store", () => {
    expect(ACCOUNT_UNAVAILABLE_REASONS.size).toBeGreaterThan(0);
    for (const reason of ACCOUNT_UNAVAILABLE_REASONS) {
      expect(isBrowserFailure(reason)).toBe(false);
    }
  });

  it("does not blame the browser when the plan refused", () => {
    expect(isBrowserFailure(PLAN_REFUSED_REASON)).toBe(false);
  });

  it("does not blame the browser when the server did not answer whose the device is", () => {
    expect(isBrowserFailure(DEVICE_CHECK_UNAVAILABLE_REASON)).toBe(false);
  });
});

describe("startFailureReason", () => {
  it("names a 500 of the server with the neutral reason, and the browser is not blamed", () => {
    const error = Object.assign(new Error("Internal server error"), {
      code: "INTERNAL_SERVER_ERROR",
    });
    const reason = reasonOf(error);
    expect(reason).toBe(SERVER_FAILED_REASON);
    expect(isBrowserFailure(reason)).toBe(false);
  });

  it.each(["SERVICE_UNAVAILABLE", "BAD_GATEWAY", "TIMEOUT"])(
    "names %s as a failure of the server",
    (code) => {
      expect(reasonOf(Object.assign(new Error("x"), { code }))).toBe(
        SERVER_FAILED_REASON
      );
    }
  );

  it("names the bootstrap response mismatch with the neutral reason, and the browser is not blamed", () => {
    const reason = reasonOf(new BootstrapResponseMismatchError());
    expect(reason).toBe(SERVER_FAILED_REASON);
    expect(isBrowserFailure(reason)).toBe(false);
  });

  it("recognises the mismatch by the name its class sets", () => {
    expect(new BootstrapResponseMismatchError().name).toBe(
      "BootstrapResponseMismatchError"
    );
  });

  it.each(["UNAUTHORIZED", "FORBIDDEN", "CONFLICT", "NOT_FOUND"])(
    "keeps the message for a refusal of the server (%s)",
    (code) => {
      expect(reasonOf(Object.assign(new Error("refused"), { code }))).toBe(
        "refused"
      );
    }
  );

  it("keeps the message for a storage failure of the browser, and the browser is blamed", () => {
    const reason = reasonOf(new DOMException("quota", "QuotaExceededError"));
    expect(reason).toBe("quota");
    expect(isBrowserFailure(reason)).toBe(true);
  });

  it.each([
    ["a fetch that did not reach the server", new TypeError("Failed to fetch")],
    ["a timeout", new DOMException("t", "TimeoutError")],
  ])("keeps the message for %s, as before", (_name, error) => {
    const reason = reasonOf(error);
    expect(reason).toBe(error.message);
    expect(isBrowserFailure(reason)).toBe(true);
  });

  it("keeps the legal acceptance and the plan refusal ahead of the server failure", () => {
    const legal = Object.assign(new Error("x"), {
      code: "INTERNAL_SERVER_ERROR",
    });
    expect(reasonOf(legal, true)).toBe(LEGAL_ACCEPTANCE_REASON);
    const plan = Object.assign(new Error("x"), {
      code: "INTERNAL_SERVER_ERROR",
      data: { reason: "entitlement_denied" },
    });
    expect(reasonOf(plan)).toBe(PLAN_REFUSED_REASON);
  });
});
