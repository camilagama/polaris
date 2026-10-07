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

  return {
    db: drizzle({ client: pool, schema: { rlsPocOperations } }),
    pool,
  };
}
