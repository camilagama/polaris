import { describe, expect, it, vi } from "vitest";
import type { TenantRequestTransaction } from "./tenant-transaction";
import { tenantAuditEvents } from "./schema/tenant-audit";
import {
  recordTenantAuditEvent,
  TenantAuditEventError,
  type TenantAuditIdentity,
} from "./tenant-audit";

const identity: TenantAuditIdentity = {
  organizationId: "organization-1",
  userId: "user-1",
};

describe("recordTenantAuditEvent", () => {
  it("uses the authorized identity and writes only the event envelope", async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    const insert = vi.fn().mockReturnValue({ values });
    const transaction = { insert } as unknown as TenantRequestTransaction;

    await recordTenantAuditEvent(transaction, identity, {
      entityId: "00000000-0000-4000-8000-000000000002",
      entityType: "organization",
      eventType: "organization.created",
      requestId: "00000000-0000-4000-8000-000000000001",
    });

    expect(insert).toHaveBeenCalledWith(tenantAuditEvents);
    expect(values).toHaveBeenCalledWith({
      organizationId: "organization-1",
      actorUserId: "user-1",
      eventType: "organization.created",
      entityType: "organization",
      entityId: "00000000-0000-4000-8000-000000000002",
      requestId: "00000000-0000-4000-8000-000000000001",
    });
  });

  it("rejects blank audit fields before issuing an INSERT", async () => {
    const insert = vi.fn();
    const transaction = { insert } as unknown as TenantRequestTransaction;

    await expect(
      recordTenantAuditEvent(transaction, identity, {
        entityId: " ",
        entityType: "organization",
        eventType: "organization.created",
      })
    ).rejects.toBeInstanceOf(TenantAuditEventError);

    expect(insert).not.toHaveBeenCalled();
  });

  it("rejects freeform entity data before issuing an INSERT", async () => {
    const insert = vi.fn();
    const transaction = { insert } as unknown as TenantRequestTransaction;

    await expect(
      recordTenantAuditEvent(transaction, identity, {
        entityId: "owner@example.invalid",
        entityType: "organization",
        eventType: "organization.created",
      })
    ).rejects.toBeInstanceOf(TenantAuditEventError);

    expect(insert).not.toHaveBeenCalled();
  });
});
