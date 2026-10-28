import { type LogFields, logger } from "@polaris/observability/logger";

/**
 * The log of the reports of errors of the browser (`POST /api/client-errors`), with a budget per isolate: the route is
 * public, so a flood of false reports must not spend the quota of the Workers Logs that the server's own events
 * share (ADR 0094).
 *
 * - The first report of each signature is one `client_error` line; the repeats only add to a counter, which leaves
 *   as one `client_error_count` line per signature for the minute.
 * - At most `CLIENT_ERROR_LINES_PER_MINUTE` of those lines per minute per isolate, and `CLIENT_ERROR_SIGNATURES_KEPT`
 *   signatures in memory: what does not fit is counted in one `client_error_dropped` line for the minute.
 * - A refused request (the rate limit, a 400, a 413, a 415) is never a line of its own: one `client_error_refused`
 *   line for the minute counts them by reason, and one `client_error_pii_suspected` counts the events the redaction
 *   net discarded.
 *
 * The signature goes out as `fingerprint`: `signature` is a word of a secret for the redaction policy of the logs,
 * which would mask it.
 *
 * The lines of a minute leave with the first request of the route after it ends (an isolate has no timer between
 * requests); an isolate that dies first loses them, which only undercounts.
 */

export const CLIENT_ERROR_LINES_PER_MINUTE = 20;
export const CLIENT_ERROR_SIGNATURES_KEPT = 200;

export type ClientErrorRefusal =
  | "bad_request"
  | "limiter_unavailable"
  | "rate_limited"
  | "too_large"
  | "unsupported";

const MINUTE_MS = 60_000;

export interface ClientErrorLog {
  /** An event that passed every check: its line the first time, a count after. */
  accepted: (signature: string, fields: LogFields) => void;
  /** An event the redaction net discarded. */
  piiSuspected: () => void;
  /** A request refused before it was an event. */
  refused: (reason: ClientErrorRefusal) => void;
}

export function createClientErrorLog(
  now: () => number = Date.now
): ClientErrorLog {
  let window = Math.floor(now() / MINUTE_MS);
  let lines = 0;
  /** Each signature already logged, with its repeats in the current minute. */
  const seen = new Map<string, number>();
  const refusals = new Map<ClientErrorRefusal, number>();
  let dropped = 0;
  let pii = 0;

  const roll = () => {
    const current = Math.floor(now() / MINUTE_MS);
    if (current === window) {
      return;
    }
    const minute = new Date(window * MINUTE_MS).toISOString();
    window = current;
    lines = 0;
    for (const [signature, count] of seen) {
      if (count === 0) {
        continue;
      }
      seen.set(signature, 0);
      if (lines < CLIENT_ERROR_LINES_PER_MINUTE) {
        lines += 1;
        logger.info("client_error_count", {
          count,
          fingerprint: signature,
          minute,
        });
      } else {
        dropped += count;
      }
    }
    if (refusals.size > 0) {
      logger.info("client_error_refused", {
        minute,
        ...Object.fromEntries(refusals),
      });
      refusals.clear();
    }
    if (pii > 0) {
      logger.warn("client_error_pii_suspected", { count: pii, minute });
      pii = 0;
    }
    if (dropped > 0) {
      logger.warn("client_error_dropped", { count: dropped, minute });
      dropped = 0;
    }
  };

  return {
    accepted(signature, fields) {
      roll();
      const repeats = seen.get(signature);
      if (repeats !== undefined) {
        seen.set(signature, repeats + 1);
        return;
      }
      if (
        seen.size >= CLIENT_ERROR_SIGNATURES_KEPT ||
        lines >= CLIENT_ERROR_LINES_PER_MINUTE
      ) {
        dropped += 1;
        return;
      }
      seen.set(signature, 0);
      lines += 1;
      logger.warn("client_error", { ...fields, fingerprint: signature });
    },
    piiSuspected() {
      roll();
      pii += 1;
    },
    refused(reason) {
      roll();
      refusals.set(reason, (refusals.get(reason) ?? 0) + 1);
    },
  };
}
