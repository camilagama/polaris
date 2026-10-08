export type RequestContextErrorCode =
  | "authentication_unavailable"
  | "session_required"
  | "organization_id_required";

export class TenantRequestContextError extends Error {
  readonly code: RequestContextErrorCode;

  constructor(code: RequestContextErrorCode) {
    super(code);
    this.code = code;
    this.name = "TenantRequestContextError";
  }
}
