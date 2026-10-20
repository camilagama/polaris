import { sql } from "drizzle-orm";
import type { createDatabase } from "./client";
import type { ClaimedDataExport } from "./privacy-maintenance";
import {
  TENANT_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  TENANT_LOCK_TIMEOUT_MS,
  TENANT_STATEMENT_TIMEOUT_MS,
  type TenantRequestTransaction,
} from "./tenant-transaction";

type Database = ReturnType<typeof createDatabase>["db"];

/** The role that reads a closed organization's export: SELECT on the export's columns, nothing else (ADR 0081). */
export const CLOSED_EXPORT_READER_ROLE = "polaris_closed_export_reader";

export class ClosedExportLeaseError extends Error {
  readonly code = "closed_export_lease_required";

  constructor() {
    super("closed_export_lease_required");
    this.name = "ClosedExportLeaseError";
  }
}

/**
 * Reads a closed organization's data for the run that holds its export (ADR 0081, amended). The transaction is READ
 * ONLY and REPEATABLE READ (one snapshot for every table), names the export and the run's lease token, and becomes
 * the closed organization's reader for its own duration. The reader has no write privilege, and the database scope
 * answers the organization only inside a read-only transaction that names a closed export still held by this run:
 * anything else reads nothing. The connection is the privacy runtime's, the only role that may become the reader.
 */
export function withClosedExportTransaction<T>(
  database: Database,
  claimed: Pick<ClaimedDataExport, "id" | "leaseToken" | "mode">,
  operation: (transaction: TenantRequestTransaction) => Promise<T>
): Promise<T> {
  if (claimed.mode !== "closed" || !claimed.leaseToken) {
    return Promise.reject(new ClosedExportLeaseError());
  }
  const { leaseToken } = claimed;
  return database.transaction(
    async (transaction) => {
      await transaction.execute(
        sql`SELECT set_config('statement_timeout', ${String(TENANT_STATEMENT_TIMEOUT_MS)}, true),
                   set_config('lock_timeout', ${String(TENANT_LOCK_TIMEOUT_MS)}, true),
                   set_config('idle_in_transaction_session_timeout', ${String(TENANT_IDLE_IN_TRANSACTION_TIMEOUT_MS)}, true),
                   set_config('app.closed_export_id', ${claimed.id}, true),
                   set_config('app.closed_export_lease', ${leaseToken}, true)`
      );
      await transaction.execute(
        sql.raw(`SET LOCAL ROLE ${CLOSED_EXPORT_READER_ROLE}`)
      );
      return await operation(transaction);
    },
    { accessMode: "read only", isolationLevel: "repeatable read" }
  );
}
