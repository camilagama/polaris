import { describe, expect, it } from "vitest";
import {
  canRecoverClosure,
  CLOSURE_RECOVERY_WINDOW_DAYS,
  closureConfirmationMatches,
  closureStatusAt,
  isClosureStatus,
  isOrganizationStatus,
  ORGANIZATION_STATUSES,
  recoveryDeadline,
} from "./closure";

const requestedAt = new Date("2026-10-17T12:00:00.000Z");

describe("the recovery window", () => {
  it("is thirty days from the request", () => {
    expect(CLOSURE_RECOVERY_WINDOW_DAYS).toBe(30);
    expect(recoveryDeadline(requestedAt).toISOString()).toBe(
      "2026-11-16T12:00:00.000Z"
    );
  });

  it("can be used up to, and not at, its end", () => {
    const deadline = recoveryDeadline(requestedAt);
    expect(
      canRecoverClosure("closing", deadline, new Date(deadline.getTime() - 1))
    ).toBe(true);
    expect(canRecoverClosure("closing", deadline, deadline)).toBe(false);
  });

  it("is only for an organization that is closing", () => {
    const deadline = recoveryDeadline(requestedAt);
    for (const status of [
      "active",
      "suspended",
      "closed",
      "purge_pending",
      "purged",
    ]) {
      expect(canRecoverClosure(status, deadline, requestedAt)).toBe(false);
    }
  });

  it("makes a closing organization closed once the window ended, and leaves every other status alone", () => {
    const deadline = recoveryDeadline(requestedAt);
    expect(closureStatusAt("closing", deadline, requestedAt)).toBe("closing");
    expect(closureStatusAt("closing", deadline, deadline)).toBe("closed");
    expect(closureStatusAt("active", deadline, deadline)).toBe("active");
    expect(closureStatusAt("purged", deadline, deadline)).toBe("purged");
  });
});

describe("the statuses", () => {
  it("name the whole life, in order", () => {
    expect(ORGANIZATION_STATUSES).toEqual([
      "active",
      "suspended",
      "closing",
      "closed",
      "purge_pending",
      "purged",
    ]);
  });

  it("tell a closure from an operational state", () => {
    expect(isClosureStatus("closing")).toBe(true);
    expect(isClosureStatus("purged")).toBe(true);
    expect(isClosureStatus("active")).toBe(false);
    expect(isClosureStatus("suspended")).toBe(false);
    expect(isClosureStatus("anything")).toBe(false);
    expect(isOrganizationStatus("closing")).toBe(true);
    expect(isOrganizationStatus("deleted")).toBe(false);
  });
});

describe("the confirmation", () => {
  it("is the organization's whole name, without regard to case or spacing", () => {
    expect(closureConfirmationMatches("loja da ana", "Loja da Ana")).toBe(true);
    expect(closureConfirmationMatches("  Loja   da Ana ", "Loja da Ana")).toBe(
      true
    );
    expect(closureConfirmationMatches("Loja da", "Loja da Ana")).toBe(false);
    expect(closureConfirmationMatches("", "Loja da Ana")).toBe(false);
  });

  it("treats composed and decomposed accents as the same text", () => {
    expect(closureConfirmationMatches("Café São", "Café São")).toBe(true);
  });

  it("never matches an empty name", () => {
    expect(closureConfirmationMatches("", "")).toBe(false);
    expect(closureConfirmationMatches("  ", " ")).toBe(false);
  });
});
