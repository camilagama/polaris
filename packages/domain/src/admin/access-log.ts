/**
 * What an operator may ask of the access log (ADR 0092): the record of access to the application (date, time and
 * IP of each login, logout, failed login and daily refresh), kept 6 months for the Marco Civil, art. 15, and given
 * out only for a court order (arts. 10, par. 1, and 22). A read names the case, filters by ONE user or ONE IP
 * address, covers a window of at most 31 days and comes a page at a time. The case reference is the number of the
 * process in the CNJ format, with its check digits right, and nothing else: it goes to the administrative audit, which is immutable and lives
 * for years, so free text must not get in. The database repeats every one of these checks.
 */

export const ACCESS_LOG_MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
export const ACCESS_LOG_MAX_PAGE_SIZE = 50;
export const ACCESS_LOG_DEFAULT_PAGE_SIZE = 25;
const MAX_IP_LENGTH = 45;

/** The unified number of a judicial process (CNJ Resolution 65/2008): NNNNNNN-DD.AAAA.J.TR.OOOO. */
/** The shape of a Better Auth user ID: never an e-mail, an IP or a document, which would reach the audit as the entity. */
const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CNJ_NUMBER = /^[0-9]{7}-[0-9]{2}\.[0-9]{4}\.[0-9]\.[0-9]{2}\.[0-9]{4}$/;
const IPV4 = /^[0-9]{1,3}(?:\.[0-9]{1,3}){3}$/;
const IPV4_MAPPED = /^::ffff:([0-9]{1,3}(?:\.[0-9]{1,3}){3})$/i;
const IPV6_CHARACTERS = /^[0-9A-Fa-f:.]+$/;

export type AccessLogRefusal =
  | "invalid_cursor"
  | "invalid_filter"
  | "invalid_page"
  | "invalid_reference"
  | "invalid_window";

export class InvalidAccessLogRequestError extends Error {
  readonly code: AccessLogRefusal;

  constructor(code: AccessLogRefusal) {
    super(code);
    this.code = code;
    this.name = "InvalidAccessLogRequestError";
  }
}

export type AccessLogFilter =
  | { ip: string; kind: "ip" }
  | { kind: "user"; userId: string };

export interface AccessLogRequest {
  after: string | null;
  filter: AccessLogFilter;
  from: Date;
  legalReference: string;
  limit: number;
  to: Date;
}

/** The check digits of the CNJ number (Resolution 65): the 20 digits, DD last, leave remainder 1 modulo 97. */
function hasValidCheckDigits(reference: string): boolean {
  const digits =
    reference.slice(0, 7) +
    reference.slice(11, 15) +
    reference.slice(16, 17) +
    reference.slice(18, 20) +
    reference.slice(21, 25) +
    reference.slice(8, 10);
  return BigInt(digits) % 97n === 1n;
}

export function isLegalReference(value: unknown): value is string {
  return (
    typeof value === "string" &&
    CNJ_NUMBER.test(value) &&
    hasValidCheckDigits(value)
  );
}

function isIpText(value: string): boolean {
  if (value.length > MAX_IP_LENGTH) {
    return false;
  }
  if (IPV4.test(value)) {
    return value.split(".").every((part) => Number(part) <= 255);
  }
  return value.includes(":") && IPV6_CHARACTERS.test(value);
}

/** A year the database holds without an error (a read is about the last months, not the year 275760). */
const MIN_YEAR = 2000;
const MAX_YEAR = 2200;

function instantOf(value: unknown): Date | null {
  if (typeof value !== "string") {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const year = date.getUTCFullYear();
  return year >= MIN_YEAR && year <= MAX_YEAR ? date : null;
}

const UUID_TEXT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function filterOf(input: { ip?: unknown; user?: unknown }): AccessLogFilter {
  const hasUser = input.user !== undefined && input.user !== null;
  const hasIp = input.ip !== undefined && input.ip !== null;
  if (hasUser === hasIp) {
    throw new InvalidAccessLogRequestError("invalid_filter");
  }
  if (hasUser) {
    const userId = typeof input.user === "string" ? input.user.trim() : "";
    if (!USER_ID.test(userId)) {
      throw new InvalidAccessLogRequestError("invalid_filter");
    }
    return { kind: "user", userId };
  }
  const trimmed = typeof input.ip === "string" ? input.ip.trim() : "";
  // an IPv4 address in its IPv6 form is recorded as IPv4 (the server normalizes it): ask for the form that is stored
  const mapped = IPV4_MAPPED.exec(trimmed);
  const ip = mapped?.[1] ?? trimmed;
  if (!isIpText(ip)) {
    throw new InvalidAccessLogRequestError("invalid_filter");
  }
  return { ip, kind: "ip" };
}

function windowOf(input: { from?: unknown; to?: unknown }): {
  from: Date;
  to: Date;
} {
  const from = instantOf(input.from);
  const to = instantOf(input.to);
  if (
    !(from && to) ||
    to.getTime() <= from.getTime() ||
    to.getTime() - from.getTime() > ACCESS_LOG_MAX_WINDOW_MS
  ) {
    throw new InvalidAccessLogRequestError("invalid_window");
  }
  return { from, to };
}

function pageOf(input: { after?: unknown; limit?: unknown }): {
  after: string | null;
  limit: number;
} {
  const limit = input.limit ?? ACCESS_LOG_DEFAULT_PAGE_SIZE;
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > ACCESS_LOG_MAX_PAGE_SIZE
  ) {
    throw new InvalidAccessLogRequestError("invalid_page");
  }
  const after = input.after ?? null;
  if (after === null) {
    return { after, limit };
  }
  if (typeof after !== "string" || !UUID_TEXT.test(after)) {
    throw new InvalidAccessLogRequestError("invalid_cursor");
  }
  return { after: after.toLowerCase(), limit };
}

/** The request of a read, or the refusal that tells the operator what to fix. */
export function normalizeAccessLogRequest(input: {
  after?: unknown;
  from?: unknown;
  ip?: unknown;
  legalReference?: unknown;
  limit?: unknown;
  to?: unknown;
  user?: unknown;
}): AccessLogRequest {
  if (!isLegalReference(input.legalReference)) {
    throw new InvalidAccessLogRequestError("invalid_reference");
  }
  const filter = filterOf(input);
  const { from, to } = windowOf(input);
  const { after, limit } = pageOf(input);
  return {
    after,
    filter,
    from,
    legalReference: input.legalReference,
    limit,
    to,
  };
}
