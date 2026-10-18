import { createDatabase } from "@polaris/db/client";
import type { ClaimedDataExport } from "@polaris/db/privacy-maintenance";
import {
  type TenantRequestTransaction,
  withAuthorizedTenantTransaction,
} from "@polaris/db/tenant-transaction";
import type { DataExportJobDependencies } from "./data-export-job";

/**
 * Reads tenant data for a data export as the person who asked, through the tenant role: the same
 * authentication-free path a request takes after its session is verified (the user comes from the
 * database row of the request, never from outside), so row-level security and the capability check
 * decide what is read. The snapshot is repeatable-read, so the tables agree with each other.
 */
export function createRequesterReader(
  connectionString: string
): DataExportJobDependencies["readAsRequester"] {
  return async <T>(
    claimed: ClaimedDataExport,
    operation: (transaction: TenantRequestTransaction) => Promise<T>
  ): Promise<T> => {
    const { db, pool } = createDatabase(connectionString, {
      maxConnections: 1,
    });
    try {
      return await withAuthorizedTenantTransaction(
        db,
        {
          authenticatedUserId: claimed.requestedBy,
          capability: "organization:export",
          isolationLevel: "repeatable read",
          requestedOrganizationId: claimed.organizationId,
        },
        (transaction) => operation(transaction)
      );
    } finally {
      await pool.end().catch(() => undefined);
    }
  };
}
