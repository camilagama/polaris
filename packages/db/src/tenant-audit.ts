import type {
  TenantRequestIdentity,
  TenantRequestTransaction,
} from "./tenant-transaction";
import { tenantAuditEvents } from "./schema/tenant-audit";

export type TenantAuditIdentity = Pick<
  TenantRequestIdentity,
  "organizationId" | "userId"
>;

export interface TenantAuditEventInput {
  entityId: string;
  entityType: string;
  eventType: string;
  requestId?: string | null;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const eventTypePattern = /^[a-z][a-z0-9_.-]{0,127}$/;
const entityTypePattern = /^[a-z][a-z0-9_]{0,63}$/;

export class TenantAuditEventError extends Error {
  readonly code = "invalid_tenant_audit_event";

  constructor() {
    super("invalid_tenant_audit_event");
    this.name = "TenantAuditEventError";
  }
}

/**
 * Appends an audit event to an existing transaction. Tenant request callers must
 * use the identity returned by withAuthorizedTenantTransaction; onboarding may
 * use its verified user/organization context. This function starts no transaction
 * and accepts no event payloads or snapshots.
 */
export async function recordTenantAuditEvent(
  transaction: TenantRequestTransaction,
  identity: TenantAuditIdentity,
  input: TenantAuditEventInput
): Promise<void> {
  const identityValues = [identity.organizationId, identity.userId];
  if (
    identityValues.some((value) => !value.trim() || value !== value.trim()) ||
    !eventTypePattern.test(input.eventType) ||
    !entityTypePattern.test(input.entityType) ||
    !uuidPattern.test(input.entityId) ||
    (input.requestId !== undefined &&
      input.requestId !== null &&
      !uuidPattern.test(input.requestId))
  ) {
    throw new TenantAuditEventError();
  }
  await transaction.insert(tenantAuditEvents).values({
    organizationId: identity.organizationId,
    actorUserId: identity.userId,
    eventType: input.eventType,
    entityType: input.entityType,
    entityId: input.entityId,
    requestId: input.requestId ?? null,
  });
}
