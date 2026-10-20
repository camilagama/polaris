import { LEGAL_DOCUMENTS } from "@polaris/domain/legal/legal-documents";

/**
 * The password screens talk to the auth server with plain JSON POSTs (ADR 0100). Nothing here is stored:
 * no e-mail, no password, no token, no answer. The token of a link lives in memory only.
 */
type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

const REQUEST_TIMEOUT_MS = 20_000;
const TURNSTILE_HEADER = "x-turnstile-token";
const TOKEN_FRAGMENT = /^#token=([^&]+)$/;
const TOKEN_MAX_LENGTH = 2048;
// one @, something before it, a dot after it, no space: the server checks the rest
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** What came back: the status and the code of the error, if any. `status: 0` is "no answer". */
export interface AuthAnswer {
  body: Record<string, unknown> | null;
  code: string | null;
  status: number;
}

/** Better Auth answers `{ code }`; the Worker's own refusals answer `{ error: { code } }`. */
export function errorCode(body: unknown): string | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const { code, error } = body as { code?: unknown; error?: unknown };
  if (typeof code === "string") {
    return code;
  }
  if (typeof error === "object" && error !== null) {
    const nested = (error as { code?: unknown }).code;
    return typeof nested === "string" ? nested : null;
  }
  return null;
}

/**
 * `POST` with a JSON body, and the challenge token in its header when there is one (AC-51). A network
 * failure or a timeout is `status: 0`; nothing is retried.
 */
export async function postAuth(
  path: string,
  body: Record<string, unknown>,
  options: { fetcher?: Fetcher; turnstileToken?: string | null } = {}
): Promise<AuthAnswer> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (options.turnstileToken) {
    headers[TURNSTILE_HEADER] = options.turnstileToken;
  }
  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(path, {
      body: JSON.stringify(body),
      cache: "no-store",
      credentials: "same-origin",
      headers,
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { body: null, code: null, status: 0 };
  }
  const parsed: unknown = await response.json().catch(() => null);
  const record =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  return {
    body: record,
    code: response.ok ? null : errorCode(parsed),
    status: response.status,
  };
}

/**
 * The token of a link (`/redefinir-senha#token=…`), read once and taken out of the address bar at once,
 * before any other script of the page (the challenge) loads (consolidation, item 3; AC-53). A reload finds
 * no fragment: the page then asks for the link again instead of saying it expired (V2).
 */
export function takeFragmentToken(
  location: Pick<Location, "hash" | "pathname" | "search">,
  history: Pick<History, "replaceState">
): string | null {
  // `window.location` is live: the fragment is read before the address changes
  const { hash, pathname, search } = location;
  if (!hash) {
    return null;
  }
  history.replaceState(null, "", `${pathname}${search}`);
  const match = TOKEN_FRAGMENT.exec(hash);
  if (!match?.[1]) {
    return null;
  }
  let token: string;
  try {
    token = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  return token.length > 0 && token.length <= TOKEN_MAX_LENGTH ? token : null;
}

export type EmailProblem = "invalid" | "required";

/** Only the shape: whether the address has an account is never said here. */
export function emailProblem(value: string): EmailProblem | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "required";
  }
  return EMAIL_SHAPE.test(trimmed) ? null : "invalid";
}

export type NewPasswordProblem =
  | "compromised"
  | "invalid_characters"
  | "too_long"
  | "too_short";

const PASSWORD_MIN = 15;
const PASSWORD_MAX = 128;

/**
 * The size rule, checked before sending as the server checks it (NFC, 15 to 128 characters). The breach
 * check only the server makes.
 */
export function newPasswordProblem(value: string): NewPasswordProblem | null {
  const { length } = [...value.normalize("NFC")];
  if (length < PASSWORD_MIN) {
    return "too_short";
  }
  return length > PASSWORD_MAX ? "too_long" : null;
}

/** A password refusal of the server, as a problem of the field. */
function passwordPolicyProblem(code: string | null): NewPasswordProblem | null {
  switch (code) {
    case "password_compromised":
      return "compromised";
    case "password_invalid_unicode":
      return "invalid_characters";
    case "password_too_long":
    case "PASSWORD_TOO_LONG":
      return "too_long";
    case "password_too_short":
    case "PASSWORD_TOO_SHORT":
      return "too_short";
    default:
      return null;
  }
}

/** The refusals every password form shares. Anything not named here is "unavailable". */
export type CommonFailure =
  | "challenge"
  | "hibp_unavailable"
  | "limit"
  | "unavailable";

export function commonFailure(answer: AuthAnswer): CommonFailure {
  if (answer.status === 429) {
    return "limit";
  }
  if (answer.code === "auth_challenge_failed") {
    return "challenge";
  }
  if (answer.code === "password_hibp_unavailable") {
    return "hibp_unavailable";
  }
  return "unavailable";
}

/** The minutes of a lock, from `retryAfterSeconds`, rounded up (desenho §5); at least 1. */
export function lockMinutes(retryAfterSeconds: unknown): number {
  const seconds =
    typeof retryAfterSeconds === "number" && Number.isFinite(retryAfterSeconds)
      ? retryAfterSeconds
      : 15 * 60;
  return Math.max(1, Math.ceil(seconds / 60));
}

export type SignInOutcome =
  | { kind: "failure"; failure: CommonFailure }
  | { kind: "incorrect" }
  | { kind: "locked"; retryAfterSeconds: number }
  | { kind: "signed-in" }
  | { kind: "unverified" };

/** `POST /api/auth/sign-in/email` (AC-50, AC-62, AC-63): the same "incorrect" for an e-mail with no account. */
export function signInOutcome(answer: AuthAnswer): SignInOutcome {
  if (answer.status >= 200 && answer.status < 300) {
    return { kind: "signed-in" };
  }
  if (answer.code === "auth_login_locked") {
    return {
      kind: "locked",
      retryAfterSeconds: lockMinutes(answer.body?.retryAfterSeconds) * 60,
    };
  }
  if (answer.status === 401 || answer.code === "INVALID_EMAIL_OR_PASSWORD") {
    return { kind: "incorrect" };
  }
  if (answer.code === "EMAIL_NOT_VERIFIED") {
    return { kind: "unverified" };
  }
  return { failure: commonFailure(answer), kind: "failure" };
}

/** The acceptance the sign-up carries: the versions in force, never a hash (the server has the constant). */
export function signUpLegalAcceptance(): { privacy: number; terms: number } {
  return {
    privacy: LEGAL_DOCUMENTS.privacy.version,
    terms: LEGAL_DOCUMENTS.terms.version,
  };
}

export type SignUpOutcome =
  | { kind: "acceptance" }
  | { kind: "created" }
  | { kind: "failure"; failure: CommonFailure }
  | { kind: "password"; problem: NewPasswordProblem };

/**
 * `POST /api/auth/sign-up/email`. An e-mail that already has an account answers the same 200 as a new one
 * (AC-49): the screen says "confirm your e-mail" in both cases.
 */
export function signUpOutcome(answer: AuthAnswer): SignUpOutcome {
  if (answer.status >= 200 && answer.status < 300) {
    return { kind: "created" };
  }
  if (answer.code === "legal_acceptance_required") {
    return { kind: "acceptance" };
  }
  const problem = passwordPolicyProblem(answer.code);
  if (problem) {
    return { kind: "password", problem };
  }
  return { failure: commonFailure(answer), kind: "failure" };
}

export type ResetOutcome =
  | { kind: "done" }
  | { kind: "failure"; failure: CommonFailure }
  | { kind: "link-invalid" }
  | { kind: "password"; problem: NewPasswordProblem };

/** `POST /api/auth/reset-password {token, newPassword}` (AC-53). */
export function resetOutcome(answer: AuthAnswer): ResetOutcome {
  if (answer.status >= 200 && answer.status < 300) {
    return { kind: "done" };
  }
  const problem = passwordPolicyProblem(answer.code);
  if (problem) {
    return { kind: "password", problem };
  }
  if (answer.code === "INVALID_TOKEN" || answer.status === 400) {
    return { kind: "link-invalid" };
  }
  return { failure: commonFailure(answer), kind: "failure" };
}

export type LinkOutcome =
  | "done"
  | "expired"
  | "invalid"
  | "limit"
  | "unavailable";

/** `POST /api/email-verification` and `POST /api/login-unlock`: a 400 says the link is no good. */
export function linkOutcome(answer: AuthAnswer): LinkOutcome {
  if (answer.status >= 200 && answer.status < 300) {
    return "done";
  }
  if (answer.code === "verification_link_expired") {
    return "expired";
  }
  if (answer.status === 400) {
    return "invalid";
  }
  return answer.status === 429 ? "limit" : "unavailable";
}

export type ChangeOutcome =
  | { kind: "current-wrong" }
  | { kind: "done" }
  | { kind: "failure"; failure: CommonFailure }
  | { kind: "locked"; retryAfterSeconds: number }
  | { kind: "no-password" }
  | { kind: "password"; problem: NewPasswordProblem }
  | { kind: "recent-required" }
  | { kind: "session-ended" };

/** `POST /api/auth/change-password` (AC-57), with the 15-minute rule of the consolidation. */
export function changeOutcome(answer: AuthAnswer): ChangeOutcome {
  if (answer.status >= 200 && answer.status < 300) {
    return { kind: "done" };
  }
  if (answer.status === 401) {
    return { kind: "session-ended" };
  }
  if (answer.code === "fresh_session_required") {
    return { kind: "recent-required" };
  }
  if (answer.code === "auth_login_locked") {
    return {
      kind: "locked",
      retryAfterSeconds: lockMinutes(answer.body?.retryAfterSeconds) * 60,
    };
  }
  if (answer.code === "INVALID_PASSWORD") {
    return { kind: "current-wrong" };
  }
  if (answer.code === "CREDENTIAL_ACCOUNT_NOT_FOUND") {
    return { kind: "no-password" };
  }
  const problem = passwordPolicyProblem(answer.code);
  if (problem) {
    return { kind: "password", problem };
  }
  return { failure: commonFailure(answer), kind: "failure" };
}
