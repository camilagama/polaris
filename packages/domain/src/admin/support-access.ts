/**
 * Support cases and temporary tenant access (plan PR96 to PR98, ADR 0072): the
 * rules an operator's request must meet and the refusals the database gives,
 * named so the Admin can answer them without showing a database error.
 */

export const SUPPORT_CASE_KINDS = ["support", "privacy"] as const;
export type SupportCaseKind = (typeof SUPPORT_CASE_KINDS)[number];

/** Fields of a customer that can be revealed on request; never a secret, which is not here to reveal. */
export const REVEALABLE_CUSTOMER_FIELDS = [
  "name",
  "email",
  "phone",
  "notes",
] as const;
export type RevealableCustomerField =
  (typeof REVEALABLE_CUSTOMER_FIELDS)[number];

export const DEFAULT_ACCESS_MINUTES = 60;
export const MIN_ACCESS_MINUTES = 5;
export const MAX_ACCESS_MINUTES = 240;
export const MAX_CASE_REASON_LENGTH = 500;
export const MAX_CASE_CONTEXT_LENGTH = 2000;
export const MAX_CASE_RESOLUTION_LENGTH = 500;

export type SupportRefusalCode =
  | "case_not_open"
  | "invalid_cancel_reason"
  | "invalid_case_context"
  | "invalid_case_kind"
  | "invalid_case_reason"
  | "invalid_case_resolution"
  | "invalid_duration"
  | "invalid_field"
  | "invalid_privacy_request"
  | "invalid_privacy_step"
  | "invalid_request"
  | "invalid_review_at"
  | "privacy_case_workflow_required"
  | "privacy_decision_not_allowed"
  | "privacy_stage_conflict"
  | "unknown_case"
  | "unknown_organization";

/** The request is not acceptable as asked (a stable code says why). */
export class InvalidSupportRequestError extends Error {
  readonly code: SupportRefusalCode;

  constructor(code: SupportRefusalCode) {
    super(code);
    this.name = "InvalidSupportRequestError";
    this.code = code;
  }
}

/** There is no active grant for this principal and case, or the principal is not an active operator. */
export class TenantAccessDeniedError extends Error {
  readonly code = "tenant_access_denied";

  constructor(options?: ErrorOptions) {
    super("tenant_access_denied", options);
    this.name = "TenantAccessDeniedError";
  }
}

const KNOWN_CODES: readonly SupportRefusalCode[] = [
  "case_not_open",
  "invalid_cancel_reason",
  "invalid_case_context",
  "invalid_case_kind",
  "invalid_case_reason",
  "invalid_case_resolution",
  "invalid_duration",
  "invalid_field",
  "invalid_privacy_request",
  "invalid_privacy_step",
  "invalid_review_at",
  "privacy_case_workflow_required",
  "privacy_decision_not_allowed",
  "privacy_stage_conflict",
  "unknown_case",
  "unknown_organization",
];

/** Turns the message of a database refusal into a refusal code; anything else is a generic invalid request. */
export function supportRefusalFromMessage(message: string): SupportRefusalCode {
  return KNOWN_CODES.find((code) => code === message) ?? "invalid_request";
}

/** Text an operator types is shown to other operators and kept in logs: no control characters (a line break is allowed where it is prose). */
export function hasControlCharacters(
  text: string,
  allowLineBreaks = false
): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    const control = code < 32 || code === 127;
    const allowed =
      allowLineBreaks && (code === 10 || code === 13 || code === 9);
    if (control && !allowed) {
      return true;
    }
  }
  return false;
}

export function normalizeResolution(
  resolution: string | null | undefined
): string | null {
  const text = resolution?.trim() ?? "";
  if (
    [...text].length > MAX_CASE_RESOLUTION_LENGTH ||
    hasControlCharacters(text)
  ) {
    throw new InvalidSupportRequestError("invalid_case_resolution");
  }
  return text === "" ? null : text;
}

export interface OpenCaseInput {
  context?: string | null;
  kind: string;
  reason: string;
}

/** Checks a request to open a case before it reaches the database (which checks again). */
export function normalizeOpenCase(input: OpenCaseInput): {
  context: string | null;
  kind: SupportCaseKind;
  reason: string;
} {
  if (!(SUPPORT_CASE_KINDS as readonly string[]).includes(input.kind)) {
    throw new InvalidSupportRequestError("invalid_case_kind");
  }
  const reason = input.reason.trim();
  if (
    reason === "" ||
    [...reason].length > MAX_CASE_REASON_LENGTH ||
    hasControlCharacters(reason)
  ) {
    throw new InvalidSupportRequestError("invalid_case_reason");
  }
  const context = input.context?.trim() ?? "";
  if (
    [...context].length > MAX_CASE_CONTEXT_LENGTH ||
    hasControlCharacters(context, true)
  ) {
    throw new InvalidSupportRequestError("invalid_case_context");
  }
  return {
    context: context === "" ? null : context,
    kind: input.kind as SupportCaseKind,
    reason,
  };
}

export function normalizeAccessMinutes(minutes: number | undefined): number {
  const value = minutes ?? DEFAULT_ACCESS_MINUTES;
  if (
    !Number.isInteger(value) ||
    value < MIN_ACCESS_MINUTES ||
    value > MAX_ACCESS_MINUTES
  ) {
    throw new InvalidSupportRequestError("invalid_duration");
  }
  return value;
}

/** A legal hold is reviewed at most this far from the day it is placed (the database holds the same limit). */
export const MAX_LEGAL_HOLD_REVIEW_DAYS = 366;

const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * The review date of a legal hold (ADR 0081): an ISO 8601 instant with its offset, in the future and no more than
 * `MAX_LEGAL_HOLD_REVIEW_DAYS` away. Returns it in UTC; the database checks the same bounds again.
 */
export function normalizeLegalHoldReviewAt(
  value: unknown,
  now: Date = new Date()
): string {
  if (typeof value !== "string" || !ISO_INSTANT.test(value)) {
    throw new InvalidSupportRequestError("invalid_review_at");
  }
  const at = new Date(value);
  const limit = now.getTime() + MAX_LEGAL_HOLD_REVIEW_DAYS * 86_400_000;
  if (
    Number.isNaN(at.getTime()) ||
    at.getTime() <= now.getTime() ||
    at.getTime() > limit
  ) {
    throw new InvalidSupportRequestError("invalid_review_at");
  }
  return at.toISOString();
}

export function isRevealableField(
  value: string
): value is RevealableCustomerField {
  return (REVEALABLE_CUSTOMER_FIELDS as readonly string[]).includes(value);
}
