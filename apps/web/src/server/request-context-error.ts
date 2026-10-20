import type { LegalDocumentId } from "@polaris/domain/legal/legal-documents";

export type RequestContextErrorCode =
  | "authentication_unavailable"
  | "legal_acceptance_required"
  | "session_required"
  | "organization_id_required";

/** A document the user still has to accept, with the version in force (ADR 0100). */
export interface PendingLegalAcceptance {
  document: LegalDocumentId;
  version: number;
}

export class TenantRequestContextError extends Error {
  readonly code: RequestContextErrorCode;
  /** Only for `legal_acceptance_required`: what is still to accept. */
  readonly pending: readonly PendingLegalAcceptance[];

  constructor(
    code: RequestContextErrorCode,
    pending: readonly PendingLegalAcceptance[] = []
  ) {
    super(code);
    this.code = code;
    this.pending = pending;
    this.name = "TenantRequestContextError";
  }
}

/**
 * The HTTP status of a refusal of the request context on the `/api/*` routes: no session is a 401, a
 * missing legal acceptance a 403 (never a 503 with an alert: it is the person's to fix, at `/aceite`),
 * anything else the authentication being unavailable.
 */
export function requestContextErrorStatus(
  code: RequestContextErrorCode
): 401 | 403 | 503 {
  if (code === "session_required") {
    return 401;
  }
  if (code === "legal_acceptance_required") {
    return 403;
  }
  return 503;
}
