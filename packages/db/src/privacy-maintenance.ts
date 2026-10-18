import { Pool } from "pg";

/**
 * What the privacy role does in the background (plan PR101 and PR104, ADRs 0074 and 0078).
 * It runs under its own database role, which can execute a few functions and read nothing:
 * closing organizations whose recovery window ended, and the data exports (claim a request,
 * record its files, finish or fail it, expire it).
 */
export interface ClaimedDataExport {
  attempt: number;
  formats: string[];
  id: string;
  organizationId: string;
  requestedBy: string;
}

export interface PrivacyMaintenanceClient {
  close: () => Promise<void>;
  /** Takes the oldest export that is waiting (or whose run stopped); null when there is none. */
  claimDataExport: (leaseSeconds: number) => Promise<ClaimedDataExport | null>;
  completeDataExport: (
    exportId: string,
    validityHours: number
  ) => Promise<{ expiresAt: Date; totalBytes: number }>;
  /** Makes finished and failed exports unavailable when their time is up; returns how many. */
  expireDataExports: (
    failedKeepHours: number,
    limit: number
  ) => Promise<number>;
  /** Marks the recovery windows that ended as closed, at most `limit` organizations; returns how many. */
  finalizeExpiredClosures: (limit: number) => Promise<number>;
  /** Fails a run: it is tried again unless `final` or it has used its attempts. Returns whether it is final. */
  failDataExport: (
    exportId: string,
    code: string,
    final: boolean
  ) => Promise<boolean>;
  listDataExportsToDelete: (
    limit: number
  ) => Promise<{ id: string; organizationId: string }[]>;
  markDataExportFilesDeleted: (exportId: string) => Promise<boolean>;
  recordDataExportFile: (file: {
    exportId: string;
    key: string;
    name: string;
    ordinal: number;
    sizeBytes: number;
  }) => Promise<void>;
}

export function createPrivacyMaintenanceClient(
  connectionString: string
): PrivacyMaintenanceClient {
  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 5000,
    max: 1,
  });
  return {
    async claimDataExport(leaseSeconds) {
      const result = await pool.query<{ claimed: ClaimedDataExport | null }>(
        "SELECT public.claim_data_export($1::integer) AS claimed",
        [leaseSeconds]
      );
      const claimed = result.rows[0]?.claimed as
        | {
            attempt: number;
            formats: string[];
            id: string;
            organizationId: string;
            requestedBy: string;
          }
        | null
        | undefined;
      return claimed ?? null;
    },
    async close() {
      await pool.end();
    },
    async completeDataExport(exportId, validityHours) {
      const result = await pool.query<{
        completed: { expiresAt: string; totalBytes: number | string };
      }>(
        "SELECT public.complete_data_export($1::uuid, $2::integer) AS completed",
        [exportId, validityHours]
      );
      const completed = result.rows[0]?.completed;
      if (!completed) {
        throw new Error("export_not_completed");
      }
      return {
        expiresAt: new Date(completed.expiresAt),
        totalBytes: Number(completed.totalBytes),
      };
    },
    async expireDataExports(failedKeepHours, limit) {
      const result = await pool.query<{ expired: number }>(
        "SELECT public.expire_data_exports($1::integer, $2::integer) AS expired",
        [failedKeepHours, limit]
      );
      return Number(result.rows[0]?.expired ?? 0);
    },
    async failDataExport(exportId, code, final) {
      const result = await pool.query<{ failed: { final: boolean } }>(
        "SELECT public.fail_data_export($1::uuid, $2::text, $3::boolean) AS failed",
        [exportId, code, final]
      );
      return result.rows[0]?.failed.final === true;
    },
    async finalizeExpiredClosures(limit) {
      const result = await pool.query<{ finalized: number }>(
        "SELECT public.finalize_expired_closures($1::integer) AS finalized",
        [limit]
      );
      return Number(result.rows[0]?.finalized ?? 0);
    },
    async listDataExportsToDelete(limit) {
      const result = await pool.query<{ id: string; organization_id: string }>(
        "SELECT id, organization_id FROM public.list_data_exports_to_delete($1::integer)",
        [limit]
      );
      return result.rows.map((row) => ({
        id: row.id,
        organizationId: row.organization_id,
      }));
    },
    async markDataExportFilesDeleted(exportId) {
      const result = await pool.query<{ marked: boolean }>(
        "SELECT public.mark_data_export_files_deleted($1::uuid) AS marked",
        [exportId]
      );
      return result.rows[0]?.marked === true;
    },
    async recordDataExportFile(file) {
      await pool.query(
        "SELECT public.record_data_export_file($1::uuid, $2::integer, $3::text, $4::text, $5::bigint)",
        [file.exportId, file.ordinal, file.name, file.key, file.sizeBytes]
      );
    },
  };
}
