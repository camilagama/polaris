import {
  type EntitlementKey,
  isEntitlementKey,
  isLimitKey,
} from "./entitlements";

/**
 * Temporary entitlement grants (plan PR85): support, a promotion or a
 * partnership gives an organization more than its plan, for a while. A grant is
 * never a subscription and never a way to fake one: it only raises (a limit to a
 * larger number, a capability on), always says why, who gave it, from when and
 * until when, and always ends. Pure: no clock, no database.
 */

/** The longest a grant may last: a permanent change is a plan change. */
export const MAX_GRANT_DAYS = 366;
/** The largest limit a grant may set: a sanity bound, well above any plan. */
export const MAX_GRANT_LIMIT = 100_000;
export const MAX_GRANT_REASON_LENGTH = 300;
export const MAX_GRANT_ACTOR_LENGTH = 128;

const DAY = 86_400_000;
/** The shortest a grant may last: anything shorter is a mistake, not a gift. */
export const MIN_GRANT_SECONDS = 60;
/** Who gave a grant: a stable identifier (an admin user, a system job), never free text and never an e-mail address. */
const ACTOR_PATTERN = /^[a-z0-9][a-z0-9:_.-]*$/i;
const NUL = String.fromCharCode(0);

/** Whether a string is a valid grant actor (who gives or ends a grant). */
export function isValidGrantActor(value: string): boolean {
  const actor = value.trim();
  return (
    actor.length >= 1 &&
    actor.length <= MAX_GRANT_ACTOR_LENGTH &&
    ACTOR_PATTERN.test(actor)
  );
}

export type GrantRefusalCode =
  | "invalid_actor"
  | "invalid_id"
  | "invalid_key"
  | "invalid_period"
  | "invalid_reason"
  | "invalid_value"
  | "grant_too_long";

export class InvalidEntitlementGrantError extends Error {
  readonly code: GrantRefusalCode;

  constructor(code: GrantRefusalCode) {
    super(code);
    this.name = "InvalidEntitlementGrantError";
    this.code = code;
  }
}

export interface GrantRequest {
  /** Who gives it. */
  actor: string;
  expiresAt: Date;
  key: string;
  reason: string;
  /** From when it counts; now when omitted. */
  startsAt?: Date;
  /** A limit for a limit key, true for a capability. */
  value: boolean | number;
}

export interface NormalizedGrant {
  actor: string;
  expiresAt: Date;
  flagValue: boolean | null;
  key: EntitlementKey;
  limitValue: number | null;
  reason: string;
  startsAt: Date;
}

/**
 * Checks a request to grant something and returns what is stored, or refuses it.
 * It must expire in the future and within the longest grant, start before it
 * expires, say why in a few words and say who gives it; a limit is a whole
 * number the plan could not be mistaken for, and a capability can only be turned
 * on (turning one off is not a grant: a grant never lowers anything).
 */
export function normalizeGrant(
  request: GrantRequest,
  now: Date
): NormalizedGrant {
  if (!isEntitlementKey(request.key)) {
    throw new InvalidEntitlementGrantError("invalid_key");
  }
  const { key } = request;
  const reason = request.reason.trim();
  if (
    reason.length < 1 ||
    reason.includes(NUL) ||
    [...reason].length > MAX_GRANT_REASON_LENGTH
  ) {
    throw new InvalidEntitlementGrantError("invalid_reason");
  }
  const actor = request.actor.trim();
  if (
    actor.length < 1 ||
    actor.length > MAX_GRANT_ACTOR_LENGTH ||
    !ACTOR_PATTERN.test(actor)
  ) {
    throw new InvalidEntitlementGrantError("invalid_actor");
  }
  const startsAt = request.startsAt ?? now;
  const { expiresAt } = request;
  if (
    !(
      Number.isFinite(startsAt.getTime()) &&
      Number.isFinite(expiresAt.getTime())
    ) ||
    expiresAt.getTime() <= now.getTime() ||
    expiresAt.getTime() <= startsAt.getTime()
  ) {
    throw new InvalidEntitlementGrantError("invalid_period");
  }
  if (expiresAt.getTime() - startsAt.getTime() > MAX_GRANT_DAYS * DAY) {
    throw new InvalidEntitlementGrantError("grant_too_long");
  }
  // not so short it is a slip, and not so far ahead it is a plan
  if (
    expiresAt.getTime() - startsAt.getTime() < MIN_GRANT_SECONDS * 1000 ||
    startsAt.getTime() > now.getTime() + MAX_GRANT_DAYS * DAY
  ) {
    throw new InvalidEntitlementGrantError("invalid_period");
  }
  if (isLimitKey(key)) {
    if (
      typeof request.value !== "number" ||
      !Number.isInteger(request.value) ||
      request.value < 1 ||
      request.value > MAX_GRANT_LIMIT
    ) {
      throw new InvalidEntitlementGrantError("invalid_value");
    }
    return {
      actor,
      expiresAt,
      flagValue: null,
      key,
      limitValue: request.value,
      reason,
      startsAt,
    };
  }
  if (request.value !== true) {
    throw new InvalidEntitlementGrantError("invalid_value");
  }
  return {
    actor,
    expiresAt,
    flagValue: true,
    key,
    limitValue: null,
    reason,
    startsAt,
  };
}
