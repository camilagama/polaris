/**
 * The shapes the page reads, as the routes of this cut answer them. Types only: nothing of a server package enters
 * the script. The diagnostics are the domain's own report and the funnel is its contract; the list, `whoami` and the
 * support cases are written here because their types live next to the database, and the refund window because the
 * page reads its codes as text (an unknown state or method is shown as unknown). `src/ui/ui-types.test.ts` fails if
 * a shape here and the server's drift apart.
 */

export type { ActivationFunnelResponse } from "@polaris/contracts/admin-activation-funnel";
export type { OrganizationDiagnostics } from "@polaris/domain/admin/organization-diagnostics";

export interface OrganizationSummary {
  accessEndsAt: string | null;
  billingState: string;
  createdAt: string;
  id: string;
  name: string;
  planInForce: string;
  status: string;
}

export interface OrganizationPage {
  next: string | null;
  organizations: OrganizationSummary[];
}

export interface WhoAmI {
  capabilities: string[];
  principal: { emailSnapshot: string | null; id: string; role: string };
}

/** One case of `GET /api/support-cases`, as the support repository lists it. */
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

/** What `POST /api/support-cases` answers with the case it opened. */
export interface OpenedSupportCase {
  id: string;
  kind: string;
  openedAt: string;
  organizationId: string;
  reason: string;
  status: string;
}

/** What `POST /api/support-cases/:caseId/refund-window` answers: the domain's view, computed on the database clock. */
export interface RefundWindowView {
  firstChargeAmount: string | null;
  firstChargeAt: string | null;
  method: string | null;
  now: string;
  refundable: boolean;
  refundRequestedAt: string | null;
  /** True when the store's provider refunds through the Admin: the server's one rule, never inferred on the page. */
  refundsHere: boolean;
  renewal: {
    accessUntil: string | null;
    renewsOn: string | null;
    resubscribeFrom: string | null;
    status: "cancelled" | "none" | "renewing";
  };
  request: {
    at: string;
    completable: boolean;
    completableUntil: string;
  } | null;
  state: string;
  window: { open: boolean; until: string } | null;
}

/** What the operator's two provider commands answer (ADR 0105): the code the page has a sentence for. */
export type ProviderCommandResult =
  | "already_cancelled"
  | "amount_changed"
  | "cancelled"
  | "command_in_progress"
  | "not_linked"
  | "nothing_to_cancel"
  | "nothing_to_refund"
  | "provider_unavailable"
  | "refund_not_supported"
  | "refund_requested";

/** What `GET /api/support-cases/:caseId` answers: the case, its temporary accesses and its audit trail. */
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

/** What `POST /api/support-cases/:caseId/close` answers: `changed` is false when the case was already closed. */
export interface ClosedSupportCase {
  changed: boolean;
  id: string;
  status: string;
}

export interface OperationalIncidentSummary {
  cause: string;
  deadEvents: number;
  firstSeenAt: string;
  id: string;
  kind: string;
  lastReference: string | null;
  lastSeenAt: string;
  occurrenceCount: number;
  subject: string;
}

export interface OperationalIncidentPage {
  incidents: OperationalIncidentSummary[];
  next: string | null;
}

/** One event of an incident; `organizationId` comes with it and is never shown (the screen names no store). */
export interface DeadEventSummary {
  eventId: string;
  eventType: string;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrences: number;
  organizationId: string;
  retriedAt: string | null;
  retryCount: number;
  state: "dead" | "retried";
}

export interface OperationalIncidentDetail {
  events: DeadEventSummary[];
  incident: Omit<OperationalIncidentSummary, "deadEvents">;
  next: string | null;
}

export type RetryResult =
  | "already_pending"
  | "busy"
  | "event_gone"
  | "retried"
  | "unknown_item";

export interface RetryAnswer {
  result?: string;
}

/** What `POST /api/support-cases/:caseId/entitlement-grants` answers, of which the page reads these three. */
export interface GrantedEntitlement {
  /** False when the same command ID repeated a grant already given. */
  created: boolean;
  id: string;
  /** False when the grant was given but the record of its outcome could not be written. */
  outcomeRecorded: boolean;
}

/** What `DELETE …/entitlement-grants/:grantId` answers: `revoked` is false when nothing was ended. */
export interface EndedEntitlement {
  outcomeRecorded: boolean;
  revoked: boolean;
}

/** One line of the access log (ADR 0092): the IP and the user are what the court asks for, and they are only shown. */
export interface AccessLogEntry {
  event: "login_failed" | "login_succeeded" | "logout" | "session_refreshed";
  id: string;
  ip: string;
  occurredAt: string;
  requestId: string;
  userId: string | null;
}

/** What `POST /api/access-log/read` answers on success; a refusal is `{ error }` with a 400. */
export interface AccessLogPage {
  entries: AccessLogEntry[];
  next: string | null;
}

/** One case of `GET /api/privacy-cases` (ADR 0077): codes, the store and the due date the server keeps. */
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

/** What `GET /api/privacy-cases/:caseId` answers: the case, the workflow's record, the actions and the trail. */
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

/** What `POST /api/privacy-cases` answers with the case it opened. */
export interface OpenedPrivacyCase {
  dueAt: string;
  id: string;
  openedAt: string;
  organizationId: string;
  stage: string;
}

/** What each step's `POST` answers: the case and the stage it is at now. */
export interface PrivacyStepAnswer {
  id: string;
  stage: string;
}

/** What `POST …/purge` answers: `notBefore` only when this call scheduled it (`changed`), never on a repeat. */
export interface PurgeScheduled {
  changed: boolean;
  notBefore?: string;
  status: string;
}

/** What `POST …/purge/cancel` answers: the store back to `closed`. */
export interface PurgeCancelled {
  changed: boolean;
  status: string;
}

/** What `POST …/legal-hold` and `…/legal-hold/release` answer (`renewed` and `storageTouched` only when placing). */
export interface LegalHoldAnswer {
  changed: boolean;
  held: boolean;
  renewed?: boolean;
  storageTouched?: boolean;
}

/** One hold in force of `GET /api/legal-holds`: the store by its ID only, never by its name. */
export interface LegalHoldSummary {
  id: string;
  organizationId: string;
  placedAt: string;
  placedBy: string;
  reviewAt: string;
  /** The review date passed: the hold is still in force and waits for a review. */
  reviewDue: boolean;
  supportCaseId: string;
}

export interface LegalHoldPage {
  /** How many holds in force are past their review date, over all of them. */
  dueForReview: number;
  holds: LegalHoldSummary[];
  next: string | null;
}

/** What `POST /api/support-cases/:caseId/access` answers: the access given, its end by the database's clock. */
export interface GrantedAccess {
  caseId: string;
  expiresAt: string;
  id: string;
  organizationId: string;
  startsAt: string;
}

/** What `DELETE /api/tenant-access/:grantId` answers: false when the access had already ended or does not exist. */
export interface EndedAccess {
  revoked: boolean;
}

/** A customer as the server masks it (`m***@e***.br`, `***`): the page shows it as it came, never unmasked. */
export interface MaskedCustomer {
  archived: boolean;
  email: string | null;
  hasNotes: boolean;
  id: string;
  name: string;
  phone: string | null;
}

/** What `GET /api/support-cases/:caseId/customers` answers: a page of at most 50 and the cursor of the next. */
export interface MaskedCustomerPage {
  customers: MaskedCustomer[];
  next: string | null;
}
