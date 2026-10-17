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
    find: vi.fn(() => Promise.resolve(null)),
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

describe("asking twice, a moment apart", () => {
  const stored = {
    expiresAt: new Date("2026-10-18T12:00:00.000Z"),
    flagValue: null,
    grantedBy: `admin:${principalId}`,
    key: "variants.active.max",
    limitValue: 200,
    organizationId: "org-1",
    reason: "Compensação",
  };

  it("is the same grant when the ID already holds it, even though 'hours from now' is a different instant, and is not given twice", async () => {
    const find = vi.fn(() => Promise.resolve(stored));
    const p = ports({ find });
    const later = new Date(now.getTime() + 90_000);
    const result = await grantEntitlementCommand(
      p,
      principalId,
      caseId,
      { ...command, id: callerId },
      later
    );
    expect(find).toHaveBeenCalledWith(callerId);
    expect(p.grant).not.toHaveBeenCalled();
    expect(result).toEqual({
      created: false,
      id: callerId,
      organizationId: "org-1",
      outcomeRecorded: true,
    });
    // the repeat is written down like any request and ends with its outcome
    expect(p.audit).toHaveBeenCalledTimes(2);
  });

  it("refuses a different grant under the same ID, after the request was written down", async () => {
    for (const different of [
      { key: "images.active.max" },
      { limitValue: 300 },
      { reason: "Outro motivo" },
      { organizationId: "org-2" },
      { grantedBy: "admin:someone-else" },
    ]) {
      const p = ports({
        find: vi.fn(() => Promise.resolve({ ...stored, ...different })),
      });
      // biome-ignore lint/performance/noAwaitInLoops: Cases, in order.
      await expect(
        grantEntitlementCommand(
          p,
          principalId,
          caseId,
          { ...command, id: callerId },
          now
        )
      ).rejects.toThrow("entitlement_grant_id_conflict");
      expect(p.grant).not.toHaveBeenCalled();
      expect(p.audit).toHaveBeenCalledTimes(1);
    }
  });

  it("does not look anything up when the caller named no ID", async () => {
    const find = vi.fn(() => Promise.resolve(stored));
    const p = ports({ find });
    await grantEntitlementCommand(p, principalId, caseId, command, now);
    expect(find).not.toHaveBeenCalled();
    expect(p.grant).toHaveBeenCalledTimes(1);
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
