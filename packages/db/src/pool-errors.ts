import { logger } from "@polaris/observability/logger";
import { describeError } from "@polaris/observability/wide-event";
import type { Pool, PoolClient } from "pg";

/**
 * The message the Workers runtime gives a pending read of a socket the Worker itself closed. `pg-cloudflare` (1.4.1,
 * the socket `pg` uses inside workerd) keeps a read loop (`_listen`) waiting on the socket; when the client ends
 * (`Terminate`, then `socket.close()`), that read rejects with `TypeError: This socket has been closed.` and the
 * wrapper emits it as an `error` of the connection. A Node socket ends without one, and `pg` drops only
 * `ECONNRESET` and `EPIPE` while ending, so this one reached the listeners below on every pool closed after a request.
 */
const SOCKET_CLOSED_BY_US = "This socket has been closed.";

let closedByUs = 0;

/**
 * How many errors this isolate dropped as the close of a connection it was ending itself: a counter for the request
 * log, not a log line each. Anything else on a connection is still logged.
 */
export function connectionsClosedByUs(): number {
  return closedByUs;
}

function isOwnCloseRead(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "TypeError" &&
    error.message === SOCKET_CLOSED_BY_US
  );
}

/**
 * Keeps a connection error from becoming an uncaught exception. A pool a Worker
 * makes per request is closed after the response, and the driver may still emit
 * a server-side termination on an idle connection or on one checked out, which
 * no pool listener sees: with no listener Node ends the process. A query that
 * fails on a broken connection still rejects.
 *
 * One error is logged once: the pool forwards the error of an idle connection to its own `error` after the
 * connection's listener saw it. The read that fails because this side is ending the connection
 * (`SOCKET_CLOSED_BY_US`) is only counted.
 */
export function guardPoolErrors<T extends Pick<Pool, "on">>(pool: T): T {
  const seen = new WeakSet<object>();
  const ending = new WeakSet<object>();
  const report = (error: unknown, closing: boolean) => {
    if (typeof error === "object" && error !== null) {
      if (seen.has(error)) {
        return;
      }
      seen.add(error);
    }
    if (closing && isOwnCloseRead(error)) {
      closedByUs += 1;
      return;
    }
    // code and class name only: a driver message can carry the host or a statement
    logger.warn("database_pool_error", describeError(error));
  };
  pool.on("error", (error: unknown) => report(error, false));
  pool.on("connect", (client: PoolClient) => {
    const { end } = client;
    // the pool ends a connection through `end` (pool closed, idle timeout, a released broken client)
    client.end = ((...args: Parameters<PoolClient["end"]>) => {
      ending.add(client);
      return end.apply(client, args);
    }) as PoolClient["end"];
    // first in line: the pool's own listener of an idle connection ends it before passing the error on, so only
    // here does `ending` still say whether the end came before the error
    client.prependListener("error", (error: unknown) =>
      report(error, ending.has(client))
    );
  });
  return pool;
}
