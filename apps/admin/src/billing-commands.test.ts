import { InvalidEntitlementGrantError } from "@polaris/domain/billing/grants";
import { describe, expect, it, vi } from "vitest";
import {
  type BillingCommandPorts,
  grantEntitlementCommand,
  operatorActor,
  revokeEntitlementCommand,
} from "./billing-commands";

const principalId = "0199a0a0-0000-7000-8000-000000000001";
const caseId = "0199a0a0-0000-7000-8000-0000000000c1";
const grantId = "0199a0a0-0000-7000-8000-0000000000e1";
const now = new Date("2026-10-16T12:00:00.000Z");

function ports(overrides: Partial<BillingCommandPorts> = {}) {
  const calls: string[] = [];
  const value: BillingCommandPorts = {
    audit: vi.fn((_principal, _case, event) => {
      calls.push(`audit:${event}`);
      return Promise.resolve("org-1");
    }),
    find: vi.fn(() => Promise.resolve(null)),
    grant: vi.fn((input) => {
      calls.push("billing:grant");
      return Promise.resolve({ created: true, id: input.id ?? "x" });
    }),
    newId: () => grantId,
    revoke: vi.fn(() => {
      calls.push("billing:revoke");
      return Promise.resolve({ revoked: true });
    }),
    ...overrides,
  };
  return { calls, ports: value };
}

const command = {
  hours: 48,
  key: "variants.active.max",
  reason: "Compensação",
  value: 200,
};

describe("granting an entitlement", () => {
  it("writes the request down, does it, then writes the outcome down, as the operator", async () => {
    const { calls, ports: p } = ports();
    const result = await grantEntitlementCommand(
      p,
      principalId,
      caseId,
      command,
      now
    );
    expect(calls).toEqual([
      "audit:billing.entitlement_grant_requested",
      "billing:grant",
      "audit:billing.entitlement_granted",
    ]);
    expect(result).toEqual({
      created: true,
      id: grantId,
      organizationId: "org-1",
      outcomeRecorded: true,
    });
    expect(p.grant).toHaveBeenCalledWith({
      actor: `admin:${principalId}`,
      expiresAt: new Date("2026-10-18T12:00:00.000Z"),
      id: grantId,
      key: "variants.active.max",
      organizationId: "org-1",
      reason: "Compensação",
      // the command's own clock, for the start as for the end: the length stored is exactly the hours asked
      startsAt: now,
      value: 200,
    });
  });

  it("refuses what is not a valid grant before recording or doing anything", async () => {
    const { calls, ports: p } = ports();
    const bad = [
      { ...command, key: "plan.pro" },
      { ...command, reason: "  " },
      { ...command, hours: 366 * 24 + 1 },
      { ...command, value: 0 },
      { ...command, hours: 0 },
    ];
    const attempts = bad.map((candidate) =>
      grantEntitlementCommand(p, principalId, caseId, candidate, now)
    );
    const outcomes = await Promise.allSettled(attempts);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe("rejected");
      expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(
        InvalidEntitlementGrantError
      );
    }
    expect(calls).toEqual([]);
  });

  it("does nothing when the request cannot be recorded, and leaves the request recorded when billing fails", async () => {
    const unrecorded = ports({
      audit: () => Promise.reject(new Error("case_not_open")),
    });
    await expect(
      grantEntitlementCommand(
        unrecorded.ports,
        principalId,
        caseId,
        command,
        now
      )
    ).rejects.toThrow("case_not_open");
    expect(unrecorded.ports.grant).not.toHaveBeenCalled();

    const failing = ports({
      grant: () => Promise.reject(new Error("billing down")),
    });
    await expect(
      grantEntitlementCommand(failing.ports, principalId, caseId, command, now)
    ).rejects.toThrow("billing down");
    expect(failing.calls).toEqual([
      "audit:billing.entitlement_grant_requested",
    ]);
  });
});

describe("ending a grant", () => {
  it("records, ends only a grant of the case's organization, and records the outcome", async () => {
    const { calls, ports: p } = ports();
    expect(
      await revokeEntitlementCommand(p, principalId, caseId, grantId)
    ).toEqual({ outcomeRecorded: true, revoked: true });
    expect(calls).toEqual([
      "audit:billing.entitlement_revoke_requested",
      "billing:revoke",
      "audit:billing.entitlement_revoked",
    ]);
    expect(p.revoke).toHaveBeenCalledWith({
      actor: operatorActor(principalId),
      id: grantId,
      organizationId: "org-1",
    });
  });

  it("records no outcome for a grant that was not ended", async () => {
    const { calls, ports: p } = ports({
      revoke: () => Promise.resolve({ revoked: false }),
    });
    expect(
      await revokeEntitlementCommand(p, principalId, caseId, grantId)
    ).toEqual({ outcomeRecorded: true, revoked: false });
    expect(calls).toEqual(["audit:billing.entitlement_revoke_requested"]);
  });
});
