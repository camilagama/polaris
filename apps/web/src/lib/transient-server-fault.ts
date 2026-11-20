/**
 * The criterion of "the Worker's own 5xx that another try may fix", in one leaf module: `connection.ts` (the breaker
 * reads it from the body of the response) and `rpc-error.ts` (the retry of the reads reads it from the oRPC error)
 * both import it, and neither can import the other without a cycle. It imports nothing.
 */

/** The `data.reason` of the 503 the router gives an unexpected fault: "try again" (`unexpectedRpcError`). */
export const TRANSIENT_REASON = "server_busy";

/**
 * `SERVICE_UNAVAILABLE` with no reason or with the transient one (one with another reason, like
 * `billing_not_configured`, is an answer), or a 5xx with no reason of its own (the 500 of an error nobody named). A 4xx
 * is the server's answer, and so is a 429.
 */
export function isTransientServerFault(fault: {
  code: unknown;
  reason: string | undefined;
  status: unknown;
}): boolean {
  if (fault.code === "SERVICE_UNAVAILABLE") {
    return fault.reason === undefined || fault.reason === TRANSIENT_REASON;
  }
  return (
    typeof fault.status === "number" &&
    fault.status >= 500 &&
    fault.reason === undefined
  );
}
