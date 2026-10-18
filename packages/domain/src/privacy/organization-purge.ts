/**
 * The full purge of a closed organization (plan PR107, ADR 0081). The purge is started only by an
 * explicit administrative command on a `closed` organization; nothing schedules it on its own while
 * the retention of a closed organization is only proposed (ADR 0079). The executor then removes the
 * storage first (exports and image masters and derivatives), the rows second, in one transaction that
 * writes the deletion ledger tombstone before deleting, and sweeps the storage prefixes once more.
 */
import type { PrivacyDataCategory } from "../admin/privacy-case";
import {
  RETENTION_POLICIES,
  type RetentionPolicy,
  retentionPolicyIn,
} from "./retention";

/** The order of the workflow; each step can be run again without effect once it is done. */
export const ORGANIZATION_PURGE_STEPS = Object.freeze([
  "exports_storage",
  "media_storage",
  "database",
  "second_sweep",
] as const);

/**
 * How long a run holds a purge. Longer than the lease of a data export (10 minutes), so a purge that
 * waited for an export never overlaps the next run of the same purge.
 */
export const ORGANIZATION_PURGE_LEASE_SECONDS = 15 * 60;

const OPAQUE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class InvalidOrganizationIdError extends Error {
  readonly code = "invalid_organization_id";

  constructor() {
    super("invalid_organization_id");
    this.name = "InvalidOrganizationIdError";
  }
}

function checkedOrganizationId(organizationId: string): string {
  if (!OPAQUE_ID.test(organizationId)) {
    throw new InvalidOrganizationIdError();
  }
  return organizationId;
}

/** Every export of the organization, ready or not (ADR 0078). */
export function organizationExportPrefix(organizationId: string): string {
  return `exports/v1/${checkedOrganizationId(organizationId)}/`;
}

/**
 * Every image master of the organization. The upload key encodes the ID with `encodeURIComponent`,
 * which leaves an opaque ID as it is.
 */
export function organizationMediaPrefix(organizationId: string): string {
  return `media/v2/${encodeURIComponent(checkedOrganizationId(organizationId))}/`;
}

/**
 * The time between the end of the recovery window and the earliest purge, from the retention
 * registry. While `closed_organization` is only proposed it adds nothing: the window (approved, ADR
 * 0074) is the only wait, and the purge needs the explicit command. No period is invented here.
 */
export function purgeDelayAfterWindowMs(
  policies: readonly RetentionPolicy[] = RETENTION_POLICIES
): number {
  const policy = retentionPolicyIn(policies, "closed_organization");
  return policy.status === "aprovada" && policy.period.kind === "duration"
    ? policy.period.ms
    : 0;
}

/**
 * Whether a job may put a closed organization into the purge on its own. Only an approved class with
 * a period allows it; until then (today) the purge starts only by the administrative command, and no
 * job does it.
 */
export function automaticPurgeSchedulingAllowed(
  policies: readonly RetentionPolicy[] = RETENTION_POLICIES
): boolean {
  const policy = retentionPolicyIn(policies, "closed_organization");
  return policy.status === "aprovada" && policy.period.kind === "duration";
}

/**
 * The categories a privacy case must cover for its accepted deletion to start a purge: every tenant
 * category the purge removes (ADR 0081). Account, authentication and billing are not here: the purge
 * keeps them. The migration holds the same list (`whole_organization` in `admin_schedule_organization_purge`),
 * and the gate proves each category is required.
 */
export const ORGANIZATION_PURGE_REQUIRED_SCOPE = Object.freeze([
  "organization_profile",
  "customers",
  "sales",
  "inventory_catalog",
  "media",
  "audit_logs",
] as const satisfies readonly PrivacyDataCategory[]);

/**
 * Why the database refused to schedule or cancel a purge; each one is a state to change first, not an
 * input error.
 */
export const ORGANIZATION_PURGE_REFUSALS = Object.freeze([
  "organization_mismatch",
  "organization_not_closed",
  "privacy_case_required",
  "privacy_case_not_deletion",
  "privacy_requester_not_owner",
  "privacy_case_not_accepted",
  "privacy_scope_incomplete",
  "recovery_window_open",
  "tenant_access_active",
  "paid_access_running",
  "purge_not_scheduled",
  "purge_in_progress",
  "purge_already_done",
] as const);

export type OrganizationPurgeRefusalCode =
  (typeof ORGANIZATION_PURGE_REFUSALS)[number];

export class OrganizationPurgeRefusedError extends Error {
  readonly code: OrganizationPurgeRefusalCode;

  constructor(code: OrganizationPurgeRefusalCode) {
    super(code);
    this.code = code;
    this.name = "OrganizationPurgeRefusedError";
  }
}

/** The named refusal for a database message, or null when the message is not one of them. */
export function organizationPurgeRefusalFromMessage(
  message: string
): OrganizationPurgeRefusalCode | null {
  return (
    ORGANIZATION_PURGE_REFUSALS.find((candidate) => candidate === message) ??
    null
  );
}
