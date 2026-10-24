import type { TenantAuditEventType } from "@polaris/domain/privacy/tenant-audit-events";
import { tenantAuditEvents } from "./schema/tenant-audit";
import type {
  TenantRequestIdentity,
  TenantRequestTransaction,
} from "./tenant-transaction";

export type TenantAuditIdentity = Pick<
  TenantRequestIdentity,
  "organizationId" | "userId"
>;

export interface TenantAuditEventInput {
  entityId: string;
  entityType: string;
  /** A type of the domain registry, which gives it its class: the database refuses any other (ADR 0081). */
  eventType: TenantAuditEventType;
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
    actorUserId: identity.userId,
    entityId: input.entityId,
    entityType: input.entityType,
    eventType: input.eventType,
    organizationId: identity.organizationId,
    requestId: input.requestId ?? null,
  });
}

/** The audit types of the owner's billing requests (ADR 0104, decision 3), one row per request ID and type. */
export type BillingRequestAuditType = Extract<
  TenantAuditEventType,
  | "billing.command_in_progress"
  | "billing.command_rate_limited"
  | "billing.command_refused"
  | "billing.overdue_payment_opened"
  | "billing.owner_renewal_cancel_requested"
  | "billing.refund_requested"
>;

/**
 * Appends the audit of one of the owner's billing requests (ADR 0104, decision 3) to an existing tenant transaction:
 * `entity_type = 'billing_request'` and `entity_id` = the client's request ID, so the same request audited twice is
 * one row (the partial unique index of migration 0100, `ON CONFLICT DO NOTHING` without `RETURNING`: the tenant only
 * inserts, and the cap's trigger drops the 11th refusal of the hour in silence). Nothing is counted here.
 */
export async function recordBillingRequestAudit(
  transaction: TenantRequestTransaction,
  identity: TenantAuditIdentity,
  input: { eventType: BillingRequestAuditType; requestId: string }
): Promise<void> {
  const identityValues = [identity.organizationId, identity.userId];
  if (
    identityValues.some((value) => !value.trim() || value !== value.trim()) ||
    !uuidPattern.test(input.requestId)
  ) {
    throw new TenantAuditEventError();
  }
  await transaction
    .insert(tenantAuditEvents)
    .values({
      actorUserId: identity.userId,
      entityId: input.requestId.toLowerCase(),
      entityType: "billing_request",
      eventType: input.eventType,
      organizationId: identity.organizationId,
    })
    .onConflictDoNothing();
}
