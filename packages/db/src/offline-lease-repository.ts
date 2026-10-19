import { capabilitiesForRole } from "@polaris/domain/authorization/capabilities";
import { assertFlag } from "@polaris/domain/billing/entitlements";
import {
  buildOfflineLeaseClaims,
  type OfflineLeaseClaims,
  planOfflineLeaseWindow,
} from "@polaris/domain/offline/offline-lease";
import { and, eq, sql } from "drizzle-orm";
import { getEffectiveEntitlements } from "./billing-repository";
import {
  lockLiveDeviceForSession,
  type OfflineGrantRecord,
  recordOfflineGrant,
} from "./device-repository";
import { offlineGrants } from "./schema/device";
import { memberships } from "./schema/organization";
import type {
  TenantRequestIdentity,
  TenantRequestTransaction,
} from "./tenant-transaction";

export type OfflineLeaseRejection =
  | "capability_revoked"
  | "device_revoked"
  | "epoch_mismatch"
  | "grant_expired"
  | "grant_not_found"
  | "grant_revoked"
  | "wrong_principal";

/** The server refused to honor a lease; the reason is for logs, not for clients. */
export class OfflineLeaseRejectedError extends Error {
  readonly reason: OfflineLeaseRejection;

  constructor(reason: OfflineLeaseRejection) {
    super(`offline_lease_rejected:${reason}`);
    this.name = "OfflineLeaseRejectedError";
    this.reason = reason;
  }
}

/** Same key as bump_user_authorization_epoch() in migration 0043. */
async function lockAuthorizationEpoch(
  transaction: TenantRequestTransaction,
  userId: string
): Promise<void> {
  const key = `authorization-epoch:${userId}`;
  await transaction.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`
  );
}

async function currentEpoch(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity
): Promise<number> {
  const [membership] = await transaction
    .select({ epoch: memberships.authorizationEpoch })
    .from(memberships)
    .where(
      and(
        eq(memberships.organizationId, identity.organizationId),
        eq(memberships.userId, identity.userId)
      )
    )
    .limit(1);
  if (!membership) {
    throw new OfflineLeaseRejectedError("wrong_principal");
  }
  return membership.epoch;
}

export interface IssueOfflineLeaseInput {
  deviceId: string;
  /** The end of the entitlement; defaults to the end of the organization's Pro access. */
  entitlementEndsAt?: Date | null;
  now?: Date;
  requestId?: string | null;
}

/**
 * Records the grant of a new lease and returns its claims, ready to be signed
 * by the caller inside the same transaction (a signing failure rolls the grant
 * back). The window is 72 hours capped by the entitlement, the epoch is the
 * membership's current one, and the capabilities are the role's, snapshotted.
 * The epoch lock makes a concurrent password reset either revoke this grant or
 * be seen by it.
 */
export async function issueOfflineLeaseGrant(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: IssueOfflineLeaseInput
): Promise<{ claims: OfflineLeaseClaims; grant: OfflineGrantRecord }> {
  // offline writes are a Pro capability: Free gets no lease, and the lease never
  // outlives the access that pays for it
  const entitlements = await getEffectiveEntitlements(transaction, identity);
  assertFlag(entitlements, "offline.write");
  const window = planOfflineLeaseWindow({
    entitlementEndsAt: input.entitlementEndsAt ?? entitlements.accessEndsAt,
    now: input.now ?? new Date(),
  });
  await lockAuthorizationEpoch(transaction, identity.userId);
  const epoch = await currentEpoch(transaction, identity);
  const grant = await recordOfflineGrant(transaction, identity, {
    authorizationEpoch: epoch,
    deviceId: input.deviceId,
    expiresAt: window.expiresAt,
    issuedAt: window.issuedAt,
    requestId: input.requestId ?? null,
  });
  const claims = buildOfflineLeaseClaims({
    capabilities: capabilitiesForRole(identity.role),
    deviceId: grant.deviceId,
    epoch,
    expiresAt: grant.expiresAt,
    grantId: grant.id,
    issuedAt: grant.issuedAt,
    organizationId: grant.organizationId,
    userId: grant.userId,
  });
  return { claims, grant };
}

/**
 * The server-side half of lease validation, run when a device syncs. The
 * signature and expiry of the token were already checked; this confirms that
 * the lease still means what it said: the same principal as the session, a
 * grant that exists and is live, a live device, the same authorization epoch
 * and capabilities the role still has. The tenant transaction has already
 * confirmed the active membership and organization.
 */
export async function validateOfflineLeaseClaims(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  claims: OfflineLeaseClaims,
  now: Date = new Date(),
  options: { allowExpired?: boolean } = {}
): Promise<OfflineGrantRecord> {
  if (
    claims.sub !== identity.userId ||
    claims.org !== identity.organizationId
  ) {
    throw new OfflineLeaseRejectedError("wrong_principal");
  }
  const [grant] = await transaction
    .select({
      authorizationEpoch: offlineGrants.authorizationEpoch,
      deviceId: offlineGrants.deviceId,
      expiresAt: offlineGrants.expiresAt,
      id: offlineGrants.id,
      issuedAt: offlineGrants.issuedAt,
      organizationId: offlineGrants.organizationId,
      revokedAt: offlineGrants.revokedAt,
      revokedReason: offlineGrants.revokedReason,
      userId: offlineGrants.userId,
    })
    .from(offlineGrants)
    .where(
      and(
        eq(offlineGrants.id, claims.jti),
        eq(offlineGrants.organizationId, identity.organizationId),
        eq(offlineGrants.userId, identity.userId),
        eq(offlineGrants.deviceId, claims.dev)
      )
    )
    .limit(1);
  if (!grant) {
    throw new OfflineLeaseRejectedError("grant_not_found");
  }
  if (grant.revokedAt !== null) {
    throw new OfflineLeaseRejectedError("grant_revoked");
  }
  // A command made while the lease was valid may sync after it expired; the
  // caller then checks the command's own creation time against the lease window.
  if (!options.allowExpired && grant.expiresAt.getTime() <= now.getTime()) {
    throw new OfflineLeaseRejectedError("grant_expired");
  }
  // locks the live device for the rest of the command and links the session,
  // so a concurrent revocation either waits and ends this session or wins and
  // this command is refused
  if (
    !(await lockLiveDeviceForSession(
      transaction,
      identity.userId,
      grant.deviceId,
      identity.sessionId
    ))
  ) {
    throw new OfflineLeaseRejectedError("device_revoked");
  }
  const epoch = await currentEpoch(transaction, identity);
  if (epoch !== claims.epoch || epoch !== grant.authorizationEpoch) {
    throw new OfflineLeaseRejectedError("epoch_mismatch");
  }
  const allowed = new Set<string>(capabilitiesForRole(identity.role));
  if (!claims.caps.every((capability) => allowed.has(capability))) {
    throw new OfflineLeaseRejectedError("capability_revoked");
  }
  return grant;
}
