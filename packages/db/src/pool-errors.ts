import { logger } from "@polaris/observability/logger";
import { describeError } from "@polaris/observability/wide-event";
import type { Pool, PoolClient } from "pg";

const logPoolError = (error: unknown) => {
  // code and class name only: a driver message can carry the host or a statement
  logger.warn("database_pool_error", describeError(error));
};

/**
 * Keeps a connection error from becoming an uncaught exception. A pool a Worker
 * makes per request is closed after the response, and the driver may still emit
 * "This socket has been closed." (or a server-side termination) on an idle
 * connection or on one checked out, which no pool listener sees: with no listener
 * Node ends the process. A query that fails on a broken connection still rejects.
 */
export function guardPoolErrors<T extends Pick<Pool, "on">>(pool: T): T {
  pool.on("error", logPoolError);
  pool.on("connect", (client: PoolClient) => {
    client.on("error", logPoolError);
  });
  return pool;
}
