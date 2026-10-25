import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { guardPoolErrors } from "./pool-errors";

export interface DatabaseOptions {
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
  maxConnections?: number;
}

export function createDatabase(
  connectionString: string,
  options: DatabaseOptions = {}
) {
  const pool = guardPoolErrors(
    new Pool({
      connectionString,
      connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5000,
      idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
      max: options.maxConnections ?? 5,
    })
  );

  return {
    db: drizzle({ client: pool }),
    pool,
  };
}
