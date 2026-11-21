import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { guardPoolErrors } from "./pool-errors";
import { authRelationalSchema } from "./schema/auth";

export interface DatabaseOptions {
  schema?: Record<string, unknown>;
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
    db: drizzle({
      client: pool,
      ...(options.schema ? { schema: options.schema } : {}),
    }),
    pool,
  };
}

export type AuthDatabaseOptions = Omit<DatabaseOptions, "schema">;

/**
 * Every authentication connection needs the relational map: without it Better Auth logs an error and falls back
 * to two statements per session read, which nothing but the statement-count tests notices.
 */
export function createAuthDatabase(
  connectionString: string,
  options: AuthDatabaseOptions = {}
) {
  return createDatabase(connectionString, {
    ...options,
    schema: authRelationalSchema,
  });
}
