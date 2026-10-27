import {
  InvalidSupportRequestError,
  type RevealableCustomerField,
  supportRefusalFromMessage,
  TenantAccessDeniedError,
} from "@polaris/domain/admin/support-access";
import type { ClosureNoticeDismissalReason } from "@polaris/domain/organization/closure-deadlines";
import {
  OrganizationPurgeRefusedError,
  organizationPurgeRefusalFromMessage,
  purgeDelayAfterWindowMs,
} from "@polaris/domain/privacy/organization-purge";
import type { AdminQueryable } from "./platform-principal-repository";

/**
 * The Admin's support cases, temporary tenant access and masked reads (plan PR96
 * to PR98, ADR 0072): thin calls to database functions that do the work, check
 * the grant and write the audit in one transaction. The Admin role reads no
 * table; a refusal from the database becomes a named error here, never raw.
 */

export interface SupportCaseSummary {
  closedAt: string | null;
  id: string;
  kind: string;
  openedAt: string;
  organizationId: string;
  organizationName: string;
  reason: string;
  status: string;
}

export interface SupportCasePage {
  cases: SupportCaseSummary[];
  next: string | null;
}

export interface TenantAccessGrantRecord {
  caseId: string;
  expiresAt: string;
  id: string;
  organizationId: string;
  startsAt: string;
}

export interface SupportCaseDetail {
  audit: {
    createdAt: string;
    detail: string | null;
    entityId: string | null;
    entityType: string | null;
    eventType: string;
    id: string;
    principalId: string;
  }[];
  case: SupportCaseSummary & {
    closedAt: string | null;
    context: string | null;
    openedBy: string;
    resolution: string | null;
  };
  grants: {
    active: boolean;
    expiresAt: string;
    id: string;
    principalId: string;
    revokedAt: string | null;
    startsAt: string;
  }[];
}

/** A customer as the Admin sees them by default: masked, never the real contact. */
export interface MaskedCustomer {
  archived: boolean;
  email: string | null;
  hasNotes: boolean;
  id: string;
  name: string;
  phone: string | null;
}

export interface MaskedCustomerPage {
  customers: MaskedCustomer[];
  next: string | null;
}

const ACCESS_DENIED = "42501";
const INVALID_PARAMETER = "22023";
const OBJECT_NOT_IN_STATE = "55000";

function sqlState(error: unknown): string | undefined {
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

async function call<T>(
  client: AdminQueryable,
  statement: string,
  values: unknown[]
): Promise<T | null> {
  try {
    // clock_timestamp() makes each statement volatile, so a pooler that caches reads never answers one of these
    // (the audit and the grant check must run every time)
    const { rows } = await client.query(
      `SELECT ${statement} AS result, pg_catalog.clock_timestamp() AS at`,
      values
    );
    return (rows[0]?.result ?? null) as T | null;
  } catch (error: unknown) {
    const state = sqlState(error);
    if (state === ACCESS_DENIED) {
      // biome-ignore lint/style/useErrorCause: TenantAccessDeniedError forwards this cause to Error.
      throw new TenantAccessDeniedError({ cause: error });
    }
    const refusal =
      state === OBJECT_NOT_IN_STATE && error instanceof Error
        ? organizationPurgeRefusalFromMessage(error.message)
        : null;
    if (refusal) {
      // biome-ignore lint/style/useErrorCause: The refusal is the domain's own; the database message only picks its code.
      throw new OrganizationPurgeRefusedError(refusal);
    }
    if (state === INVALID_PARAMETER) {
      // biome-ignore lint/style/useErrorCause: The refusal is the domain's own; the database message only picks its code.
      throw new InvalidSupportRequestError(
        supportRefusalFromMessage(error instanceof Error ? error.message : "")
      );
    }
    throw error;
  }
}

export function openSupportCase(
  client: AdminQueryable,
  principalId: string,
  input: {
    context: string | null;
    kind: string;
    organizationId: string;
    reason: string;
  }
) {
  return call<{
    id: string;
    kind: string;
    openedAt: string;
    organizationId: string;
    reason: string;
    status: string;
  }>(client, "public.admin_open_support_case($1, $2, $3, $4, $5)", [
    principalId,
    input.organizationId,
    input.kind,
    input.reason,
    input.context,
  ]);
}

/** Null when there is no such case; `changed` is false when it was already closed. */
export function closeSupportCase(
  client: AdminQueryable,
  principalId: string,
  caseId: string,
  resolution: string | null
) {
  return call<{
    changed: boolean;
    id: string;
    revokedGrants?: number;
    status: string;
  }>(client, "public.admin_close_support_case($1, $2, $3)", [
    principalId,
    caseId,
    resolution,
  ]);
}

export async function listSupportCases(
  client: AdminQueryable,
  input: {
    after: string | null;
    limit: number;
    organizationId: string | null;
    status: string | null;
  }
): Promise<SupportCasePage> {
  const page = await call<SupportCasePage>(
    client,
    "public.admin_list_support_cases($1, $2, $3, $4)",
    [input.status, input.organizationId, input.limit, input.after]
  );
  return page ?? { cases: [], next: null };
}

export function readSupportCase(client: AdminQueryable, caseId: string) {
  return call<SupportCaseDetail>(
    client,
    "public.admin_support_case_detail($1)",
    [caseId]
  );
}

export function grantTenantAccess(
  client: AdminQueryable,
  principalId: string,
  caseId: string,
  minutes: number
) {
  return call<TenantAccessGrantRecord>(
    client,
    "public.admin_grant_tenant_access($1, $2, $3)",
    [principalId, caseId, minutes]
  );
}

export async function revokeTenantAccess(
  client: AdminQueryable,
  principalId: string,
  grantId: string
): Promise<boolean> {
  const result = await call<{ revoked: boolean }>(
    client,
    "public.admin_revoke_tenant_access($1, $2)",
    [principalId, grantId]
  );
  return result?.revoked === true;
}

/** The organization's customers, masked, while the grant lasts (the read is audited). */
export async function listTenantCustomers(
  client: AdminQueryable,
  principalId: string,
  caseId: string,
  input: { after: string | null; limit: number }
): Promise<MaskedCustomerPage> {
  const page = await call<MaskedCustomerPage>(
    client,
    "public.admin_tenant_customers($1, $2, $3, $4)",
    [principalId, caseId, input.limit, input.after]
  );
  return page ?? { customers: [], next: null };
}

/** One real field of one customer (audited); null when the customer is not in the organization. */
export function revealCustomerField(
  client: AdminQueryable,
  principalId: string,
  caseId: string,
  customerId: string,
  field: RevealableCustomerField
) {
  return call<{ customerId: string; field: string; value: string | null }>(
    client,
    "public.admin_reveal_customer_field($1, $2, $3, $4)",
    [principalId, caseId, customerId, field]
  );
}

/** Suspends the organization of an open case: status, authorization epoch and offline leases; billing is untouched. */
export function suspendOrganization(
  client: AdminQueryable,
  principalId: string,
  caseId: string
) {
  return call<{ changed: boolean; revokedLeases?: number; status: string }>(
    client,
    "public.admin_suspend_organization($1, $2)",
    [principalId, caseId]
  );
}

/**
 * Marks (`internal` true) or unmarks a store as one of Polaris itself, kept out of the activation funnel (corte 2.4,
 * ADR 0071 amended). No case: the store is the platform's own. Audited in the same transaction when the marker
 * changed; `changed` false when it was already so. An unknown store is `unknown_organization`.
 */
export function classifyOrganization(
  client: AdminQueryable,
  principalId: string,
  organizationId: string,
  internal: boolean
) {
  return call<{ changed: boolean; internal: boolean }>(
    client,
    "public.admin_classify_organization($1, $2, $3)",
    [principalId, organizationId, internal]
  );
}

/**
 * Schedules the purge of the case's organization (plan PR107, ADR 0081): only a `closed` one whose
 * recovery window is over, and only when the operator names that same organization (a confirmation). The delay after the window comes from the retention registry (none while
 * the retention of a closed organization is proposed). Scheduling again is not a change.
 */
export function scheduleOrganizationPurge(
  client: AdminQueryable,
  principalId: string,
  caseId: string,
  organizationId: string
) {
  return call<{ changed: boolean; notBefore?: string; status: string }>(
    client,
    "public.admin_schedule_organization_purge($1, $2, $3, $4::bigint)",
    [
      principalId,
      caseId,
      organizationId,
      Math.ceil(purgeDelayAfterWindowMs() / 1000),
    ]
  );
}

/**
 * Cancels a scheduled purge (plan PR107, ADR 0081): the organization goes back from `purge_pending` to
 * `closed`, and only while no run holds the purge. The reason is required and stays on the purge row.
 */
export function cancelOrganizationPurge(
  client: AdminQueryable,
  principalId: string,
  caseId: string,
  organizationId: string,
  reason: string
) {
  return call<{ changed: boolean; status: string }>(
    client,
    "public.admin_cancel_organization_purge($1, $2, $3, $4)",
    [principalId, caseId, organizationId, reason]
  );
}

/**
 * Sends the notice of D minus 7 days of the case's organization again (ADR 0102, amended): a new `d7` of the current
 * cycle for the owner of now, with its outbox event, under an open privacy case and naming the same organization. The
 * purge then waits 7 days from its delivery. Refused while another notice of the cycle is still owed.
 */
export function reissueClosureNotice(
  client: AdminQueryable,
  principalId: string,
  caseId: string,
  organizationId: string
) {
  return call<{ dismissed: boolean; noticeId: string; reissue: number }>(
    client,
    "public.admin_reissue_closure_notice($1, $2, $3)",
    [principalId, caseId, organizationId]
  );
}

/**
 * Dismisses the notice of D minus 7 days of the case's organization by the decision of the person responsible (ADR
 * 0102, amended): nobody can be told. A new `d7` with no user, which counts as delivered for the purge (7 days later),
 * under a privacy case whose decision is recorded, with one reason of the closed list.
 */
export function dismissClosureNotice(
  client: AdminQueryable,
  principalId: string,
  caseId: string,
  organizationId: string,
  reason: ClosureNoticeDismissalReason
) {
  return call<{ dismissed: boolean; noticeId: string; reissue: number }>(
    client,
    "public.admin_dismiss_closure_notice($1, $2, $3, $4)",
    [principalId, caseId, organizationId, reason]
  );
}

/**
 * Places a legal hold on the case's organization (ADR 0081, decision of 18/10/2026): while it is in force the
 * purge is neither scheduled nor run. `storageTouched` tells that a scheduled purge already removed objects from
 * the storage (they do not come back). The operator names the organization (a confirmation) and a review date
 * (in the future, at most 366 days away: when it passes the hold stays and is listed as due for review). Placing
 * it again with a later date renews it (`renewed`), in one transaction with no moment without a hold; with an
 * earlier or equal date it changes nothing. A purged organization is refused (`purge_already_done`).
 */
export function placeOrganizationLegalHold(
  client: AdminQueryable,
  principalId: string,
  caseId: string,
  organizationId: string,
  reviewAt: string
) {
  return call<{
    changed: boolean;
    held: boolean;
    renewed: boolean;
    storageTouched: boolean;
  }>(
    client,
    "public.admin_place_organization_legal_hold($1, $2, $3, $4::timestamptz)",
    [principalId, caseId, organizationId, reviewAt]
  );
}

export interface LegalHoldSummary {
  id: string;
  organizationId: string;
  organizationName: string;
  placedAt: string;
  placedBy: string;
  reviewAt: string;
  /** The review date passed: the hold is still in force and waits for an operator to review it. */
  reviewDue: boolean;
  supportCaseId: string;
}

export interface LegalHoldPage {
  /** How many holds in force are past their review date, over all of them and not only this page. */
  dueForReview: number;
  holds: LegalHoldSummary[];
  next: string | null;
}

/** The legal holds in force, newest first, read only: a purge that waits for a hold has one to show. */
export async function listOrganizationLegalHolds(
  client: AdminQueryable,
  input: { after: string | null; limit: number }
): Promise<LegalHoldPage> {
  const page = await call<LegalHoldPage>(
    client,
    "public.admin_list_organization_legal_holds($1, $2)",
    [input.limit, input.after]
  );
  return page ?? { dueForReview: 0, holds: [], next: null };
}

/** Releases the legal hold in force on the case's organization; with none in force it changes nothing. */
export function releaseOrganizationLegalHold(
  client: AdminQueryable,
  principalId: string,
  caseId: string,
  organizationId: string
) {
  return call<{ changed: boolean; held: boolean }>(
    client,
    "public.admin_release_organization_legal_hold($1, $2, $3)",
    [principalId, caseId, organizationId]
  );
}

/** Undoes a suspension (a closed organization stays closed). */
export function reactivateOrganization(
  client: AdminQueryable,
  principalId: string,
  caseId: string
) {
  return call<{ changed: boolean; status: string }>(
    client,
    "public.admin_reactivate_organization($1, $2)",
    [principalId, caseId]
  );
}

export type BillingAuditEvent =
  | "billing.entitlement_grant_requested"
  | "billing.entitlement_granted"
  | "billing.entitlement_revoke_requested"
  | "billing.entitlement_revoked";

/**
 * Records a step of a billing command in the administrative audit and returns
 * the organization of the open case. The command itself is carried out by the
 * billing role (the only writer of billing): the record of the request is made
 * first, so nothing is done that was not first written down.
 */
export function auditBillingCommand(
  client: AdminQueryable,
  principalId: string,
  caseId: string,
  event: BillingAuditEvent,
  entityId: string | null,
  detail: string | null
) {
  return call<string>(
    client,
    "public.admin_audit_billing_command($1, $2, $3, $4, $5)",
    [principalId, caseId, event, entityId, detail]
  );
}

/**
 * The workflow of a privacy request (plan PR103, ADR 0077). Each call moves one step and
 * writes the audit in the same transaction; a step out of order, or a decision the case
 * does not allow, is refused by the database with a named code.
 */
export interface PrivacyCaseSummary {
  dueAt: string;
  id: string;
  openedAt: string;
  organizationId: string;
  organizationName: string;
  overdue: boolean;
  requesterKind: string;
  requestType: string;
  stage: string;
  status: string;
}

export interface PrivacyCasePage {
  cases: PrivacyCaseSummary[];
  next: string | null;
}

export interface PrivacyCaseDetail {
  actions: {
    action: string;
    entityId: string | null;
    id: string;
    recordedAt: string;
    recordedBy: string;
  }[];
  audit: {
    at: string;
    detail: string | null;
    entityType: string | null;
    eventType: string;
    principalId: string;
  }[];
  case: {
    closedAt: string | null;
    id: string;
    openedAt: string;
    organizationId: string;
    organizationName: string;
    resolution: string | null;
    status: string;
  };
  privacy: {
    channel: string;
    decision: string | null;
    decisionNote: string | null;
    decisionReason: string | null;
    dueAt: string;
    identityMethod: string | null;
    identityStatus: string | null;
    note: string | null;
    overdue: boolean;
    polarisRole: string | null;
    receivedAt: string;
    requesterKind: string;
    requestType: string;
    resolvedAt: string | null;
    scopeCategories: string[] | null;
    stage: string;
    subjectReference: string | null;
  };
}

export interface PrivacyStepResult {
  id: string;
  stage: string;
}

export function openPrivacyCase(
  client: AdminQueryable,
  principalId: string,
  input: {
    channel: string;
    dueDays: number;
    note: string | null;
    organizationId: string;
    reason: string;
    receivedAt: Date | null;
    requesterKind: string;
    requestType: string;
  }
) {
  return call<{
    dueAt: string;
    id: string;
    openedAt: string;
    organizationId: string;
    stage: string;
  }>(
    client,
    "public.admin_open_privacy_case($1, $2, $3, $4, $5, $6, $7::timestamptz, $8, $9::integer)",
    [
      principalId,
      input.organizationId,
      input.reason,
      input.requestType,
      input.requesterKind,
      input.channel,
      input.receivedAt,
      input.note,
      input.dueDays,
    ]
  );
}

export function recordPrivacyIdentity(
  client: AdminQueryable,
  principalId: string,
  caseId: string,
  input: { method: string; status: string }
) {
  return call<PrivacyStepResult>(
    client,
    "public.admin_privacy_record_identity($1, $2, $3, $4)",
    [principalId, caseId, input.status, input.method]
  );
}

export function recordPrivacyRole(
  client: AdminQueryable,
  principalId: string,
  caseId: string,
  role: string
) {
  return call<PrivacyStepResult>(
    client,
    "public.admin_privacy_record_role($1, $2, $3)",
    [principalId, caseId, role]
  );
}

export function recordPrivacyScope(
  client: AdminQueryable,
  principalId: string,
  caseId: string,
  input: { categories: string[]; subjectReference: string | null }
) {
  return call<PrivacyStepResult>(
    client,
    "public.admin_privacy_record_scope($1, $2, $3::text[], $4)",
    [principalId, caseId, input.categories, input.subjectReference]
  );
}

export function recordPrivacyDecision(
  client: AdminQueryable,
  principalId: string,
  caseId: string,
  input: { decision: string; note: string | null; reason: string | null }
) {
  return call<PrivacyStepResult>(
    client,
    "public.admin_privacy_record_decision($1, $2, $3, $4, $5)",
    [principalId, caseId, input.decision, input.reason, input.note]
  );
}

export function recordPrivacyAction(
  client: AdminQueryable,
  principalId: string,
  caseId: string,
  input: { action: string; entityId: string | null }
) {
  return call<PrivacyStepResult & { actionId: string }>(
    client,
    "public.admin_privacy_record_action($1, $2, $3, $4)",
    [principalId, caseId, input.action, input.entityId]
  );
}

export function resolvePrivacyCase(
  client: AdminQueryable,
  principalId: string,
  caseId: string,
  resolution: string | null
) {
  return call<PrivacyStepResult & { revokedGrants: number }>(
    client,
    "public.admin_privacy_resolve($1, $2, $3)",
    [principalId, caseId, resolution]
  );
}

/** Null when there is no such privacy case. */
export function readPrivacyCase(client: AdminQueryable, caseId: string) {
  return call<PrivacyCaseDetail>(
    client,
    "public.admin_privacy_case_detail($1)",
    [caseId]
  );
}

export async function listPrivacyCases(
  client: AdminQueryable,
  input: {
    after: string | null;
    filter: "closed" | "open" | "overdue" | null;
    limit: number;
  }
): Promise<PrivacyCasePage> {
  const page = await call<PrivacyCasePage>(
    client,
    "public.admin_list_privacy_cases($1, $2, $3)",
    [input.filter, input.limit, input.after]
  );
  return page ?? { cases: [], next: null };
}
