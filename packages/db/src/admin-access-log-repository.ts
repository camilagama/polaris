import type {
  AccessLogRefusal,
  AccessLogRequest,
} from "@polaris/domain/admin/access-log";
import type { AdminQueryable } from "./platform-principal-repository";

/**
 * The Admin's read of the access log (ADR 0092): one call to a database function. The Admin role reads no table;
 * the function belongs to the owner of the log, checks the operator, the case number in the CNJ format, the one
 * filter, the window and the page, and writes the platform audit in the same transaction (the filter kind, the case
 * number and the row count; never the IP). A refusal comes as a result code and writes nothing.
 */

export interface AccessLogEntryView {
  event: "login_failed" | "login_succeeded" | "logout" | "session_refreshed";
  id: string;
  ip: string;
  occurredAt: string;
  requestId: string;
  userId: string | null;
}

export type AccessLogReadResult =
  | { entries: AccessLogEntryView[]; next: string | null; result: "ok" }
  | { result: AccessLogRefusal };

const REFUSALS = new Set<string>([
  "invalid_cursor",
  "invalid_filter",
  "invalid_page",
  "invalid_reference",
  "invalid_window",
]);
const INVALID_TEXT_REPRESENTATION = "22P02";

function sqlState(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

export async function readAuthAccessLog(
  client: AdminQueryable,
  principalId: string,
  request: AccessLogRequest
): Promise<AccessLogReadResult> {
  try {
    const { rows } = await client.query(
      // `clock_timestamp() AS at` is not read: it makes the statement one a caching pooler cannot answer from a copy,
      // which would skip the audit
      "SELECT public.admin_read_auth_access_log($1::uuid, $2::text, $3::text, $4::inet, $5::timestamptz, $6::timestamptz, $7::integer, $8::uuid) AS result, pg_catalog.clock_timestamp() AS at",
      [
        principalId,
        request.legalReference,
        request.filter.kind === "user" ? request.filter.userId : null,
        request.filter.kind === "ip" ? request.filter.ip : null,
        request.from.toISOString(),
        request.to.toISOString(),
        request.limit,
        request.after,
      ]
    );
    const answer = rows[0]?.result as
      | { entries?: unknown; next?: unknown; result?: unknown }
      | null
      | undefined;
    if (answer?.result === "ok" && Array.isArray(answer.entries)) {
      return {
        entries: answer.entries as AccessLogEntryView[],
        next: typeof answer.next === "string" ? answer.next : null,
        result: "ok",
      };
    }
    if (typeof answer?.result === "string" && REFUSALS.has(answer.result)) {
      return { result: answer.result as AccessLogRefusal };
    }
    throw new Error("access_log_unreadable");
  } catch (error: unknown) {
    // an IP the database cannot parse is a wrong filter, not a failure
    if (sqlState(error) === INVALID_TEXT_REPRESENTATION) {
      return { result: "invalid_filter" };
    }
    throw error;
  }
}
