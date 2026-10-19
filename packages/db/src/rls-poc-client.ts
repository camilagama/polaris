import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { DatabaseOptions } from "./client";
import { rlsPocOperations } from "./schema/rls-poc";

export function createRlsPocDatabase(
  connectionString: string,
  options: DatabaseOptions = {}
) {
  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5000,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    max: options.maxConnections ?? 5,
  });

  // The retry proof kills a backend on purpose. The client in the middle of
  // that transaction emits the error as well as failing its query; with no
  // listener, Node ends the process. The failed query still rejects. (This
  // also runs in the PR11 Worker; there the listener only keeps the error from
  // surfacing a second time.)
  pool.on("connect", (client) => client.on("error", () => undefined));
  pool.on("error", () => undefined);

  return {
    db: drizzle({ client: pool, schema: { rlsPocOperations } }),
    pool,
  };
}
