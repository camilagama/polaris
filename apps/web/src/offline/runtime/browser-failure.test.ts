import { describe, expect, it } from "vitest";
import {
  ACCOUNT_UNAVAILABLE_REASONS,
  isBrowserFailure,
  PLAN_REFUSED_REASON,
} from "./offline-runtime";

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
});
