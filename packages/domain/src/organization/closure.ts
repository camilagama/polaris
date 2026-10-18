/**
 * The life of an organization (plan PR101, ADR 0074). `active` and `suspended`
 * are operational states (a suspension is reversible by the platform and is not
 * a closure); the rest is the closure process, which only moves forward except
 * for the owner's recovery inside the window:
 *
 *   active -> closing -> closed -> purge_pending -> purged
 *                 `-> active (recovery, only while the window is open)
 *
 * `closing` is the recovery window: access is already revoked and the catalog is
 * hidden, but nothing was deleted. `closed` starts when the window ends and is
 * not recovered by the owner. `purge_pending` and `purged` belong to the purge
 * workflow (PR107): they are named here so the status never needs another
 * migration, and nothing before that workflow sets them.
 */
export const ORGANIZATION_STATUSES = Object.freeze([
  "active",
  "suspended",
  "closing",
  "closed",
  "purge_pending",
  "purged",
] as const);

export type OrganizationStatus = (typeof ORGANIZATION_STATUSES)[number];

/** The normal recovery window: how long the owner can undo a closure on their own. */
export const CLOSURE_RECOVERY_WINDOW_DAYS = 30;

const DAY_MS = 86_400_000;

/** Statuses in which the organization has started the way out (it is no longer the owner's to operate). */
const closureStatuses: readonly OrganizationStatus[] = Object.freeze([
  "closing",
  "closed",
  "purge_pending",
  "purged",
]);

export function isClosureStatus(status: string): boolean {
  return closureStatuses.some((candidate) => candidate === status);
}

export function isOrganizationStatus(
  status: string
): status is OrganizationStatus {
  return ORGANIZATION_STATUSES.some((candidate) => candidate === status);
}

/** When the recovery window ends for a closure requested at `requestedAt`. */
export function recoveryDeadline(requestedAt: Date): Date {
  return new Date(
    requestedAt.getTime() + CLOSURE_RECOVERY_WINDOW_DAYS * DAY_MS
  );
}

/** The owner can undo a closure only while it is `closing` and the window is open. */
export function canRecoverClosure(
  status: string,
  recoverUntil: Date,
  now: Date
): boolean {
  return status === "closing" && now.getTime() < recoverUntil.getTime();
}

/** A `closing` organization whose window ended is `closed` from then on. */
export function closureStatusAt(
  status: string,
  recoverUntil: Date,
  now: Date
): string {
  return status === "closing" && now.getTime() >= recoverUntil.getTime()
    ? "closed"
    : status;
}

/**
 * Closing an organization is deliberate: the owner types the organization's
 * name. Case and surrounding spaces do not matter (a typo in capitalization is
 * not a reason to fail), but the name must be the whole name.
 */
export function closureConfirmationMatches(
  typed: string,
  organizationName: string
): boolean {
  const normalize = (value: string) =>
    value
      .normalize("NFC")
      .trim()
      .replace(/\s+/g, " ")
      .toLocaleLowerCase("pt-BR");
  const expected = normalize(organizationName);
  return expected.length > 0 && normalize(typed) === expected;
}

/** The typed confirmation is not the organization's name. */
export class ClosureConfirmationError extends Error {
  readonly code = "closure_confirmation_mismatch";

  constructor() {
    super("closure_confirmation_mismatch");
    this.name = "ClosureConfirmationError";
  }
}

/** Only an active organization can be closed (a suspended one is the platform's to reactivate first). */
export class OrganizationNotActiveError extends Error {
  readonly code = "organization_not_active";

  constructor() {
    super("organization_not_active");
    this.name = "OrganizationNotActiveError";
  }
}

/** Not closing, the window ended, or not the owner's: the owner cannot undo this closure. */
export class ClosureNotRecoverableError extends Error {
  readonly code = "closure_not_recoverable";

  constructor() {
    super("closure_not_recoverable");
    this.name = "ClosureNotRecoverableError";
  }
}
