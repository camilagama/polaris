import type { ClosureNoticeMilestone } from "@polaris/domain/organization/closure-deadlines";
import { Pool } from "pg";
import { guardPoolErrors } from "./pool-errors";

/**
 * What the privacy role does in the background (plan PR101, PR104 and PR107, ADRs 0074, 0078,
 * 0081, 0084 and 0102). It runs under its own database role, which can execute a few functions and read
 * nothing: closing organizations whose recovery window ended, scheduling the purge of the closures that
 * reached D minus 7 days, writing the notices of the milestones that arrived (and reading and settling one for its
 * consumer), the data exports (claim a request, record its files, finish or fail it, expire
 * it, and send its outbox event again while it is still owed; the images of a closed organization's
 * export) and the purges scheduled by the closure period or by an operator.
 */
export interface ClaimedDataExport {
  attempt: number;
  formats: string[];
  id: string;
  /** The run's own token: the reader of a closed organization reads only with it (ADR 0081). */
  leaseToken: string | null;
  /** `active`: read as the person who asked (ADR 0078); `closed`: read by the closed organization's reader. */
  mode: "active" | "closed";
  organizationId: string;
  requestedBy: string;
}

/** What a claim answers, before it is checked: a database before 0085 has no mode and no token. */
interface ClaimedDataExportRow {
  attempt: number;
  formats: string[];
  id: string;
  leaseToken?: string | null;
  mode?: string;
  organizationId: string;
  requestedBy: string;
}

function claimedExport(
  row: ClaimedDataExportRow | null | undefined
): ClaimedDataExport | null {
  if (!row) {
    return null;
  }
  return {
    attempt: row.attempt,
    formats: row.formats,
    id: row.id,
    leaseToken: row.leaseToken ?? null,
    mode: row.mode === "closed" ? "closed" : "active",
    organizationId: row.organizationId,
    requestedBy: row.requestedBy,
  };
}

/** A purge held by this run: `purge` removes storage and rows; `sweep` only looks at the storage again. */
export interface ClaimedOrganizationPurge {
  attempt: number;
  organizationId: string;
  phase: "purge" | "sweep";
}

/** What one call of the automatic schedule did (ADR 0102). */
export interface ScheduledClosurePurges {
  /** Organizations this call put into the purge. */
  scheduled: number;
  /** Organizations the closure period put into the purge in the last 24 hours, this call included. */
  scheduledLastDay: number;
  /** Closed organizations still waiting 30 days after D with no legal hold (left behind). */
  overdue: number;
}

/** What one call of the notices did (ADR 0102, amended). */
export interface RecordedClosureNotices {
  /** Organizations with a milestone due and not yet recorded that this call looked at (at most the limit). */
  organizations: number;
  /** Notices still owed (neither sent, failed nor skipped) 3 days after their date, for a store still in closure. */
  overdue: number;
  /** Notices written to go out, each with its outbox event. */
  recorded: number;
  /** Earlier milestones written together with a later one, which go out in its place. */
  skipped: number;
}

/** What the consumer of `organization.closure_notice` reads to write the e-mail: IDs and dates, never the address. */
export interface ClosureNoticeDelivery {
  /** D, as the organization's calendar shows it (YYYY-MM-DD). */
  deletionDate: string;
  /** The first instant of D in the organization's time zone. */
  deletableFrom: Date;
  /** When the milestone was due (for a notice the support sent again, when it was sent again). */
  dueAt: Date;
  milestone: ClosureNoticeMilestone;
  noticeId: string;
  organizationId: string;
  organizationName: string;
  /** Only for `rescheduled`: the first instant the purge may run after the release of a legal hold. */
  purgeFrom: Date | null;
  recoverUntil: Date;
  /** 0 for the notice of the privacy job; 1, 2... for a `d7` the support sent again. */
  reissue: number;
  requestedAt: Date;
  timeZone: string;
  /** The owner it is for: the address is read from the account when it is sent. */
  userId: string;
}

interface ClosureNoticeDeliveryRow {
  deletableFrom: string;
  deletionDate: string;
  /** Absent from a database before 0091. */
  dueAt?: string;
  milestone: ClosureNoticeMilestone;
  noticeId: string;
  organizationId: string;
  organizationName: string;
  purgeFrom: string | null;
  recoverUntil: string;
  reissue?: number;
  requestedAt: string;
  timezone: string;
  userId: string;
}

/** A notice still owed that the handover sends (ADR 0102, amended): the latest of its cycle. */
export interface OwedClosureNotice {
  noticeId: string;
  organizationId: string;
}

export interface PrivacyMaintenanceClient {
  /**
   * What the notice an event names needs to go out; null when it is not to go out (skipped, sent or failed already,
   * of a cycle the owner undid, or of an organization no longer in closure).
   */
  claimClosureNoticeDelivery: (
    noticeId: string,
    organizationId: string
  ) => Promise<ClosureNoticeDelivery | null>;
  /** Takes the oldest export that is waiting (or whose run stopped); null when there is none. */
  claimDataExport: (leaseSeconds: number) => Promise<ClaimedDataExport | null>;
  /** Takes the oldest due purge (or one whose second sweep did not finish); null when there is none. */
  claimOrganizationPurge: (
    leaseSeconds: number
  ) => Promise<ClaimedOrganizationPurge | null>;
  close: () => Promise<void>;
  /**
   * Takes the one export a queue event names, by ID and organization, under the same rules (not before
   * the delay of a failed run, not past its attempts); null when it is not there to take.
   */
  claimDataExportById: (
    exportId: string,
    organizationId: string,
    leaseSeconds: number
  ) => Promise<ClaimedDataExport | null>;
  completeDataExport: (
    exportId: string,
    validityHours: number
  ) => Promise<{ expiresAt: Date; totalBytes: number }>;
  /** The second sweep found nothing left: the purge is over. */
  completeOrganizationPurgeSweep: (organizationId: string) => Promise<boolean>;
  /** Makes finished and failed exports unavailable when their time is up; returns how many. */
  expireDataExports: (
    failedKeepHours: number,
    limit: number
  ) => Promise<number>;
  /** Fails a run: it is tried again unless `final` or it has used its attempts. Returns whether it is final. */
  failDataExport: (
    exportId: string,
    code: string,
    final: boolean
  ) => Promise<boolean>;
  /** Marks the recovery windows that ended as closed, at most `limit` organizations; returns how many. */
  finalizeExpiredClosures: (limit: number) => Promise<number>;
  /**
   * How many scheduled purges are held back past their time by a live temporary access of the Admin, a renewal still
   * alive or a notice not delivered (the legal hold is not counted), whatever the switch of the automatic purge.
   */
  countPurgesHeldBack: () => Promise<number>;
  /**
   * Schedules the purge of at most `limit` closed organizations whose D minus 7 local days arrived (ADR 0102),
   * skipping one under a legal hold, a live temporary access of the Admin, a cancellation of the Admin in this
   * closure or a renewal still alive.
   */
  scheduleClosedOrganizationPurges: (
    limit: number
  ) => Promise<ScheduledClosurePurges>;
  /**
   * The images of a closed organization's export, for the run that holds it (its export and lease token), after the
   * given asset ID: the reader does not read the storage keys.
   */
  listClosedExportMedia: (
    exportId: string,
    leaseToken: string,
    afterAssetId: string | null,
    limit: number
  ) => Promise<{ assetId: string; byteSize: number; storageKey: string }[]>;
  listDataExportsToDelete: (
    limit: number
  ) => Promise<{ id: string; organizationId: string }[]>;
  /** Every image of a held purge (asset ID and master key), read before the rows go. */
  listOrganizationPurgeMedia: (
    organizationId: string
  ) => Promise<{ id: string; storageKey: string }[]>;
  /**
   * The handover of the notices left unresolved (ADR 0102, amended), only with the e-mail on: for at most `limit`
   * organizations, the latest notice still owed of the current cycle (owed for 15 minutes or more), with the earlier
   * owed ones settled `skipped`.
   */
  listOwedClosureNotices: (limit: number) => Promise<OwedClosureNotice[]>;
  markDataExportFilesDeleted: (exportId: string) => Promise<boolean>;
  /** The notice will not go out, with a short code, once; whether this call changed it. */
  markClosureNoticeFailed: (
    noticeId: string,
    organizationId: string,
    code: string
  ) => Promise<boolean>;
  /** The notice went out, once; whether this call changed it. */
  markClosureNoticeSent: (
    noticeId: string,
    organizationId: string
  ) => Promise<boolean>;
  /**
   * The purge is about to remove its first object from the storage; from now on it cannot be cancelled.
   * Refused (`purge_not_claimed`) when this run no longer holds the purge.
   */
  markOrganizationPurgeStorageTouched: (
    organizationId: string
  ) => Promise<void>;
  /**
   * Writes the tombstone, deletes every row of the tenant, takes the payer out of the billing events and the
   * free text out of the cases, in one transaction. Refused (`legal_hold_active`, `closure_period_not_elapsed`)
   * with nothing removed while a legal hold is in force or the closure is younger than 90 days.
   */
  purgeOrganizationData: (organizationId: string) => Promise<{
    alreadyPurged: boolean;
    pseudonymizedBillingEvents: number;
    deletedRows: number;
    scrubbedTexts: number;
  }>;
  /**
   * Sends back to pending the export events dispatched at least `minAgeSeconds` ago whose export is
   * still owed and may be taken now; returns how many.
   */
  rearmDataExportEvents: (
    minAgeSeconds: number,
    limit: number
  ) => Promise<number>;
  /**
   * Writes the notices of at most `limit` organizations in closure whose milestone arrived (ADR 0102, amended): the
   * latest due one goes out, with its outbox event, and earlier ones are written skipped. Idempotent.
   */
  recordClosureNotices: (limit: number) => Promise<RecordedClosureNotices>;
  recordDataExportFile: (file: {
    exportId: string;
    key: string;
    name: string;
    ordinal: number;
    sizeBytes: number;
  }) => Promise<void>;
  /** A step failed: a short code is written; the purge stays held until its lease ends and a later run tries again. */
  recordOrganizationPurgeFailure: (
    organizationId: string,
    code: string
  ) => Promise<void>;
}

export function createPrivacyMaintenanceClient(
  connectionString: string
): PrivacyMaintenanceClient {
  const pool = guardPoolErrors(
    new Pool({
      connectionString,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 5000,
      max: 1,
    })
  );
  return {
    async claimClosureNoticeDelivery(noticeId, organizationId) {
      const result = await pool.query<{
        delivery: ClosureNoticeDeliveryRow | null;
      }>(
        "SELECT public.claim_closure_notice_delivery($1::uuid, $2::text) AS delivery",
        [noticeId, organizationId]
      );
      const row = result.rows[0]?.delivery;
      if (!row) {
        return null;
      }
      return {
        deletableFrom: new Date(row.deletableFrom),
        deletionDate: row.deletionDate,
        dueAt: new Date(row.dueAt ?? row.requestedAt),
        milestone: row.milestone,
        noticeId: row.noticeId,
        organizationId: row.organizationId,
        organizationName: row.organizationName,
        purgeFrom: row.purgeFrom ? new Date(row.purgeFrom) : null,
        recoverUntil: new Date(row.recoverUntil),
        reissue: Number(row.reissue ?? 0),
        requestedAt: new Date(row.requestedAt),
        timeZone: row.timezone,
        userId: row.userId,
      };
    },
    async claimDataExport(leaseSeconds) {
      const result = await pool.query<{
        claimed: ClaimedDataExportRow | null;
      }>("SELECT public.claim_data_export($1::integer) AS claimed", [
        leaseSeconds,
      ]);
      return claimedExport(result.rows[0]?.claimed);
    },
    async claimOrganizationPurge(leaseSeconds) {
      const result = await pool.query<{
        claimed: ClaimedOrganizationPurge | null;
      }>("SELECT public.claim_organization_purge($1::integer) AS claimed", [
        leaseSeconds,
      ]);
      return result.rows[0]?.claimed ?? null;
    },
    async claimDataExportById(exportId, organizationId, leaseSeconds) {
      const result = await pool.query<{
        claimed: ClaimedDataExportRow | null;
      }>(
        "SELECT public.claim_data_export_by_id($1::uuid, $2::text, $3::integer) AS claimed",
        [exportId, organizationId, leaseSeconds]
      );
      return claimedExport(result.rows[0]?.claimed);
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
    async completeOrganizationPurgeSweep(organizationId) {
      const result = await pool.query<{ completed: boolean }>(
        "SELECT public.complete_organization_purge_sweep($1::text) AS completed",
        [organizationId]
      );
      return result.rows[0]?.completed === true;
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
    async countPurgesHeldBack() {
      const result = await pool.query<{ held_back: number }>(
        "SELECT public.count_purges_held_back() AS held_back"
      );
      return Number(result.rows[0]?.held_back ?? 0);
    },
    async scheduleClosedOrganizationPurges(limit) {
      const result = await pool.query<{
        scheduled: {
          overdue: number;
          scheduled: number;
          scheduledLastDay: number;
        };
      }>(
        "SELECT public.schedule_closed_organization_purges($1::integer) AS scheduled",
        [limit]
      );
      const scheduled = result.rows[0]?.scheduled;
      return {
        scheduled: Number(scheduled?.scheduled ?? 0),
        scheduledLastDay: Number(scheduled?.scheduledLastDay ?? 0),
        overdue: Number(scheduled?.overdue ?? 0),
      };
    },
    async listClosedExportMedia(exportId, leaseToken, afterAssetId, limit) {
      const result = await pool.query<{
        byte_size: number | string;
        id: string;
        storage_key: string;
      }>(
        "SELECT id, byte_size, storage_key FROM public.list_closed_export_media($1::uuid, $2::uuid, $3::uuid, $4::integer)",
        [exportId, leaseToken, afterAssetId, limit]
      );
      return result.rows.map((row) => ({
        assetId: row.id,
        byteSize: Number(row.byte_size),
        storageKey: row.storage_key,
      }));
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
    async listOrganizationPurgeMedia(organizationId) {
      const result = await pool.query<{ id: string; storage_key: string }>(
        "SELECT id, storage_key FROM public.list_organization_purge_media($1::text)",
        [organizationId]
      );
      return result.rows.map((row) => ({
        id: row.id,
        storageKey: row.storage_key,
      }));
    },
    async markDataExportFilesDeleted(exportId) {
      const result = await pool.query<{ marked: boolean }>(
        "SELECT public.mark_data_export_files_deleted($1::uuid) AS marked",
        [exportId]
      );
      return result.rows[0]?.marked === true;
    },
    async listOwedClosureNotices(limit) {
      const result = await pool.query<{
        owed_notice: string;
        owed_organization: string;
      }>(
        "SELECT owed_notice, owed_organization FROM public.list_owed_closure_notices($1::integer)",
        [limit]
      );
      return result.rows.map((row) => ({
        noticeId: row.owed_notice,
        organizationId: row.owed_organization,
      }));
    },
    async markClosureNoticeFailed(noticeId, organizationId, code) {
      const result = await pool.query<{ marked: boolean }>(
        "SELECT public.mark_closure_notice_failed($1::uuid, $2::text, $3::text) AS marked",
        [noticeId, organizationId, code]
      );
      return result.rows[0]?.marked === true;
    },
    async markClosureNoticeSent(noticeId, organizationId) {
      const result = await pool.query<{ marked: boolean }>(
        "SELECT public.mark_closure_notice_sent($1::uuid, $2::text) AS marked",
        [noticeId, organizationId]
      );
      return result.rows[0]?.marked === true;
    },
    async markOrganizationPurgeStorageTouched(organizationId) {
      await pool.query(
        "SELECT public.mark_organization_purge_storage_touched($1::text)",
        [organizationId]
      );
    },
    async purgeOrganizationData(organizationId) {
      const result = await pool.query<{
        purged: {
          alreadyPurged: boolean;
          pseudonymizedBillingEvents: number | string;
          deletedRows: number | string;
          scrubbedTexts: number | string;
        };
      }>("SELECT public.purge_organization_data($1::text) AS purged", [
        organizationId,
      ]);
      const purged = result.rows[0]?.purged;
      if (!purged) {
        throw new Error("organization_not_purged");
      }
      return {
        alreadyPurged: purged.alreadyPurged === true,
        pseudonymizedBillingEvents: Number(purged.pseudonymizedBillingEvents),
        deletedRows: Number(purged.deletedRows),
        scrubbedTexts: Number(purged.scrubbedTexts),
      };
    },
    async rearmDataExportEvents(minAgeSeconds, limit) {
      const result = await pool.query<{ rearmed: number }>(
        "SELECT public.rearm_data_export_events($1::integer, $2::integer) AS rearmed",
        [minAgeSeconds, limit]
      );
      return Number(result.rows[0]?.rearmed ?? 0);
    },
    async recordClosureNotices(limit) {
      const result = await pool.query<{
        recorded: {
          organizations: number;
          overdue: number;
          recorded: number;
          skipped: number;
        };
      }>("SELECT public.record_closure_notices($1::integer) AS recorded", [
        limit,
      ]);
      const recorded = result.rows[0]?.recorded;
      return {
        organizations: Number(recorded?.organizations ?? 0),
        overdue: Number(recorded?.overdue ?? 0),
        recorded: Number(recorded?.recorded ?? 0),
        skipped: Number(recorded?.skipped ?? 0),
      };
    },
    async recordDataExportFile(file) {
      await pool.query(
        "SELECT public.record_data_export_file($1::uuid, $2::integer, $3::text, $4::text, $5::bigint)",
        [file.exportId, file.ordinal, file.name, file.key, file.sizeBytes]
      );
    },
    async recordOrganizationPurgeFailure(organizationId, code) {
      await pool.query(
        "SELECT public.record_organization_purge_failure($1::text, $2::text)",
        [organizationId, code]
      );
    },
  };
}
