import { sql } from "drizzle-orm";
import type { createRlsPocDatabase } from "./rls-poc-client";

type Database = ReturnType<typeof createRlsPocDatabase>["db"];
export type TenantTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

/**
 * Runs every callback statement in one explicit transaction with a
 * transaction-local organization context. The caller must authorize the
 * organization before calling this function.
 */
export function withTenantTransaction<T>(
  database: Database,
  organizationId: string,
  operation: (transaction: TenantTransaction) => Promise<T>
): Promise<T> {
  return database.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT set_config('app.organization_id', ${organizationId}, true)`
    );

    return operation(transaction);
  });
}
