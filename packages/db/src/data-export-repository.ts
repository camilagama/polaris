import {
  DataExportUnavailableError,
  type ExportFormat,
  InvalidExportRequestError,
  isExportAvailable,
  normalizeExportFormats,
} from "@polaris/domain/privacy/data-export";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { dataExportFiles, dataExports } from "./schema/data-export";
import { recordTenantAuditEvent } from "./tenant-audit";
import {
  TenantAuthorizationError,
  type TenantRequestIdentity,
  type TenantRequestTransaction,
} from "./tenant-transaction";

/**
 * Asking for and downloading a copy of the organization's data (plan PR104, ADR 0078). The tenant
 * role only reads the requests and inserts a new one: building the files and every later change of
 * state belong to the privacy role's functions. Both asking and downloading are audited.
 */

const CAPABILITY = "organization:export";
const LISTED_EXPORTS = 10;
const ONE_IN_FLIGHT = "data_exports_one_in_flight_unique";
const DAILY_LIMIT = "data_exports_daily_limit";

export interface DataExportFileView {
  name: string;
  ordinal: number;
  sizeBytes: number;
}

export interface DataExportView {
  errorCode: string | null;
  expiresAt: Date | null;
  files: DataExportFileView[];
  formats: ExportFormat[];
  id: string;
  readyAt: Date | null;
  requestedAt: Date;
  status: string;
  totalBytes: number | null;
}

function requireCapability(identity: TenantRequestIdentity) {
  if (identity.capability !== CAPABILITY) {
    throw new TenantAuthorizationError("capability_denied");
  }
}

function hasConstraint(error: unknown, constraint: string): boolean {
  const seen = new Set<object>();
  let current: unknown = error;
  while (
    typeof current === "object" &&
    current !== null &&
    !seen.has(current)
  ) {
    seen.add(current);
    const candidate = current as { cause?: unknown; constraint?: unknown };
    if (candidate.constraint === constraint) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

/** The owner asks for a copy. One at a time, and at most three a day. */
export async function requestDataExport(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: { formats: unknown; requestId?: string | null }
): Promise<{ id: string }> {
  requireCapability(identity);
  const formats = normalizeExportFormats(input.formats);
  try {
    // only the columns the tenant role may insert are named: the rest are the table's own defaults
    const result = await transaction.execute(sql`
      INSERT INTO public.data_exports (organization_id, requested_by_user_id, formats)
      VALUES (${identity.organizationId}, ${identity.userId}, ARRAY[${sql.join(
        formats.map((format) => sql`${format}`),
        sql`, `
      )}]::text[])
      RETURNING id
    `);
    const created = result.rows[0] as { id: string } | undefined;
    if (!created) {
      throw new Error("data_export_not_recorded");
    }
    await recordTenantAuditEvent(transaction, identity, {
      entityId: created.id,
      entityType: "data_export",
      eventType: "data_export.requested",
      requestId: input.requestId ?? null,
    });
    return { id: created.id };
  } catch (error: unknown) {
    if (hasConstraint(error, ONE_IN_FLIGHT)) {
      // biome-ignore lint/style/useErrorCause: The refusal is the domain's own; the constraint name only picks it.
      throw new InvalidExportRequestError("export_already_running");
    }
    if (hasConstraint(error, DAILY_LIMIT)) {
      // biome-ignore lint/style/useErrorCause: The refusal is the domain's own; the constraint name only picks it.
      throw new InvalidExportRequestError("export_limit_reached");
    }
    throw error;
  }
}

/** The latest requests of the organization, newest first, with the files of the ones that are ready. */
export async function listDataExports(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity
): Promise<DataExportView[]> {
  requireCapability(identity);
  const exportRows = await transaction
    .select()
    .from(dataExports)
    .where(eq(dataExports.organizationId, identity.organizationId))
    .orderBy(desc(dataExports.requestedAt), desc(dataExports.id))
    .limit(LISTED_EXPORTS);
  if (exportRows.length === 0) {
    return [];
  }
  const fileRows = await transaction
    .select()
    .from(dataExportFiles)
    .where(
      and(
        eq(dataExportFiles.organizationId, identity.organizationId),
        sql`${dataExportFiles.exportId} IN (${sql.join(
          exportRows.map((row) => sql`${row.id}::uuid`),
          sql`, `
        )})`
      )
    )
    .orderBy(asc(dataExportFiles.exportId), asc(dataExportFiles.ordinal));
  const now = new Date();
  return exportRows.map((row) => {
    // a request past its time reads as expired even before the maintenance job marks it
    const available = isExportAvailable(row.status, row.expiresAt, now);
    const status =
      row.status === "ready" && !available ? "expired" : row.status;
    return {
      errorCode: row.errorCode,
      expiresAt: row.expiresAt,
      files: available
        ? fileRows
            .filter((file) => file.exportId === row.id)
            .map((file) => ({
              name: file.name,
              ordinal: file.ordinal,
              sizeBytes: file.sizeBytes,
            }))
        : [],
      formats: row.formats as ExportFormat[],
      id: row.id,
      readyAt: row.readyAt,
      requestedAt: row.requestedAt,
      status,
      totalBytes: row.totalBytes,
    };
  });
}

export interface DataExportDownload {
  name: string;
  sizeBytes: number;
  storageKey: string;
}

/** The file to hand over, if the export is ready and has not expired. The download is audited. */
export async function getDataExportDownload(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: { exportId: string; ordinal: number; requestId?: string | null }
): Promise<DataExportDownload> {
  requireCapability(identity);
  const [row] = await transaction
    .select({
      expiresAt: dataExports.expiresAt,
      id: dataExports.id,
      status: dataExports.status,
    })
    .from(dataExports)
    .where(
      and(
        eq(dataExports.id, input.exportId),
        eq(dataExports.organizationId, identity.organizationId)
      )
    )
    .limit(1);
  if (!(row && isExportAvailable(row.status, row.expiresAt, new Date()))) {
    throw new DataExportUnavailableError();
  }
  const [file] = await transaction
    .select({
      name: dataExportFiles.name,
      sizeBytes: dataExportFiles.sizeBytes,
      storageKey: dataExportFiles.storageKey,
    })
    .from(dataExportFiles)
    .where(
      and(
        eq(dataExportFiles.exportId, row.id),
        eq(dataExportFiles.ordinal, input.ordinal),
        eq(dataExportFiles.organizationId, identity.organizationId)
      )
    )
    .limit(1);
  if (!file) {
    throw new DataExportUnavailableError();
  }
  await recordTenantAuditEvent(transaction, identity, {
    entityId: row.id,
    entityType: "data_export",
    eventType: "data_export.downloaded",
    requestId: input.requestId ?? null,
  });
  return file;
}
