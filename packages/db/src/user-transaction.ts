import { sql } from "drizzle-orm";
import type { createDatabase } from "./client";
import {
  TENANT_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  TENANT_LOCK_TIMEOUT_MS,
  TENANT_STATEMENT_TIMEOUT_MS,
  TenantAuthorizationError,
  type TenantRequestTransaction,
} from "./tenant-transaction";

type Database = ReturnType<typeof createDatabase>["db"];

/**
 * A transaction scoped to the authenticated user and to no organization, for
 * rows that belong to the user (devices). The caller must pass the user ID of a
 * server-verified Better Auth session. Row-level security keeps every statement
 * inside that user; an operation that needs organization rows scopes itself
 * explicitly with `scopeToOrganization`, one organization at a time.
 */
export function withUserTransaction<T>(
  database: Database,
  authenticatedUserId: string,
  operation: (transaction: TenantRequestTransaction) => Promise<T>
): Promise<T> {
  if (
    !authenticatedUserId.trim() ||
    authenticatedUserId !== authenticatedUserId.trim()
  ) {
    return Promise.reject(new TenantAuthorizationError("tenant_access_denied"));
  }

  return database.transaction(
    async (transaction) => {
      await transaction.execute(
        sql`SELECT set_config('statement_timeout', ${String(TENANT_STATEMENT_TIMEOUT_MS)}, true),
                   set_config('lock_timeout', ${String(TENANT_LOCK_TIMEOUT_MS)}, true),
                   set_config('idle_in_transaction_session_timeout', ${String(TENANT_IDLE_IN_TRANSACTION_TIMEOUT_MS)}, true)`
      );
      await transaction.execute(
        sql`SELECT set_config('app.user_id', ${authenticatedUserId}, true)`
      );
      return await operation(transaction);
    },
    { isolationLevel: "read committed" }
  );
}

/** Scopes the rest of the transaction to one organization (transaction-local). */
export async function scopeToOrganization(
  transaction: TenantRequestTransaction,
  organizationId: string
): Promise<void> {
  await transaction.execute(
    sql`SELECT set_config('app.organization_id', ${organizationId}, true)`
  );
}
