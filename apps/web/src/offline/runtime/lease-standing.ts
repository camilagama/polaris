import type { OfflineLeaseClaims } from "@polaris/domain/offline/offline-lease";

/**
 * Whether a cached lease lets this device keep working without a network
 * (emenda do ADR 0047). Pure: the runtime reads the claims (unverified, the
 * server is the one that trusts or not) and asks here.
 *
 * - `usable`: the session user's own lease, for this organization and device, before its `exp`;
 * - `expired`: the same lease, but its `exp` has passed: the offline access ended, the queue stays;
 * - `foreign`: unreadable, or somebody else's (user, organization or device): never used.
 */
export type LeaseStanding = "expired" | "foreign" | "usable";

export interface LeaseOwner {
  deviceId: string;
  organizationId: string;
  userId: string;
}

export function leaseStanding(
  claims: OfflineLeaseClaims | null,
  owner: LeaseOwner,
  nowMs: number
): LeaseStanding {
  if (
    claims === null ||
    claims.sub !== owner.userId ||
    claims.org !== owner.organizationId ||
    claims.dev !== owner.deviceId
  ) {
    return "foreign";
  }
  return claims.exp * 1000 > nowMs ? "usable" : "expired";
}

/** The longest delay a browser timer holds (about 24.8 days); a later end is looked at again then. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * How long until the timer at the lease's `exp` fires: never negative (an end
 * already passed fires at once) and never more than a browser timer holds.
 */
export function leaseTimerDelay(expiresAtMs: number, nowMs: number): number {
  return Math.min(Math.max(expiresAtMs - nowMs, 0), MAX_TIMER_MS);
}
