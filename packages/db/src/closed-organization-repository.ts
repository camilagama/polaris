import {
  CLOSURE_PHASES,
  type ClosurePhase,
} from "@polaris/domain/organization/closure-deadlines";
import {
  DataExportUnavailableError,
  type ExportFormat,
  InvalidExportRequestError,
  normalizeExportFormats,
} from "@polaris/domain/privacy/data-export";
import { sql } from "drizzle-orm";
import type { DataExportDownload } from "./data-export-repository";
import { hasConstraint, raised } from "./database-refusal";
import { TenantAuthorizationError } from "./tenant-transaction";
import { withUserTransaction } from "./user-transaction";

type Database = Parameters<typeof withUserTransaction>[0];

/**
 * The owner of a closed organization (`closing`, `closed` or `purge_pending`): its state and dates, and its copy
 * (ADR 0081 and 0078, amended). Nothing here opens the tenant, which a closed organization does not; every call
 * takes only the authenticated user (a server-verified session) and the database functions check the owner
 * membership themselves. Someone else's organization and one that does not exist answer the same.
 */

const ACCESS_DENIED = "42501";
const NOT_IN_STATE = "55000";
const ONE_IN_FLIGHT = "data_exports_one_in_flight_unique";
const DAILY_LIMIT = "data_exports_daily_limit";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ClosedOrganizationView {
  canRecover: boolean;
  /** D: the first instant the data may be deleted, and the last one to ask for a copy. */
  deletableFrom: Date;
  /** D as the organization's calendar shows it (YYYY-MM-DD). */
  deletionDate: string;
  exportOpenUntil: Date;
  id: string;
  /** The four notices, by date: the request, 30 and 7 days before D, and D. */
  milestones: { closure: Date; d30: Date; d7: Date; deletionDay: Date };
  name: string;
  phase: ClosurePhase;
  recoverUntil: Date;
  requestedAt: Date;
  timezone: string;
}

export interface ClosedDataExportView {
  errorCode: string | null;
  expiresAt: Date | null;
  files: { name: string; ordinal: number; sizeBytes: number }[];
  formats: ExportFormat[];
  id: string;
  mode: "active" | "closed";
  readyAt: Date | null;
  requestedAt: Date;
  status: string;
  totalBytes: number | null;
}

interface ClosedOrganizationRow {
  can_recover: boolean;
  d30_at: Date | string;
  d7_at: Date | string;
  deletable_from: Date | string;
  deletion_date: string;
  export_open_until: Date | string;
  id: string;
  name: string;
  phase: string;
  recover_until: Date | string;
  requested_at: Date | string;
  timezone: string;
}

const COLUMNS = sql.raw(
  "id, name, timezone, phase, requested_at, recover_until, can_recover, deletion_date::text AS deletion_date, d30_at, d7_at, deletable_from, export_open_until"
);

function rows<T>(result: unknown): T[] {
  const candidate = result as { rows?: T[] } | T[];
  return Array.isArray(candidate) ? candidate : (candidate.rows ?? []);
}

function phaseOf(value: string): ClosurePhase {
  const phase = CLOSURE_PHASES.find((candidate) => candidate === value);
  if (!phase) {
    throw new Error("closure_phase_unknown");
  }
  return phase;
}

function toView(row: ClosedOrganizationRow): ClosedOrganizationView {
  const requestedAt = new Date(row.requested_at);
  const deletableFrom = new Date(row.deletable_from);
  return {
    canRecover: row.can_recover,
    deletableFrom,
    deletionDate: row.deletion_date,
    exportOpenUntil: new Date(row.export_open_until),
    id: row.id,
    milestones: {
      closure: requestedAt,
      d30: new Date(row.d30_at),
      d7: new Date(row.d7_at),
      deletionDay: deletableFrom,
    },
    name: row.name,
    phase: phaseOf(row.phase),
    recoverUntil: new Date(row.recover_until),
    requestedAt,
    timezone: row.timezone,
  };
}

function isAccessRefusal(error: unknown): boolean {
  return (
    raised(error, ACCESS_DENIED, "tenant_access_denied") ||
    raised(error, ACCESS_DENIED, "tenant_context_required")
  );
}

/** The closed organizations the user owns, oldest closure first. */
export function listClosedOrganizations(
  database: Database,
  authenticatedUserId: string
): Promise<ClosedOrganizationView[]> {
  return withUserTransaction(
    database,
    authenticatedUserId,
    async (transaction) =>
      rows<ClosedOrganizationRow>(
        await transaction.execute(
          sql`SELECT ${COLUMNS} FROM public.list_my_closed_organizations()`
        )
      ).map(toView)
  );
}

/** One closed organization of the user, or null (someone else's and one that does not exist alike). */
export function getClosedOrganizationStatus(
  database: Database,
  authenticatedUserId: string,
  organizationId: string
): Promise<ClosedOrganizationView | null> {
  return withUserTransaction(
    database,
    authenticatedUserId,
    async (transaction) => {
      const [row] = rows<ClosedOrganizationRow>(
        await transaction.execute(
          sql`SELECT ${COLUMNS} FROM public.closed_organization_status(${organizationId})`
        )
      );
      return row ? toView(row) : null;
    }
  );
}

/** The owner asks for a copy of a closed organization: one at a time, three a day, until D. */
export function requestClosedDataExport(
  database: Database,
  authenticatedUserId: string,
  input: {
    formats: unknown;
    organizationId: string;
    requestId?: string | null;
  }
): Promise<{ id: string }> {
  const formats = normalizeExportFormats(input.formats);
  const requestId =
    input.requestId && UUID.test(input.requestId) ? input.requestId : null;
  return withUserTransaction(
    database,
    authenticatedUserId,
    async (transaction) => {
      try {
        const [row] = rows<{ requested: { id: string } }>(
          await transaction.execute(
            sql`SELECT public.request_closed_data_export(${input.organizationId}, ARRAY[${sql.join(
              formats.map((format) => sql`${format}`),
              sql`, `
            )}]::text[], ${requestId}::uuid) AS requested`
          )
        );
        if (!row) {
          throw new Error("closed_export_not_recorded");
        }
        return { id: row.requested.id };
      } catch (error: unknown) {
        if (isAccessRefusal(error)) {
          // biome-ignore lint/style/useErrorCause: The refusal is the domain's own; the database message only picks it.
          throw new TenantAuthorizationError("tenant_access_denied");
        }
        if (raised(error, NOT_IN_STATE, "closed_export_unavailable")) {
          // biome-ignore lint/style/useErrorCause: The refusal is the domain's own; the database message only picks it.
          throw new InvalidExportRequestError("closed_export_unavailable");
        }
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
  );
}

/** The latest requests of a closed organization the user owns, newest first; empty for any other organization. */
export function listClosedDataExports(
  database: Database,
  authenticatedUserId: string,
  organizationId: string
): Promise<ClosedDataExportView[]> {
  return withUserTransaction(
    database,
    authenticatedUserId,
    async (transaction) =>
      rows<{
        error_code: string | null;
        expires_at: Date | string | null;
        files: { name: string; ordinal: number; sizeBytes: number | string }[];
        formats: string[];
        id: string;
        mode: string;
        ready_at: Date | string | null;
        requested_at: Date | string;
        status: string;
        total_bytes: number | string | null;
      }>(
        await transaction.execute(
          sql`SELECT id, mode, status, formats, requested_at, ready_at, expires_at, error_code, total_bytes, files
                FROM public.list_closed_data_exports(${organizationId})`
        )
      ).map((row) => {
        const expiresAt = row.expires_at ? new Date(row.expires_at) : null;
        // a copy past its time reads as expired before the maintenance job marks it
        const status =
          row.status === "ready" && expiresAt && expiresAt <= new Date()
            ? "expired"
            : row.status;
        return {
          errorCode: row.error_code,
          expiresAt,
          files: row.files.map((file) => ({
            name: file.name,
            ordinal: file.ordinal,
            sizeBytes: Number(file.sizeBytes),
          })),
          formats: row.formats as ExportFormat[],
          id: row.id,
          mode: row.mode === "closed" ? "closed" : "active",
          readyAt: row.ready_at ? new Date(row.ready_at) : null,
          requestedAt: new Date(row.requested_at),
          status,
          totalBytes: row.total_bytes === null ? null : Number(row.total_bytes),
        };
      })
  );
}

/**
 * The file of a closed organization's copy, for its owner; the download is audited. Someone who is not the owner (or
 * an export that does not exist) is `tenant_access_denied`; inside the organization every refusal is the same one.
 */
export function getClosedDataExportDownload(
  database: Database,
  authenticatedUserId: string,
  input: { exportId: string; ordinal: number; requestId?: string | null }
): Promise<DataExportDownload> {
  const requestId =
    input.requestId && UUID.test(input.requestId) ? input.requestId : null;
  return withUserTransaction(
    database,
    authenticatedUserId,
    async (transaction) => {
      try {
        const [file] = rows<{
          name: string;
          size_bytes: number | string;
          storage_key: string;
        }>(
          await transaction.execute(
            sql`SELECT name, storage_key, size_bytes FROM public.closed_export_download(${input.exportId}::uuid, ${input.ordinal}::integer, ${requestId}::uuid)`
          )
        );
        if (!file) {
          throw new DataExportUnavailableError();
        }
        return {
          name: file.name,
          sizeBytes: Number(file.size_bytes),
          storageKey: file.storage_key,
        };
      } catch (error: unknown) {
        if (isAccessRefusal(error)) {
          // biome-ignore lint/style/useErrorCause: The refusal is the domain's own; the database message only picks it.
          throw new TenantAuthorizationError("tenant_access_denied");
        }
        if (raised(error, NOT_IN_STATE, "export_unavailable")) {
          // biome-ignore lint/style/useErrorCause: The refusal is the domain's own; the database message only picks it.
          throw new DataExportUnavailableError();
        }
        throw error;
      }
    }
  );
}
