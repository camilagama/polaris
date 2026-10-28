import { type LogFields, logger } from "@polaris/observability/logger";

/**
 * The log of the reports of errors of the browser (`POST /api/client-errors`), with a budget per isolate: the route is
 * public, so a flood of false reports must not spend the quota of the Workers Logs that the server's own events
 * share (ADR 0094).
 *
 * - The first report of each signature is one `client_error` line; the repeats only add to a counter, which leaves
 *   as one `client_error_count` line per signature for the minute.
 * - At most `CLIENT_ERROR_LINES_PER_MINUTE` of those lines per minute per isolate (the counts take at most
 *   `COUNT_LINES_PER_MINUTE` of them, so a new signature always has room), and `CLIENT_ERROR_SIGNATURES_KEPT`
 *   signatures in memory, each kept while it had a report in the last `CLIENT_ERROR_SIGNATURE_IDLE_MINUTES`: what
 *   does not fit is counted in one `client_error_dropped` line for the minute.
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
/** Of the lines of a minute, the ones the counts of the minute before may take: the rest is for signatures new. */
const COUNT_LINES_PER_MINUTE = 15;
export const CLIENT_ERROR_SIGNATURES_KEPT = 200;
/**
 * A signature with no report for this long leaves the memory (and its next report is a first line again): false
 * signatures cannot hold the table full and hide the next real failure for the life of the isolate.
 */
export const CLIENT_ERROR_SIGNATURE_IDLE_MINUTES = 30;

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

interface Seen {
  /** Repeats in the current minute. */
  count: number;
  /** The minute of the last report. */
  last: number;
}

export function createClientErrorLog(
  now: () => number = Date.now
): ClientErrorLog {
  let window = Math.floor(now() / MINUTE_MS);
  let lines = 0;
  /** Each signature already logged, with its repeats in the current minute and the minute of its last report. */
  const seen = new Map<string, Seen>();
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
    for (const [signature, entry] of seen) {
      if (current - entry.last > CLIENT_ERROR_SIGNATURE_IDLE_MINUTES) {
        seen.delete(signature);
      }
      if (entry.count === 0) {
        continue;
      }
      const { count } = entry;
      entry.count = 0;
      if (lines < COUNT_LINES_PER_MINUTE) {
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
      const entry = seen.get(signature);
      if (entry !== undefined) {
        entry.count += 1;
        entry.last = window;
        return;
      }
      if (
        seen.size >= CLIENT_ERROR_SIGNATURES_KEPT ||
        lines >= CLIENT_ERROR_LINES_PER_MINUTE
      ) {
        dropped += 1;
        return;
      }
      seen.set(signature, { count: 0, last: window });
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
