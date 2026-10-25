import {
  type RawRefundWindow,
  RefundWindowReadRefusedError,
} from "@polaris/domain/admin/refund-window";
import { BILLING_STATES } from "@polaris/domain/billing/entitlements";
import type { AdminQueryable } from "./platform-principal-repository";

/**
 * The Admin's read of a store's window of the right of withdrawal (ADR 0104, decision 8): one call to
 * `admin_read_refund_window`, a `SECURITY DEFINER` function of the Admin owner that checks the operator and an open
 * case of the same store, writes the platform audit in the same transaction and returns a closed list of keys. The
 * Admin role reads no table. A refusal (`42501`) is one error for every cause and leaves no audit row.
 */

const ACCESS_DENIED = "42501";
const REFUSAL = "refund_window_read_refused";
const METHODS = new Set(["card", "pix_automatic"]);
const STATES = new Set<string>(BILLING_STATES);

/** The database error behind a driver's wrapper: its SQLSTATE and message. */
function databaseError(
  error: unknown
): { code: string; message: string } | undefined {
  const visited = new Set<object>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null) {
    if (visited.has(current)) {
      return;
    }
    visited.add(current);
    const candidate = current as {
      cause?: unknown;
      code?: unknown;
      message?: unknown;
    };
    if (typeof candidate.code === "string" && candidate.code.length === 5) {
      return { code: candidate.code, message: String(candidate.message) };
    }
    current = candidate.cause;
  }
}

function instant(value: unknown): Date | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = typeof value === "string" ? new Date(value) : null;
  if (parsed === null || Number.isNaN(parsed.getTime())) {
    throw new Error("refund_window_unreadable");
  }
  return parsed;
}

export async function readRefundWindow(
  client: AdminQueryable,
  principalId: string,
  caseId: string,
  organizationId: string
): Promise<RawRefundWindow> {
  let answer: Record<string, unknown> | null | undefined;
  try {
    const { rows } = await client.query(
      // `clock_timestamp() AS at` is not read: it makes the statement one a caching pooler cannot answer from a copy,
      // which would skip the audit
      "SELECT public.admin_read_refund_window($1::uuid, $2::uuid, $3::text) AS result, pg_catalog.clock_timestamp() AS at",
      [principalId, caseId, organizationId]
    );
    answer = rows[0]?.result as Record<string, unknown> | null | undefined;
  } catch (error: unknown) {
    // the function's own refusal only: a missing grant is a `42501` too, and that is a failure, not a refusal
    const failure = databaseError(error);
    if (failure?.code === ACCESS_DENIED && failure.message === REFUSAL) {
      // biome-ignore lint/style/useErrorCause: RefundWindowReadRefusedError forwards this cause to Error.
      throw new RefundWindowReadRefusedError({ cause: error });
    }
    throw error;
  }
  const now = instant(answer?.now);
  const state = answer?.state;
  const method = answer?.method ?? null;
  const amount = answer?.firstChargeAmount ?? null;
  if (
    !answer ||
    now === null ||
    typeof state !== "string" ||
    !STATES.has(state) ||
    (method !== null && !(typeof method === "string" && METHODS.has(method))) ||
    (amount !== null && typeof amount !== "string")
  ) {
    throw new Error("refund_window_unreadable");
  }
  return {
    firstChargeAmount: amount,
    firstChargeAt: instant(answer.firstChargeAt),
    method: method as RawRefundWindow["method"],
    now,
    refundRequestedAt: instant(answer.refundRequestedAt),
    state: state as RawRefundWindow["state"],
  };
}
