import type { OfflineLeaseClaims } from "@polaris/domain/offline/offline-lease";
import { OFFLINE_LEASE_CLOCK_SKEW_MS } from "@polaris/domain/offline/offline-lease";
import { and, eq, sql } from "drizzle-orm";
import {
  OfflineLeaseRejectedError,
  validateOfflineLeaseClaims,
} from "./offline-lease-repository";
import { syncCommands } from "./schema/sync-command";
import type {
  TenantRequestIdentity,
  TenantRequestTransaction,
} from "./tenant-transaction";

/**
 * The server side of one `sync.push` command (plan PR53). It is the idempotency
 * and authorization frame around a domain command: the same command ID returns
 * the same outcome, the lease is revalidated against live state, and the domain
 * work runs in a savepoint so a refusal leaves no trace except the recorded
 * outcome.
 */
export type SyncJson =
  | boolean
  | number
  | string
  | null
  | SyncJson[]
  | { [key: string]: SyncJson };

export type SyncCommandStatus = "accepted" | "rejected";

export interface SyncCommandOutcome {
  code: string | null;
  replayed: boolean;
  result: SyncJson | null;
  status: SyncCommandStatus;
}

export interface RunSyncCommandInput {
  commandId: string;
  commandType: string;
  /** The device's own clock when it queued the command. */
  createdAt: Date;
  deviceId: string;
  /**
   * Rechecks the organization's entitlement (billing). It runs after the lease
   * checks; `false` refuses the command with `entitlement_changed`. Omitted until
   * billing exists.
   */
  isEntitled?: () => Promise<boolean>;
  /** The verified lease claims, or null with `precheckFailure` set. */
  leaseClaims: OfflineLeaseClaims | null;
  now?: Date;
  payloadHash: string;
  /** A deterministic reason to refuse before running anything (bad lease, bad payload). */
  precheckFailure?: string | null;
}

/** Stable codes the client turns into clear messages (plan PR58). */
export const SYNC_REJECTION = {
  authorizationRevoked: "authorization_revoked",
  commandIdReused: "command_id_reused",
  entitlementChanged: "entitlement_changed",
  invalidCreationTime: "invalid_creation_time",
  wrongDevice: "wrong_device",
} as const;

async function lockCommand(
  transaction: TenantRequestTransaction,
  organizationId: string,
  commandId: string
): Promise<void> {
  const key = `sync-command:${organizationId}:${commandId}`;
  await transaction.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`
  );
}

async function record(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: RunSyncCommandInput,
  outcome: Omit<SyncCommandOutcome, "replayed">
): Promise<SyncCommandOutcome> {
  await transaction.insert(syncCommands).values({
    commandId: input.commandId,
    commandType: input.commandType,
    deviceId: input.deviceId,
    leaseGrantId: input.leaseClaims?.jti ?? null,
    organizationId: identity.organizationId,
    outcomeCode: outcome.code,
    outcomeResult: outcome.result,
    outcomeStatus: outcome.status,
    payloadHash: input.payloadHash,
    userId: identity.userId,
  });
  return { ...outcome, replayed: false };
}

const rejected = (code: string): Omit<SyncCommandOutcome, "replayed"> => ({
  code,
  result: null,
  status: "rejected",
});

/** The creation time must sit inside the lease window (device clock, with skew). */
function creationTimeInsideLease(
  input: RunSyncCommandInput,
  claims: OfflineLeaseClaims,
  now: Date
): boolean {
  const created = input.createdAt.getTime();
  return (
    created >= claims.iat * 1000 - OFFLINE_LEASE_CLOCK_SKEW_MS &&
    created <= claims.exp * 1000 + OFFLINE_LEASE_CLOCK_SKEW_MS &&
    created <= now.getTime() + OFFLINE_LEASE_CLOCK_SKEW_MS
  );
}

/**
 * Runs one command inside an authorized tenant transaction.
 *
 * - A command ID seen before replays its stored outcome (`replayed: true`); the
 *   same ID with a different type or payload is refused with `command_id_reused`
 *   and stores nothing, so the first outcome stands.
 * - Otherwise the lease is revalidated (principal, grant, device, epoch,
 *   capabilities) and the creation time must fall inside the lease window; an
 *   expired lease is fine for a command made while it was valid.
 * - `execute` runs in a savepoint. An error `classify` turns into a code becomes
 *   a stored rejection (and the savepoint's writes vanish); any other error
 *   propagates and the whole transaction, including the outcome, rolls back so
 *   the device can retry.
 */
export async function runSyncCommand(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: RunSyncCommandInput,
  execute: (transaction: TenantRequestTransaction) => Promise<SyncJson>,
  classify: (error: unknown) => string | null
): Promise<SyncCommandOutcome> {
  const now = input.now ?? new Date();
  await lockCommand(transaction, identity.organizationId, input.commandId);

  const [existing] = await transaction
    .select({
      commandType: syncCommands.commandType,
      outcomeCode: syncCommands.outcomeCode,
      outcomeResult: syncCommands.outcomeResult,
      outcomeStatus: syncCommands.outcomeStatus,
      payloadHash: syncCommands.payloadHash,
    })
    .from(syncCommands)
    .where(
      and(
        eq(syncCommands.organizationId, identity.organizationId),
        eq(syncCommands.commandId, input.commandId)
      )
    )
    .limit(1);
  if (existing) {
    if (
      existing.payloadHash !== input.payloadHash ||
      existing.commandType !== input.commandType
    ) {
      return {
        code: SYNC_REJECTION.commandIdReused,
        replayed: false,
        result: null,
        status: "rejected",
      };
    }
    return {
      code: existing.outcomeCode,
      replayed: true,
      result: existing.outcomeResult as SyncJson | null,
      status: existing.outcomeStatus as SyncCommandStatus,
    };
  }

  if (input.precheckFailure || !input.leaseClaims) {
    return await record(
      transaction,
      identity,
      input,
      rejected(input.precheckFailure ?? SYNC_REJECTION.authorizationRevoked)
    );
  }
  const claims = input.leaseClaims;
  if (claims.dev !== input.deviceId) {
    return await record(
      transaction,
      identity,
      input,
      rejected(SYNC_REJECTION.wrongDevice)
    );
  }
  try {
    await validateOfflineLeaseClaims(transaction, identity, claims, now, {
      allowExpired: true,
    });
  } catch (error) {
    if (error instanceof OfflineLeaseRejectedError) {
      return await record(
        transaction,
        identity,
        input,
        rejected(SYNC_REJECTION.authorizationRevoked)
      );
    }
    throw error;
  }
  if (!creationTimeInsideLease(input, claims, now)) {
    return await record(
      transaction,
      identity,
      input,
      rejected(SYNC_REJECTION.invalidCreationTime)
    );
  }

  if (input.isEntitled && !(await input.isEntitled())) {
    return await record(
      transaction,
      identity,
      input,
      rejected(SYNC_REJECTION.entitlementChanged)
    );
  }

  let result: SyncJson;
  try {
    result = await transaction.transaction((savepoint) => execute(savepoint));
  } catch (error) {
    const code = classify(error);
    if (code === null) {
      throw error;
    }
    return await record(transaction, identity, input, rejected(code));
  }
  return await record(transaction, identity, input, {
    code: null,
    result,
    status: "accepted",
  });
}
