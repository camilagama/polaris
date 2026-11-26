import { describe, expect, it } from "vitest";
import {
  ACCOUNT_UNAVAILABLE_REASONS,
  DEVICE_CHECK_UNAVAILABLE_REASON,
  isBrowserFailure,
  PLAN_REFUSED_REASON,
  SERVER_START_FAILED_REASON,
  startFailureReason,
} from "./offline-runtime";
import { BootstrapResponseMismatchError } from "./runtime-api";

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

function reasonOf(error: Error): string {
  return startFailureReason(error, false, error.message);
}

describe("startFailureReason", () => {
  it.each([
    "INTERNAL_SERVER_ERROR",
    "SERVICE_UNAVAILABLE",
    "BAD_GATEWAY",
    "GATEWAY_TIMEOUT",
    "TIMEOUT",
  ])("a %s of the server is its failure, not the browser's", (code) => {
    const reason = reasonOf(Object.assign(new Error("boom"), { code }));
    expect(reason).toBe(SERVER_START_FAILED_REASON);
    expect(isBrowserFailure(reason)).toBe(false);
  });

  it("a bootstrap page of another collection is the server's failure, not the browser's", () => {
    const reason = reasonOf(new BootstrapResponseMismatchError());
    expect(reason).toBe(SERVER_START_FAILED_REASON);
    expect(isBrowserFailure(reason)).toBe(false);
  });

  it("recognizes the mismatch by the name its class sets", () => {
    expect(new BootstrapResponseMismatchError().name).toBe(
      "BootstrapResponseMismatchError"
    );
  });

  it.each(["UNAUTHORIZED", "FORBIDDEN", "CONFLICT", "NOT_FOUND"])(
    "a %s refusal keeps its message",
    (code) => {
      const error = Object.assign(new Error("refused"), { code });
      expect(reasonOf(error)).toBe("refused");
    }
  );

  it("an error of the local storage keeps its message and blames the browser", () => {
    const error = new DOMException("quota", "QuotaExceededError");
    const reason = reasonOf(error);
    expect(reason).toBe("quota");
    expect(isBrowserFailure(reason)).toBe(true);
  });

  it.each([
    new TypeError("Failed to fetch"),
    new DOMException("t", "TimeoutError"),
  ])("no answer at all keeps its message, as before (%s)", (error) => {
    const reason = reasonOf(error);
    expect(reason).toBe(error.message);
    expect(isBrowserFailure(reason)).toBe(true);
  });

  it("the legal acceptance and the plan come before the failure of the server", () => {
    const error = Object.assign(new Error("denied"), {
      code: "INTERNAL_SERVER_ERROR",
      data: { reason: "entitlement_denied" },
    });
    expect(reasonOf(error)).toBe(PLAN_REFUSED_REASON);
    expect(startFailureReason(error, true, "x")).toBe(
      "legal_acceptance_required"
    );
  });
});
