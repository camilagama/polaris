import { InvalidEntitlementGrantError } from "@polaris/domain/billing/grants";
import { describe, expect, it, vi } from "vitest";
import {
  type BillingCommandPorts,
  grantEntitlementCommand,
  revokeEntitlementCommand,
} from "./billing-commands";

const principalId = "0199a0a0-0000-7000-8000-000000000001";
const caseId = "0199a0a0-0000-7000-8000-0000000000c1";
const grantId = "0199a0a0-0000-7000-8000-0000000000e1";
const callerId = "0199a0a0-0000-7000-8000-0000000000f1";
const now = new Date("2026-10-16T12:00:00.000Z");
const command = {
  hours: 24,
  key: "variants.active.max",
  reason: "Compensação",
  value: 200,
};

function ports(overrides: Partial<BillingCommandPorts> = {}) {
  const value: BillingCommandPorts = {
    audit: vi.fn(() => Promise.resolve("org-1")),
    grant: vi.fn((input) =>
      Promise.resolve({ created: true, id: input.id ?? "x" })
    ),
    newId: () => grantId,
    revoke: vi.fn(() => Promise.resolve({ revoked: true })),
    ...overrides,
  };
  return value;
}

describe("what is written down", () => {
  it("records only the key, never the reason, and the grant's ID", async () => {
    const p = ports();
    await grantEntitlementCommand(p, principalId, caseId, command, now);
    expect(p.audit).toHaveBeenNthCalledWith(
      1,
      principalId,
      caseId,
      "billing.entitlement_grant_requested",
      grantId,
      "key=variants.active.max"
    );
    expect(JSON.stringify(vi.mocked(p.audit).mock.calls)).not.toContain(
      "Compensação"
    );
  });

  it("refuses control characters in the reason before anything is recorded", async () => {
    const p = ports();
    await expect(
      grantEntitlementCommand(
        p,
        principalId,
        caseId,
        { ...command, reason: "a\u001bb" },
        now
      )
    ).rejects.toBeInstanceOf(InvalidEntitlementGrantError);
    expect(p.audit).not.toHaveBeenCalled();
  });
});

describe("asking twice", () => {
  it("uses the caller's own ID so a repeat is the same grant", async () => {
    const p = ports();
    await grantEntitlementCommand(
      p,
      principalId,
      caseId,
      { ...command, id: callerId },
      now
    );
    expect(p.grant).toHaveBeenCalledWith(
      expect.objectContaining({ id: callerId })
    );
    expect(p.audit).toHaveBeenNthCalledWith(
      1,
      principalId,
      caseId,
      "billing.entitlement_grant_requested",
      callerId,
      "key=variants.active.max"
    );
  });
});

describe("when the outcome cannot be written", () => {
  it("says the grant was given, not that it failed, and keeps the request in the audit", async () => {
    const audit = vi
      .fn()
      .mockResolvedValueOnce("org-1")
      .mockRejectedValueOnce(new Error("case_not_open"));
    const p = ports({ audit });
    const result = await grantEntitlementCommand(
      p,
      principalId,
      caseId,
      command,
      now
    );
    expect(result).toEqual({
      created: true,
      id: grantId,
      organizationId: "org-1",
      outcomeRecorded: false,
    });
    expect(p.grant).toHaveBeenCalledOnce();
  });

  it("does the same when ending a grant, and says nothing more when nothing ended", async () => {
    const audit = vi
      .fn()
      .mockResolvedValueOnce("org-1")
      .mockRejectedValueOnce(new Error("operator disabled"));
    expect(
      await revokeEntitlementCommand(
        ports({ audit }),
        principalId,
        caseId,
        grantId
      )
    ).toEqual({ outcomeRecorded: false, revoked: true });
    const nothing = ports({
      revoke: () => Promise.resolve({ revoked: false }),
    });
    expect(
      await revokeEntitlementCommand(nothing, principalId, caseId, grantId)
    ).toEqual({ outcomeRecorded: true, revoked: false });
    expect(nothing.audit).toHaveBeenCalledTimes(1);
  });
});
