import {
  assertOfflineGrantRevokeReason,
  assertOfflineGrantWindow,
  MAX_ACTIVE_DEVICES_PER_USER,
  normalizeDeviceLabel,
  type OfflineGrantRevokeReason,
} from "@polaris/domain/offline/offline-grant";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { createDatabase } from "./client";
import { deviceSessions, devices, offlineGrants } from "./schema/device";
import { memberships } from "./schema/organization";
import { recordTenantAuditEvent } from "./tenant-audit";
import type {
  TenantRequestIdentity,
  TenantRequestTransaction,
} from "./tenant-transaction";
import { scopeToOrganization, withUserTransaction } from "./user-transaction";

type Database = ReturnType<typeof createDatabase>["db"];

export class DeviceNotFoundError extends Error {
  constructor() {
    super("device_not_found");
    this.name = "DeviceNotFoundError";
  }
}

export class DeviceRevokedError extends Error {
  constructor() {
    super("device_revoked");
    this.name = "DeviceRevokedError";
  }
}

export class DeviceLimitError extends Error {
  constructor() {
    super("device_limit_reached");
    this.name = "DeviceLimitError";
  }
}

/** The session was ended while it used a device (a concurrent revocation or logout). */
export class DeviceSessionEndedError extends Error {
  constructor(options?: ErrorOptions) {
    super("device_session_ended", options);
    this.name = "DeviceSessionEndedError";
  }
}

/**
 * `device.revokeCurrent` names a device this session does not own (it did not
 * register it, nor confirm it first while it was recent): nothing is revoked.
 */
export class DeviceNotOwnedError extends Error {
  readonly code = "not_current_device";

  constructor() {
    super("not_current_device");
    this.name = "DeviceNotOwnedError";
  }
}

/**
 * Revoking another device (or ending the other sessions) needs a session that
 * signed in recently; the user must sign in again.
 */
export class FreshSessionRequiredError extends Error {
  readonly code = "fresh_session_required";

  constructor(options?: ErrorOptions) {
    super("fresh_session_required", options);
    this.name = "FreshSessionRequiredError";
  }
}

export class OfflineGrantNotFoundError extends Error {
  constructor() {
    super("offline_grant_not_found");
    this.name = "OfflineGrantNotFoundError";
  }
}

export interface DeviceRecord {
  createdAt: Date;
  id: string;
  label: string | null;
  lastSeenAt: Date;
  revokedAt: Date | null;
  userId: string;
}

export interface OfflineGrantRecord {
  authorizationEpoch: number;
  deviceId: string;
  expiresAt: Date;
  id: string;
  issuedAt: Date;
  organizationId: string;
  revokedAt: Date | null;
  revokedReason: string | null;
  userId: string;
}

const deviceColumns = {
  createdAt: devices.createdAt,
  id: devices.id,
  label: devices.label,
  lastSeenAt: devices.lastSeenAt,
  revokedAt: devices.revokedAt,
  userId: devices.userId,
};

const grantColumns = {
  authorizationEpoch: offlineGrants.authorizationEpoch,
  deviceId: offlineGrants.deviceId,
  expiresAt: offlineGrants.expiresAt,
  id: offlineGrants.id,
  issuedAt: offlineGrants.issuedAt,
  organizationId: offlineGrants.organizationId,
  revokedAt: offlineGrants.revokedAt,
  revokedReason: offlineGrants.revokedReason,
  userId: offlineGrants.userId,
};

/* -------------------------------------------------------------------------- */
/* Device and session link                                                    */
/* -------------------------------------------------------------------------- */

const SESSION_FOREIGN_KEY = "device_sessions_session_id_session_id_fk";

function isEndedSessionError(error: unknown): boolean {
  const visited = new Set<object>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null) {
    if (visited.has(current)) {
      return false;
    }
    visited.add(current);
    const candidate = current as {
      cause?: unknown;
      code?: unknown;
      constraint?: unknown;
    };
    if (
      candidate.code === "23503" &&
      candidate.constraint === SESSION_FOREIGN_KEY
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

/**
 * The one way a session uses a device (register, lease, sync, check): in a
 * single statement, locks the device FOR SHARE only if it is a live device of
 * the user and links the session to it. A revocation updates the device row,
 * so it either waits for this transaction and then sees the link, or commits
 * first and this finds no live device and links nothing. Returns whether the
 * device is live. Without a session (scripts and gates) it only locks.
 * `register` marks the device as the session's own (`registerDevice` passes
 * it): a session that merely used a device never owns it, so it cannot skip
 * the fresh-session rule by checking another device first. `first_check` is the
 * `device.check` of a session signed in within the fresh window: the device
 * becomes its own only while the session owns no device yet, so one recent
 * session owns at most the first device it checks (ADR 0048, emenda de 22/10);
 * every later check, like an older session's, is a plain `use`. A link that
 * already exists is never promoted.
 */
export async function lockLiveDeviceForSession(
  transaction: TenantRequestTransaction,
  authenticatedUserId: string,
  deviceId: string,
  sessionId: string | undefined,
  origin: "first_check" | "register" | "use" = "use"
): Promise<boolean> {
  const promote = origin === "first_check";
  try {
    const result = await transaction.execute<{ live: number }>(sql`
      WITH live AS (
        SELECT device.user_id, device.id
          FROM public.devices AS device
         WHERE device.id = ${deviceId}::uuid
           AND device.user_id = ${authenticatedUserId}
           AND device.revoked_at IS NULL
           FOR SHARE
      ), linked AS (
        INSERT INTO public.device_sessions (user_id, device_id, session_id, origin)
        SELECT live.user_id, live.id, ${sessionId ?? null}::text,
               CASE
                 WHEN ${promote}::boolean AND NOT EXISTS (
                   SELECT 1 FROM public.device_sessions AS own
                    WHERE own.session_id = ${sessionId ?? null}::text
                      AND own.user_id = live.user_id
                      AND own.origin = 'register'
                 ) THEN 'register'
                 ELSE ${promote ? "use" : origin}::text
               END
          FROM live
         WHERE ${sessionId ?? null}::text IS NOT NULL
        ON CONFLICT DO NOTHING
        RETURNING 1
      )
      SELECT count(*)::int AS live FROM live`);
    return (result.rows[0]?.live ?? 0) > 0;
  } catch (error) {
    if (isEndedSessionError(error)) {
      // biome-ignore lint/style/useErrorCause: DeviceSessionEndedError forwards this cause to Error.
      throw new DeviceSessionEndedError({ cause: error });
    }
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* Devices (user scope)                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Registers a browser installation for the session user and links the session
 * to it. The id is generated by the database; the only descriptive input is an
 * optional short label. A user can keep at most MAX_ACTIVE_DEVICES_PER_USER
 * live devices.
 */
export async function registerDevice(
  database: Database,
  authenticatedUserId: string,
  input: { label?: string | null; sessionId?: string } = {}
): Promise<DeviceRecord> {
  const label = normalizeDeviceLabel(input.label);
  return await withUserTransaction(
    database,
    authenticatedUserId,
    async (tx) => {
      // Serializes concurrent registrations of the same user so the cap holds.
      const lockKey = `device:${authenticatedUserId}`;
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`
      );
      const [counted] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(devices)
        .where(
          and(
            eq(devices.userId, authenticatedUserId),
            isNull(devices.revokedAt)
          )
        );
      if ((counted?.count ?? 0) >= MAX_ACTIVE_DEVICES_PER_USER) {
        throw new DeviceLimitError();
      }
      const [created] = await tx
        .insert(devices)
        .values({ label, userId: authenticatedUserId })
        .returning(deviceColumns);
      if (!created) {
        throw new Error("device_insert_failed");
      }
      await lockLiveDeviceForSession(
        tx,
        authenticatedUserId,
        created.id,
        input.sessionId,
        "register"
      );
      return created;
    }
  );
}

export function listDevices(
  database: Database,
  authenticatedUserId: string,
  options: { includeRevoked?: boolean } = {}
): Promise<DeviceRecord[]> {
  return withUserTransaction(database, authenticatedUserId, (tx) =>
    tx
      .select(deviceColumns)
      .from(devices)
      .where(
        options.includeRevoked
          ? eq(devices.userId, authenticatedUserId)
          : and(
              eq(devices.userId, authenticatedUserId),
              isNull(devices.revokedAt)
            )
      )
      .orderBy(desc(devices.createdAt), asc(devices.id))
  );
}

async function missingDeviceError(
  tx: TenantRequestTransaction,
  authenticatedUserId: string,
  deviceId: string
): Promise<DeviceNotFoundError | DeviceRevokedError> {
  const [existing] = await tx
    .select({ id: devices.id })
    .from(devices)
    .where(
      and(eq(devices.id, deviceId), eq(devices.userId, authenticatedUserId))
    )
    .limit(1);
  return existing ? new DeviceRevokedError() : new DeviceNotFoundError();
}

/**
 * Records that the device was seen and links the session to it (`device.check`,
 * which the offline runtime calls at every online start). A revoked or unknown
 * device is refused and links nothing.
 */
export function touchDevice(
  database: Database,
  authenticatedUserId: string,
  deviceId: string,
  options: {
    /** The session signed in within the fresh window: its first device becomes its own. */
    freshSession?: boolean;
    now?: Date;
    sessionId?: string;
  } = {}
): Promise<DeviceRecord> {
  const now = options.now ?? new Date();
  const promote = options.freshSession === true && Boolean(options.sessionId);
  return withUserTransaction(database, authenticatedUserId, async (tx) => {
    // the UPDATE first: it locks the row for the rest of the transaction, so two
    // concurrent checks of one device queue up instead of deadlocking (each
    // holding FOR SHARE and waiting to update), and a revocation waits for it
    const [touched] = await tx
      .update(devices)
      .set({ lastSeenAt: now })
      .where(
        and(
          eq(devices.id, deviceId),
          eq(devices.userId, authenticatedUserId),
          isNull(devices.revokedAt)
        )
      )
      .returning(deviceColumns);
    if (touched && promote) {
      // two checks of one recent session on two devices queue here, so only one of them sees no own device yet
      const lockKey = `device-session:${options.sessionId}`;
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`
      );
    }
    if (
      !(
        touched &&
        (await lockLiveDeviceForSession(
          tx,
          authenticatedUserId,
          deviceId,
          options.sessionId,
          promote ? "first_check" : "use"
        ))
      )
    ) {
      throw await missingDeviceError(tx, authenticatedUserId, deviceId);
    }
    return touched;
  });
}

export interface RevokeDeviceOptions {
  /**
   * The verified session that revokes, and whether it signed in recently. Null
   * only in scripts and gates, which have no session: a request handler always
   * passes it, since null skips the fresh-session rule.
   */
  actingSession: { fresh: boolean; id: string } | null;
  /** Also end every other session of the user but the acting one. */
  endOtherSessions?: boolean;
  now?: Date;
  requestId?: string | null;
}

export interface RevokeDeviceResult {
  device: DeviceRecord;
  /** Whether the acting session was one of the ended ones (this browser signs out). */
  endedCurrentSession: boolean;
  endedSessionCount: number;
  revokedGrantIds: string[];
}

/** The SQLSTATEs end_device_sessions() raises for a lost or a stale acting session. */
const ACTING_SESSION_ENDED = "PD001";
const ACTING_SESSION_NOT_FRESH = "PD002";

function sqlStateOf(error: unknown): string | undefined {
  const visited = new Set<object>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null) {
    if (visited.has(current)) {
      return;
    }
    visited.add(current);
    const candidate = current as { cause?: unknown; code?: unknown };
    if (typeof candidate.code === "string" && candidate.code.length === 5) {
      return candidate.code;
    }
    current = candidate.cause;
  }
}

async function endDeviceSessions(
  tx: TenantRequestTransaction,
  deviceId: string,
  options: RevokeDeviceOptions,
  newlyRevoked: boolean
): Promise<{ endedCurrentSession: boolean; endedSessionCount: number }> {
  let result: Awaited<ReturnType<typeof runEndDeviceSessions>>;
  try {
    result = await runEndDeviceSessions(tx, deviceId, options, newlyRevoked);
  } catch (error) {
    const state = sqlStateOf(error);
    if (state === ACTING_SESSION_ENDED) {
      // biome-ignore lint/style/useErrorCause: DeviceSessionEndedError forwards this cause to Error.
      throw new DeviceSessionEndedError({ cause: error });
    }
    if (state === ACTING_SESSION_NOT_FRESH) {
      // biome-ignore lint/style/useErrorCause: FreshSessionRequiredError forwards this cause to Error.
      throw new FreshSessionRequiredError({ cause: error });
    }
    throw error;
  }
  const [row] = result.rows;
  return {
    endedCurrentSession: row?.ended_current_session === true,
    endedSessionCount: Number(row?.ended_session_count ?? 0),
  };
}

function runEndDeviceSessions(
  tx: TenantRequestTransaction,
  deviceId: string,
  options: RevokeDeviceOptions,
  newlyRevoked: boolean
) {
  return tx.execute<{
    ended_current_session: boolean;
    ended_session_count: number;
  }>(
    sql`SELECT ended_session_count, ended_current_session
          FROM public.end_device_sessions(
            ${deviceId}::uuid,
            ${options.actingSession?.id ?? null}::text,
            ${options.endOtherSessions === true}::boolean,
            ${newlyRevoked}::boolean,
            ${options.requestId ?? null}::text
          )`
  );
}

/**
 * Revokes a device and, in the same transaction, every live offline grant that
 * device holds in any of the user's organizations and every session linked to
 * the device (optionally every other session of the user as well). Revoking
 * another device than the acting session's, or ending the other sessions,
 * needs a fresh session. The revocation that takes the device from live to
 * revoked is always audited (`device_revoked`, with the acting session and
 * device), even with no session linked. Revocation is terminal and idempotent:
 * revoking a revoked device returns it unchanged, ends again any session still
 * linked to it and is audited only when it ends one.
 */
export function revokeDevice(
  database: Database,
  authenticatedUserId: string,
  deviceId: string,
  options: RevokeDeviceOptions
): Promise<RevokeDeviceResult> {
  return withUserTransaction(database, authenticatedUserId, async (tx) => {
    const { actingSession } = options;
    if (
      actingSession &&
      !actingSession.fresh &&
      (options.endOtherSessions === true ||
        !(await ownsDevice(
          tx,
          authenticatedUserId,
          deviceId,
          actingSession.id
        )))
    ) {
      throw new FreshSessionRequiredError();
    }
    return await revokeInTransaction(
      tx,
      authenticatedUserId,
      deviceId,
      options
    );
  });
}

export interface RevokeOwnDeviceResult {
  /** The device was revoked already (from another device): nothing new was revoked. */
  alreadyRevoked: boolean;
  endedCurrentSession: boolean;
  revokedGrantCount: number;
}

/**
 * "Sair" revokes this installation (`device.revokeCurrent`, ADR 0048, emenda de
 * 22/10): the same revocation as `revokeDevice`, but only of the device the
 * acting session owns (it registered it, or confirmed it first while recent)
 * and never ending the other sessions, so it needs no fresh session. A device
 * of another user, or none, is DeviceNotFoundError; a device of the user this
 * session does not own is DeviceNotOwnedError, even for a recent session, and
 * nothing changes.
 */
export function revokeOwnDevice(
  database: Database,
  authenticatedUserId: string,
  deviceId: string,
  options: { actingSessionId: string; now?: Date; requestId?: string | null }
): Promise<RevokeOwnDeviceResult> {
  return withUserTransaction(database, authenticatedUserId, async (tx) => {
    const [existing] = await tx
      .select({ id: devices.id, revokedAt: devices.revokedAt })
      .from(devices)
      .where(
        and(eq(devices.id, deviceId), eq(devices.userId, authenticatedUserId))
      )
      .limit(1);
    if (!existing) {
      throw new DeviceNotFoundError();
    }
    if (
      !(await ownsDevice(
        tx,
        authenticatedUserId,
        deviceId,
        options.actingSessionId
      ))
    ) {
      throw new DeviceNotOwnedError();
    }
    const result = await revokeInTransaction(
      tx,
      authenticatedUserId,
      deviceId,
      {
        actingSession: { fresh: false, id: options.actingSessionId },
        endOtherSessions: false,
        ...(options.now ? { now: options.now } : {}),
        requestId: options.requestId ?? null,
      }
    );
    return {
      alreadyRevoked: existing.revokedAt !== null,
      endedCurrentSession: result.endedCurrentSession,
      revokedGrantCount: result.revokedGrantIds.length,
    };
  });
}

/** Whether the session owns the device: it registered it, or confirmed it first while recent. */
async function ownsDevice(
  tx: TenantRequestTransaction,
  authenticatedUserId: string,
  deviceId: string,
  sessionId: string
): Promise<boolean> {
  const [own] = await tx
    .select({ deviceId: deviceSessions.deviceId })
    .from(deviceSessions)
    .where(
      and(
        eq(deviceSessions.deviceId, deviceId),
        eq(deviceSessions.sessionId, sessionId),
        eq(deviceSessions.userId, authenticatedUserId),
        eq(deviceSessions.origin, "register")
      )
    )
    .limit(1);
  return own !== undefined;
}

/** The revocation itself, once the caller decided the acting session may do it. */
async function revokeInTransaction(
  tx: TenantRequestTransaction,
  authenticatedUserId: string,
  deviceId: string,
  options: RevokeDeviceOptions
): Promise<RevokeDeviceResult> {
  const now = options.now ?? new Date();
  const [revoked] = await tx
    .update(devices)
    .set({ revokedAt: now })
    .where(
      and(
        eq(devices.id, deviceId),
        eq(devices.userId, authenticatedUserId),
        isNull(devices.revokedAt)
      )
    )
    .returning(deviceColumns);
  if (!revoked) {
    const [existing] = await tx
      .select(deviceColumns)
      .from(devices)
      .where(
        and(eq(devices.id, deviceId), eq(devices.userId, authenticatedUserId))
      )
      .limit(1);
    if (!existing) {
      throw new DeviceNotFoundError();
    }
    return {
      device: existing,
      revokedGrantIds: [] as string[],
      ...(await endDeviceSessions(tx, deviceId, options, false)),
    };
  }

  // Grants are only visible under their organization's scope, so each of the
  // user's organizations is scoped and revoked in turn on this connection.
  const userOrganizations = await tx
    .select({ organizationId: memberships.organizationId })
    .from(memberships)
    .where(eq(memberships.userId, authenticatedUserId))
    .orderBy(asc(memberships.organizationId));
  const revokedGrantIds: string[] = [];
  for (const { organizationId } of userOrganizations) {
    // biome-ignore lint/performance/noAwaitInLoops: one scope per organization on a single connection.
    await scopeToOrganization(tx, organizationId);
    const rows = await tx
      .update(offlineGrants)
      .set({ revokedAt: now, revokedReason: "device_revoked" })
      .where(
        and(
          eq(offlineGrants.userId, authenticatedUserId),
          eq(offlineGrants.deviceId, deviceId),
          isNull(offlineGrants.revokedAt)
        )
      )
      .returning({ id: offlineGrants.id });
    for (const row of rows) {
      // biome-ignore lint/performance/noAwaitInLoops: audit rows are appended in order.
      await recordTenantAuditEvent(
        tx,
        { organizationId, userId: authenticatedUserId },
        {
          entityId: row.id,
          entityType: "offline_grant",
          eventType: "offline_grant.revoked",
          requestId: options.requestId ?? null,
        }
      );
      revokedGrantIds.push(row.id);
    }
  }
  return {
    device: revoked,
    revokedGrantIds,
    ...(await endDeviceSessions(tx, deviceId, options, true)),
  };
}

/* -------------------------------------------------------------------------- */
/* Offline grants (organization scope)                                        */
/* -------------------------------------------------------------------------- */

export interface IssueOfflineGrantInput {
  authorizationEpoch: number;
  deviceId: string;
  expiresAt: Date;
  issuedAt: Date;
  requestId?: string | null;
}

/**
 * Records a grant for a live device of the session user in the current
 * organization. The window (at most 72 hours) is validated here and again by a
 * CHECK constraint; signing the lease the client keeps is PR49.
 */
export async function recordOfflineGrant(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: IssueOfflineGrantInput
): Promise<OfflineGrantRecord> {
  assertOfflineGrantWindow(input);
  if (
    !Number.isSafeInteger(input.authorizationEpoch) ||
    input.authorizationEpoch < 0
  ) {
    throw new RangeError("invalid_authorization_epoch");
  }
  if (
    !(await lockLiveDeviceForSession(
      transaction,
      identity.userId,
      input.deviceId,
      identity.sessionId
    ))
  ) {
    throw await missingDeviceError(
      transaction,
      identity.userId,
      input.deviceId
    );
  }
  const [created] = await transaction
    .insert(offlineGrants)
    .values({
      authorizationEpoch: input.authorizationEpoch,
      deviceId: input.deviceId,
      expiresAt: input.expiresAt,
      issuedAt: input.issuedAt,
      organizationId: identity.organizationId,
      userId: identity.userId,
    })
    .returning(grantColumns);
  if (!created) {
    throw new Error("offline_grant_insert_failed");
  }
  await recordTenantAuditEvent(transaction, identity, {
    entityId: created.id,
    entityType: "offline_grant",
    eventType: "offline_grant.issued",
    requestId: input.requestId ?? null,
  });
  return created;
}

export async function listOfflineGrants(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  options: { deviceId?: string; now?: Date; onlyActive?: boolean } = {}
): Promise<OfflineGrantRecord[]> {
  const now = options.now ?? new Date();
  return await transaction
    .select(grantColumns)
    .from(offlineGrants)
    .where(
      and(
        eq(offlineGrants.organizationId, identity.organizationId),
        eq(offlineGrants.userId, identity.userId),
        options.deviceId
          ? eq(offlineGrants.deviceId, options.deviceId)
          : undefined,
        options.onlyActive
          ? and(
              isNull(offlineGrants.revokedAt),
              sql`${offlineGrants.expiresAt} > ${now.toISOString()}::timestamptz`
            )
          : undefined
      )
    )
    .orderBy(desc(offlineGrants.issuedAt), asc(offlineGrants.id));
}

/** Revocation is terminal and idempotent; the first reason is kept. */
export async function revokeOfflineGrant(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: {
    grantId: string;
    now?: Date;
    reason: OfflineGrantRevokeReason;
    requestId?: string | null;
  }
): Promise<OfflineGrantRecord> {
  assertOfflineGrantRevokeReason(input.reason);
  const [revoked] = await transaction
    .update(offlineGrants)
    .set({
      revokedAt: input.now ?? new Date(),
      revokedReason: input.reason,
    })
    .where(
      and(
        eq(offlineGrants.id, input.grantId),
        eq(offlineGrants.organizationId, identity.organizationId),
        eq(offlineGrants.userId, identity.userId),
        isNull(offlineGrants.revokedAt)
      )
    )
    .returning(grantColumns);
  if (revoked) {
    await recordTenantAuditEvent(transaction, identity, {
      entityId: revoked.id,
      entityType: "offline_grant",
      eventType: "offline_grant.revoked",
      requestId: input.requestId ?? null,
    });
    return revoked;
  }
  const [existing] = await transaction
    .select(grantColumns)
    .from(offlineGrants)
    .where(
      and(
        eq(offlineGrants.id, input.grantId),
        eq(offlineGrants.organizationId, identity.organizationId),
        eq(offlineGrants.userId, identity.userId)
      )
    )
    .limit(1);
  if (!existing) {
    throw new OfflineGrantNotFoundError();
  }
  return existing;
}
