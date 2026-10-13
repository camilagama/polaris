/**
 * Devices and offline grants (plan PR48).
 *
 * A device is one browser installation of one user. It is not an authentication
 * factor and carries no fingerprint: only a random id, an optional label the
 * user typed, and timestamps. An offline grant is the server-side record of an
 * authorization lease issued to a device for one organization; the signed lease
 * itself arrives with PR49. A grant never lives longer than 72 hours.
 */
export const OFFLINE_GRANT_MAX_LIFETIME_MS = 72 * 60 * 60 * 1000;
export const MAX_DEVICE_LABEL_CODE_POINTS = 80;
export const MAX_ACTIVE_DEVICES_PER_USER = 20;

export const OFFLINE_GRANT_REVOKE_REASONS = Object.freeze([
  "device_revoked",
  "user_revoked",
  "security_event",
  "organization_suspended",
] as const);

export type OfflineGrantRevokeReason =
  (typeof OFFLINE_GRANT_REVOKE_REASONS)[number];

export class InvalidDeviceLabelError extends Error {
  constructor() {
    super("invalid_device_label");
    this.name = "InvalidDeviceLabelError";
  }
}

export class InvalidOfflineGrantWindowError extends Error {
  constructor() {
    super("invalid_offline_grant_window");
    this.name = "InvalidOfflineGrantWindowError";
  }
}

export class InvalidOfflineGrantRevokeReasonError extends Error {
  constructor() {
    super("invalid_offline_grant_revoke_reason");
    this.name = "InvalidOfflineGrantRevokeReasonError";
  }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/u;

/**
 * The label is the only descriptive field of a device. It is trimmed, may be
 * absent, and must be a short single line: a name the user recognises ("Balcão"),
 * never a user agent or hardware description.
 */
export function normalizeDeviceLabel(
  label: string | null | undefined
): string | null {
  if (label === null || label === undefined) {
    return null;
  }
  const trimmed = label.trim();
  if (trimmed === "") {
    return null;
  }
  if (
    [...trimmed].length > MAX_DEVICE_LABEL_CODE_POINTS ||
    controlCharacters.test(trimmed)
  ) {
    throw new InvalidDeviceLabelError();
  }
  return trimmed;
}

export function assertOfflineGrantRevokeReason(
  value: string
): asserts value is OfflineGrantRevokeReason {
  if (!OFFLINE_GRANT_REVOKE_REASONS.some((reason) => reason === value)) {
    throw new InvalidOfflineGrantRevokeReasonError();
  }
}

/**
 * A grant must expire after it was issued and at most 72 hours later. The
 * database enforces the same rule with a CHECK constraint.
 */
export function assertOfflineGrantWindow(input: {
  expiresAt: Date;
  issuedAt: Date;
}): void {
  const issued = input.issuedAt.getTime();
  const expires = input.expiresAt.getTime();
  if (
    !(Number.isFinite(issued) && Number.isFinite(expires)) ||
    expires <= issued ||
    expires - issued > OFFLINE_GRANT_MAX_LIFETIME_MS
  ) {
    throw new InvalidOfflineGrantWindowError();
  }
}

export type OfflineGrantStatus = "active" | "expired" | "revoked";

/** Revocation wins over expiry: a revoked grant is never "active" again. */
export function offlineGrantStatus(
  grant: { expiresAt: Date; revokedAt: Date | null },
  now: Date
): OfflineGrantStatus {
  if (grant.revokedAt !== null) {
    return "revoked";
  }
  return grant.expiresAt.getTime() > now.getTime() ? "active" : "expired";
}
