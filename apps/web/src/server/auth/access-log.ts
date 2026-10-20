import { isIP } from "node:net";
import { logger } from "@polaris/observability/logger";
import { describeError, isSqlState } from "@polaris/observability/wide-event";
import { getIp } from "better-auth/api";

/**
 * The record of access to the application (ADR 0092): the server of authentication appends one row per login,
 * failed login, logout and refresh of a session, with the IP of the request, for the 6 months of the Marco Civil,
 * art. 15. Writing it must never break a login: the writer answers `false` and logs `auth_access_log_write_failed`
 * (request ID, kind of failure and SQLSTATE only, never the IP or the user), and it gives up after a short time limit.
 */

export type AccessLogEvent =
  | "login_failed"
  | "login_succeeded"
  | "logout"
  | "session_refreshed";

export interface AccessLogEntry {
  event: AccessLogEvent;
  /** The full address of the request; `null` when the edge sent none (the entry is then skipped). */
  ip: string | null;
  requestId: string;
  /** `null` only for a failed login. */
  userId: string | null;
}

/** Resolves `true` when the access is on record (or was deliberately not repeated); never rejects. */
export type AccessLogWriter = (entry: AccessLogEntry) => Promise<boolean>;

/** The query surface of `pg.Pool` that the writer uses. */
export interface AccessLogQueryable {
  query: (config: {
    query_timeout: number;
    text: string;
    values: unknown[];
  }) => Promise<{ rows: { result?: unknown }[] }>;
}

/** The time a login waits for the record, at most. */
const ACCESS_LOG_WRITE_TIMEOUT_MS = 300;

const RESULT_CODE_PATTERN = /^[a-z_]{1,40}$/;
const CLIENT_IP_HEADER = "cf-connecting-ip";
const QUERY_TIMEOUT_MESSAGE = "Query read timeout";

/**
 * The IP of the request, as Cloudflare put it in `cf-connecting-ip` (the only header trusted, see
 * `betterAuthSecurityOptions`), or `null`. Unlike the IP Better Auth keeps in the session row, an IPv6 address
 * is kept whole (the session row and the rate limiter use its /64 network): the Marco Civil asks for the address.
 */
export function requestIp(headers: Headers | undefined | null): string | null {
  const raw = headers?.get(CLIENT_IP_HEADER)?.trim();
  if (!raw || raw.includes("%") || isIP(raw) === 0) {
    return null;
  }
  return getIp(new Headers({ [CLIENT_IP_HEADER]: raw }), {
    advanced: {
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER], ipv6Subnet: 128 },
    },
  });
}

/** The IP as Better Auth stores it in the session row (an IPv6 address becomes its /64 network). */
export function requestIpForSessionRow(
  headers: Headers | undefined | null
): string | null {
  const raw = headers?.get(CLIENT_IP_HEADER)?.trim();
  if (!raw || raw.includes("%") || isIP(raw) === 0) {
    return null;
  }
  return getIp(new Headers({ [CLIENT_IP_HEADER]: raw }), {
    advanced: { ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] } },
  });
}

function logFailure(
  entry: AccessLogEntry,
  reason: string,
  error?: unknown
): void {
  const described = error === undefined ? undefined : describeError(error);
  logger.error("auth_access_log_write_failed", {
    accessEvent: entry.event,
    errorClass: described?.errorClass,
    reason,
    requestId: entry.requestId,
    sqlState: isSqlState(described?.errorCode)
      ? described?.errorCode
      : undefined,
  });
}

/**
 * A writer that never rejects, whatever it is: an injected writer that throws would otherwise take a login down with
 * it. The failure is logged like any other (class and SQLSTATE only) and the answer is `false`.
 */
export function guardAccessLogWriter(writer: AccessLogWriter): AccessLogWriter {
  return async (entry) => {
    try {
      return await writer(entry);
    } catch (error) {
      logFailure(entry, "writer_threw", error);
      return false;
    }
  };
}

/**
 * What the function answered. A session seen again from the same IP is already on record, and one that changes IP more
 * than the limit allows is counted, not written: both are answered as handled, so the session row takes the new IP and
 * the next request is quiet. Any other answer than `recorded` is a failure.
 */
function judgeResult(entry: AccessLogEntry, result: unknown): boolean {
  if (result === "recorded" || result === "duplicate") {
    return true;
  }
  if (result === "rate_limited") {
    logger.warn("auth_access_log_throttled", {
      accessEvent: entry.event,
      requestId: entry.requestId,
    });
    return true;
  }
  logFailure(
    entry,
    typeof result === "string" && RESULT_CODE_PATTERN.test(result)
      ? result
      : "unexpected_result"
  );
  return false;
}

/**
 * The writer over the authentication runtime's connection: it calls `record_auth_access` in a query of its own,
 * outside the transaction of the adapter (the hooks run after the commit), and waits `timeoutMs` at most.
 */
export function createDatabaseAccessLogWriter(
  pool: AccessLogQueryable,
  timeoutMs: number = ACCESS_LOG_WRITE_TIMEOUT_MS
): AccessLogWriter {
  return async (entry) => {
    if (entry.ip === null) {
      logger.warn("auth_access_log_skipped", {
        accessEvent: entry.event,
        reason: "ip_missing",
        requestId: entry.requestId,
      });
      return false;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const query = pool.query({
        query_timeout: timeoutMs,
        text: "SELECT public.record_auth_access($1::text, $2::text, $3::inet, $4::text) AS result",
        values: [entry.event, entry.userId, entry.ip, entry.requestId],
      });
      // a query that loses the race still ends on its own: its failure is not an unhandled rejection
      query.catch(() => undefined);
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      });
      const outcome = await Promise.race([query, timeout]);
      if (outcome === "timeout") {
        logFailure(entry, "timeout");
        return false;
      }
      return judgeResult(entry, outcome.rows[0]?.result);
    } catch (error) {
      // the driver's own limit (the same time as ours) ends the query and drops its connection
      logFailure(
        entry,
        error instanceof Error && error.message === QUERY_TIMEOUT_MESSAGE
          ? "timeout"
          : "error",
        error
      );
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
}
