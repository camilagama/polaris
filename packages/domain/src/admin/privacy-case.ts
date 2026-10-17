import { hasControlCharacters } from "./support-access";

/**
 * The internal workflow of a privacy request (plan PR103, ADR 0077): a person, or
 * an organization's owner, asks something about personal data, and an operator
 * takes it through request, identity check, role, scope, decision, execution and
 * resolution. A privacy case holds no personal data: no name, e-mail, document or
 * value of a record, only codes, an opaque reference to the subject, a short note
 * and the steps taken. Identity documents, if any, are looked at outside Polaris
 * and never stored.
 *
 * The role matters: Polaris is the controller of its own account, authentication,
 * billing and security data, and in general only the processor of the customers
 * a reseller registers, so a request about those is the reseller's to decide
 * (privacy.md). Data of a tenant is not erased because a third party with no
 * authority wrote to Polaris.
 */

export const PRIVACY_REQUEST_TYPES = Object.freeze([
  "access",
  "correction",
  "deletion",
  "portability",
  "objection",
  "restriction",
  "other",
] as const);
export type PrivacyRequestType = (typeof PRIVACY_REQUEST_TYPES)[number];

/** Who is asking, as far as Polaris can tell when the request arrives. */
export const PRIVACY_REQUESTER_KINDS = Object.freeze([
  "data_subject",
  "organization_owner",
  "authority",
  "other",
] as const);
export type PrivacyRequesterKind = (typeof PRIVACY_REQUESTER_KINDS)[number];

export const PRIVACY_CHANNELS = Object.freeze([
  "email",
  "in_app",
  "support_ticket",
  "other",
] as const);
export type PrivacyChannel = (typeof PRIVACY_CHANNELS)[number];

export const PRIVACY_IDENTITY_STATUSES = Object.freeze([
  "verified",
  "failed",
] as const);
export type PrivacyIdentityStatus = (typeof PRIVACY_IDENTITY_STATUSES)[number];

/** How the identity was checked. A document, if looked at, is not stored. */
export const PRIVACY_IDENTITY_METHODS = Object.freeze([
  "authenticated_session",
  "email_ownership",
  "owner_confirmation",
  "document_review",
  "other",
] as const);
export type PrivacyIdentityMethod = (typeof PRIVACY_IDENTITY_METHODS)[number];

export const PRIVACY_POLARIS_ROLES = Object.freeze([
  "controller",
  "processor",
] as const);
export type PrivacyPolarisRole = (typeof PRIVACY_POLARIS_ROLES)[number];

export const PRIVACY_DATA_CATEGORIES = Object.freeze([
  "account",
  "authentication",
  "organization_profile",
  "customers",
  "sales",
  "inventory_catalog",
  "media",
  "billing",
  "audit_logs",
] as const);
export type PrivacyDataCategory = (typeof PRIVACY_DATA_CATEGORIES)[number];

export const PRIVACY_DECISIONS = Object.freeze([
  "accept",
  "partially_accept",
  "reject",
  "redirect_to_controller",
] as const);
export type PrivacyDecision = (typeof PRIVACY_DECISIONS)[number];

export const PRIVACY_DECISION_REASONS = Object.freeze([
  "identity_not_verified",
  "no_authority",
  "controller_is_reseller",
  "legal_retention",
  "manifestly_unfounded",
  "not_personal_data",
  "other",
] as const);
export type PrivacyDecisionReason = (typeof PRIVACY_DECISION_REASONS)[number];

/** What was done to carry the decision out. */
export const PRIVACY_ACTIONS = Object.freeze([
  "customer_anonymized",
  "organization_closed",
  "export_delivered",
  "purge_scheduled",
  "redirected_to_reseller",
  "no_action_required",
  "other",
] as const);
export type PrivacyAction = (typeof PRIVACY_ACTIONS)[number];

/** The steps in order; each is recorded only when the case is at the one before. */
export const PRIVACY_STAGES = Object.freeze([
  "requested",
  "identity_checked",
  "role_determined",
  "scoped",
  "decided",
  "executed",
  "resolved",
] as const);
export type PrivacyStage = (typeof PRIVACY_STAGES)[number];

/**
 * How long the operator has to answer, counted from when the request arrived.
 * PROVISIONAL: legal deadlines need a legal review before go-live (privacy.md);
 * the case stores its own due date, so changing this changes only new cases.
 */
export const PRIVACY_CASE_RESPONSE_DAYS = 15;
/** A request that arrived by another channel can be typed in late, but not more than a year late. */
export const MAX_PRIVACY_RECEIVED_AGE_DAYS = 365;
export const MAX_PRIVACY_NOTE_LENGTH = 500;
export const MAX_PRIVACY_REFERENCE_LENGTH = 64;

export type PrivacyRefusalCode =
  | "invalid_privacy_request"
  | "invalid_privacy_step"
  | "privacy_stage_conflict"
  | "privacy_decision_not_allowed";

export class InvalidPrivacyStepError extends Error {
  readonly code: PrivacyRefusalCode;

  constructor(code: PrivacyRefusalCode = "invalid_privacy_step") {
    super(code);
    this.code = code;
    this.name = "InvalidPrivacyStepError";
  }
}

function oneOf<T extends string>(
  values: readonly T[],
  value: unknown,
  code: PrivacyRefusalCode = "invalid_privacy_step"
): T {
  if (typeof value !== "string" || !values.some((entry) => entry === value)) {
    throw new InvalidPrivacyStepError(code);
  }
  return value as T;
}

function shortText(value: unknown, max: number): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || hasControlCharacters(value)) {
    throw new InvalidPrivacyStepError();
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return null;
  }
  if ([...trimmed].length > max) {
    throw new InvalidPrivacyStepError();
  }
  return trimmed;
}

export function dueDate(receivedAt: Date): Date {
  return new Date(
    receivedAt.getTime() + PRIVACY_CASE_RESPONSE_DAYS * 86_400_000
  );
}

export interface PrivacyRequestInput {
  channel: unknown;
  note?: unknown;
  receivedAt?: Date | undefined;
  requestType: unknown;
  requesterKind: unknown;
}

export function normalizePrivacyRequest(
  input: PrivacyRequestInput,
  now: Date
): {
  channel: PrivacyChannel;
  dueAt: Date;
  note: string | null;
  receivedAt: Date;
  requestType: PrivacyRequestType;
  requesterKind: PrivacyRequesterKind;
} {
  const receivedAt = input.receivedAt ?? now;
  if (
    !Number.isFinite(receivedAt.getTime()) ||
    receivedAt.getTime() > now.getTime() ||
    receivedAt.getTime() <
      now.getTime() - MAX_PRIVACY_RECEIVED_AGE_DAYS * 86_400_000
  ) {
    throw new InvalidPrivacyStepError("invalid_privacy_request");
  }
  return {
    channel: oneOf(PRIVACY_CHANNELS, input.channel, "invalid_privacy_request"),
    dueAt: dueDate(receivedAt),
    note: shortText(input.note, MAX_PRIVACY_NOTE_LENGTH),
    receivedAt,
    requestType: oneOf(
      PRIVACY_REQUEST_TYPES,
      input.requestType,
      "invalid_privacy_request"
    ),
    requesterKind: oneOf(
      PRIVACY_REQUESTER_KINDS,
      input.requesterKind,
      "invalid_privacy_request"
    ),
  };
}

export function normalizeIdentityStep(input: {
  method: unknown;
  status: unknown;
}): { method: PrivacyIdentityMethod; status: PrivacyIdentityStatus } {
  return {
    method: oneOf(PRIVACY_IDENTITY_METHODS, input.method),
    status: oneOf(PRIVACY_IDENTITY_STATUSES, input.status),
  };
}

export function normalizeRoleStep(role: unknown): PrivacyPolarisRole {
  return oneOf(PRIVACY_POLARIS_ROLES, role);
}

export function normalizeScopeStep(input: {
  categories: unknown;
  subjectReference?: unknown;
}): { categories: PrivacyDataCategory[]; subjectReference: string | null } {
  if (
    !Array.isArray(input.categories) ||
    input.categories.length === 0 ||
    input.categories.length > PRIVACY_DATA_CATEGORIES.length
  ) {
    throw new InvalidPrivacyStepError();
  }
  const categories = input.categories.map((category) =>
    oneOf(PRIVACY_DATA_CATEGORIES, category)
  );
  if (new Set(categories).size !== categories.length) {
    throw new InvalidPrivacyStepError();
  }
  const subjectReference = shortText(
    input.subjectReference,
    MAX_PRIVACY_REFERENCE_LENGTH
  );
  if (
    subjectReference !== null &&
    !opaqueReferencePattern.test(subjectReference)
  ) {
    throw new InvalidPrivacyStepError();
  }
  return { categories, subjectReference };
}

export interface PrivacyCaseFacts {
  identityStatus: PrivacyIdentityStatus | null;
  polarisRole: PrivacyPolarisRole | null;
  requesterKind: PrivacyRequesterKind;
}

/**
 * What a decision may be, given what the case already established. It never
 * accepts a request whose identity failed, and it never accepts, on Polaris's own
 * authority, a request about data Polaris only processes unless the one asking is
 * the owner of the organization that controls it.
 */
export function assertDecisionAllowed(
  facts: PrivacyCaseFacts,
  decision: PrivacyDecision,
  reason: PrivacyDecisionReason | null
): void {
  const accepting = decision === "accept" || decision === "partially_accept";
  if (facts.identityStatus === "failed") {
    if (decision !== "reject" || reason !== "identity_not_verified") {
      throw new InvalidPrivacyStepError("privacy_decision_not_allowed");
    }
    return;
  }
  if (
    accepting &&
    facts.polarisRole === "processor" &&
    facts.requesterKind !== "organization_owner"
  ) {
    throw new InvalidPrivacyStepError("privacy_decision_not_allowed");
  }
  if (
    decision === "redirect_to_controller" &&
    facts.polarisRole !== "processor"
  ) {
    throw new InvalidPrivacyStepError("privacy_decision_not_allowed");
  }
  // anything but a plain acceptance says why
  if (decision !== "accept" && reason === null) {
    throw new InvalidPrivacyStepError();
  }
  if (reason === "identity_not_verified") {
    // only a failed identity check is a reason to say so
    throw new InvalidPrivacyStepError("privacy_decision_not_allowed");
  }
}

/**
 * What may be recorded as carried out, given the decision: a redirect is carried out by telling the
 * controller (or by nothing to do), an acceptance by doing something else than redirecting, and a
 * refusal has nothing to carry out at all.
 */
export function assertActionAllowed(
  decision: PrivacyDecision,
  action: PrivacyAction
): void {
  if (decision === "reject") {
    throw new InvalidPrivacyStepError("privacy_stage_conflict");
  }
  const redirectActions: readonly PrivacyAction[] = [
    "redirected_to_reseller",
    "no_action_required",
    "other",
  ];
  if (
    (decision === "redirect_to_controller" &&
      !redirectActions.includes(action)) ||
    // an acceptance is carried out by doing something: neither redirecting nor doing nothing
    ((decision === "accept" || decision === "partially_accept") &&
      (action === "redirected_to_reseller" || action === "no_action_required"))
  ) {
    throw new InvalidPrivacyStepError("privacy_decision_not_allowed");
  }
}

export function normalizeDecisionStep(input: {
  decision: unknown;
  note?: unknown;
  reason?: unknown;
}): {
  decision: PrivacyDecision;
  note: string | null;
  reason: PrivacyDecisionReason | null;
} {
  const decision = oneOf(PRIVACY_DECISIONS, input.decision);
  const reason =
    input.reason === undefined || input.reason === null
      ? null
      : oneOf(PRIVACY_DECISION_REASONS, input.reason);
  return {
    decision,
    note: shortText(input.note, MAX_PRIVACY_NOTE_LENGTH),
    reason,
  };
}

/** An opaque reference is an identifier, never text a person wrote: no spaces, no @, no punctuation but - and _. */
const opaqueReferencePattern = /^[A-Za-z0-9_-]+$/;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeActionStep(input: {
  action: unknown;
  entityId?: unknown;
}): { action: PrivacyAction; entityId: string | null } {
  const action = oneOf(PRIVACY_ACTIONS, input.action);
  if (input.entityId === undefined || input.entityId === null) {
    return { action, entityId: null };
  }
  if (typeof input.entityId !== "string" || !uuidPattern.test(input.entityId)) {
    throw new InvalidPrivacyStepError();
  }
  return { action, entityId: input.entityId.toLowerCase() };
}

/** The stage a case is at after a step is recorded; refuses a step out of order. */
export function stageAfter(
  current: PrivacyStage,
  step: "identity" | "role" | "scope" | "decision" | "action" | "resolve",
  decision?: PrivacyDecision | null
): PrivacyStage {
  const expectations: Record<typeof step, readonly PrivacyStage[]> = {
    action: ["decided", "executed"],
    decision: ["scoped"],
    identity: ["requested"],
    resolve: ["decided", "executed"],
    role: ["identity_checked"],
    scope: ["role_determined"],
  };
  if (!expectations[step].some((stage) => stage === current)) {
    throw new InvalidPrivacyStepError("privacy_stage_conflict");
  }
  switch (step) {
    case "identity":
      return "identity_checked";
    case "role":
      return "role_determined";
    case "scope":
      return "scoped";
    case "decision":
      return "decided";
    case "action":
      return "executed";
    case "resolve":
      // a refusal or a redirect needs no execution; an acceptance does
      if (
        current === "decided" &&
        decision !== "reject" &&
        decision !== "redirect_to_controller"
      ) {
        throw new InvalidPrivacyStepError("privacy_stage_conflict");
      }
      return "resolved";
    default:
      throw new InvalidPrivacyStepError("privacy_stage_conflict");
  }
}

/** A case is late when it is still open past its due date. */
export function isOverdue(
  dueAt: Date,
  stage: PrivacyStage,
  now: Date
): boolean {
  return stage !== "resolved" && now.getTime() > dueAt.getTime();
}
