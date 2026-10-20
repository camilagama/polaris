import { createDatabase } from "@polaris/db/client";
import { withClosedExportTransaction } from "@polaris/db/closed-export-reader";
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

/**
 * Reads a closed organization's data for its export (ADR 0081): through the privacy runtime's own connection, the only
 * role that may become the closed organization's reader, in a read-only snapshot scoped to the export and the lease
 * this run holds. Nothing here takes a user: the reader sees the organization of the export, and only while the run
 * holds it.
 */
export function createClosedExportReader(
  connectionString: string
): NonNullable<DataExportJobDependencies["readClosedExport"]> {
  return async <T>(
    claimed: ClaimedDataExport,
    operation: (transaction: TenantRequestTransaction) => Promise<T>
  ): Promise<T> => {
    const { db, pool } = createDatabase(connectionString, {
      maxConnections: 1,
    });
    try {
      return await withClosedExportTransaction(db, claimed, operation);
    } finally {
      await pool.end().catch(() => undefined);
    }
  };
}
