import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { authSchema } from "./schema/auth";
import { authSecurityAuditEvents } from "./schema/security-audit";
import { dbPocOperations } from "./schema/poc";
import { organizationSchema } from "./schema/organization";

const databaseSchema = {
  ...authSchema,
  ...organizationSchema,
  authSecurityAuditEvents,
  dbPocOperations,
};

export interface DatabaseOptions {
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
  maxConnections?: number;
}

export function createDatabase(
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
    db: drizzle({ client: pool, schema: databaseSchema }),
    pool,
  };
}
