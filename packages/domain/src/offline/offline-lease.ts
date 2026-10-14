import { OFFLINE_GRANT_MAX_LIFETIME_MS } from "./offline-grant";

/**
 * The offline authorization lease (plan PR49): a short-lived, signed statement
 * that a user on a device may work in an organization without reaching the
 * server. The server issues it only after validating the session, the
 * membership and the organization, and it remains advisory: every command is
 * revalidated at sync time, so a lease never grants anything by itself.
 *
 * This module holds the claims and their rules. Signing and the token format
 * belong to the infrastructure (`apps/web/src/lib/offline-lease-token.ts`).
 */
export const OFFLINE_LEASE_VERSION = 1;
/** Tolerated device clock drift when the issued-at claim is read back. */
export const OFFLINE_LEASE_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_CAPABILITIES = 64;
const MAX_CAPABILITY_LENGTH = 64;

export interface OfflineLeaseClaims {
  /** Capability snapshot the lease was issued with. */
  caps: readonly string[];
  /** The device that holds the lease. */
  dev: string;
  /** Authorization epoch of the membership at issue time. */
  epoch: number;
  /** Expiry, in seconds since the Unix epoch. */
  exp: number;
  /** Issued-at, in seconds since the Unix epoch. */
  iat: number;
  /** The offline grant the server recorded for this lease. */
  jti: string;
  /** The organization. */
  org: string;
  /** The user. */
  sub: string;
  v: typeof OFFLINE_LEASE_VERSION;
}

export type InvalidOfflineLeaseReason =
  | "bad_signature"
  | "expired"
  | "malformed"
  | "not_yet_valid"
  | "unknown_key"
  | "unsupported_version";

export class InvalidOfflineLeaseError extends Error {
  readonly reason: InvalidOfflineLeaseReason;

  constructor(reason: InvalidOfflineLeaseReason, options?: ErrorOptions) {
    super(`invalid_offline_lease:${reason}`, options);
    this.name = "InvalidOfflineLeaseError";
    this.reason = reason;
  }
}

export class OfflineLeaseNotAvailableError extends Error {
  constructor() {
    super("offline_lease_not_available");
    this.name = "OfflineLeaseNotAvailableError";
  }
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isSeconds(candidate: unknown): candidate is number {
  return (
    typeof candidate === "number" &&
    Number.isSafeInteger(candidate) &&
    candidate > 0
  );
}

function isNonEmptyId(candidate: unknown): candidate is string {
  return (
    typeof candidate === "string" &&
    candidate.length > 0 &&
    candidate.length <= 255
  );
}

export function isOfflineLeaseClaims(
  value: unknown
): value is OfflineLeaseClaims {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const { caps, dev, epoch, exp, iat, jti, org, sub, v } = value as Record<
    string,
    unknown
  >;
  return (
    v === OFFLINE_LEASE_VERSION &&
    typeof jti === "string" &&
    uuidPattern.test(jti) &&
    typeof dev === "string" &&
    uuidPattern.test(dev) &&
    isNonEmptyId(sub) &&
    isNonEmptyId(org) &&
    typeof epoch === "number" &&
    Number.isSafeInteger(epoch) &&
    epoch >= 0 &&
    isSeconds(iat) &&
    isSeconds(exp) &&
    exp > iat &&
    (exp - iat) * 1000 <= OFFLINE_GRANT_MAX_LIFETIME_MS &&
    Array.isArray(caps) &&
    caps.length <= MAX_CAPABILITIES &&
    caps.every(
      (capability) =>
        typeof capability === "string" &&
        capability.length > 0 &&
        capability.length <= MAX_CAPABILITY_LENGTH
    )
  );
}

/** Deterministic JSON (fixed key order): these are the signed bytes. */
export function serializeOfflineLeaseClaims(
  claims: OfflineLeaseClaims
): string {
  if (!isOfflineLeaseClaims(claims)) {
    throw new InvalidOfflineLeaseError("malformed");
  }
  return JSON.stringify({
    caps: [...claims.caps],
    dev: claims.dev,
    epoch: claims.epoch,
    exp: claims.exp,
    iat: claims.iat,
    jti: claims.jti,
    org: claims.org,
    sub: claims.sub,
    v: claims.v,
  });
}

export function parseOfflineLeaseClaims(json: string): OfflineLeaseClaims {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new InvalidOfflineLeaseError("malformed", { cause: error });
  }
  if (!isOfflineLeaseClaims(parsed)) {
    throw new InvalidOfflineLeaseError("malformed");
  }
  return parsed;
}

/** The validity window of already-authentic claims, against the server clock. */
export function assertOfflineLeaseCurrent(
  claims: OfflineLeaseClaims,
  now: Date
): void {
  if (now.getTime() >= claims.exp * 1000) {
    throw new InvalidOfflineLeaseError("expired");
  }
  if (claims.iat * 1000 > now.getTime() + OFFLINE_LEASE_CLOCK_SKEW_MS) {
    throw new InvalidOfflineLeaseError("not_yet_valid");
  }
}

/**
 * The lease window: 72 hours from now, capped by the end of the entitlement
 * (for example a trial), and never in the past. Instants are whole seconds,
 * as in the token.
 */
export function planOfflineLeaseWindow(input: {
  entitlementEndsAt?: Date | null;
  now: Date;
}): { expiresAt: Date; issuedAt: Date } {
  const issuedAt = new Date(Math.floor(input.now.getTime() / 1000) * 1000);
  let expiresMs = issuedAt.getTime() + OFFLINE_GRANT_MAX_LIFETIME_MS;
  if (input.entitlementEndsAt) {
    expiresMs = Math.min(
      expiresMs,
      Math.floor(input.entitlementEndsAt.getTime() / 1000) * 1000
    );
  }
  if (!Number.isFinite(expiresMs) || expiresMs <= issuedAt.getTime()) {
    throw new OfflineLeaseNotAvailableError();
  }
  return { expiresAt: new Date(expiresMs), issuedAt };
}

export function buildOfflineLeaseClaims(input: {
  capabilities: readonly string[];
  deviceId: string;
  epoch: number;
  expiresAt: Date;
  grantId: string;
  issuedAt: Date;
  organizationId: string;
  userId: string;
}): OfflineLeaseClaims {
  const claims: OfflineLeaseClaims = {
    caps: [...new Set(input.capabilities)].sort(),
    dev: input.deviceId,
    epoch: input.epoch,
    exp: Math.floor(input.expiresAt.getTime() / 1000),
    iat: Math.floor(input.issuedAt.getTime() / 1000),
    jti: input.grantId,
    org: input.organizationId,
    sub: input.userId,
    v: OFFLINE_LEASE_VERSION,
  };
  if (!isOfflineLeaseClaims(claims)) {
    throw new InvalidOfflineLeaseError("malformed");
  }
  return claims;
}
