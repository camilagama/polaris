import { logger } from "@polaris/observability/logger";
import type {
  ClaimedDataExport,
  PrivacyMaintenanceClient,
} from "@polaris/db/privacy-maintenance";
import {
  TenantAuthorizationError,
  type TenantRequestTransaction,
} from "@polaris/db/tenant-transaction";
import {
  EXPORT_LEASE_SECONDS,
  EXPORT_VALIDITY_HOURS,
  type ExportFormat,
  exportFileName,
  FAILED_EXPORT_KEEP_HOURS,
} from "@polaris/domain/privacy/data-export";
import type { MediaBucketBinding } from "../environment";
import {
  buildDataArchive,
  buildImageParts,
  type CollectedExport,
  collectExport,
  ExportTooLargeError,
} from "./data-export-build";
import { deleteObjectsUnderPrefix } from "./storage-prefix";

/** An export takes the Worker for a while: a run takes a few, and the rest wait for the next hour. */
const EXPORTS_PER_RUN = 2;
/** A second export is started only if the first left most of the run: a run that is killed uses up an attempt without failing. */
const SECOND_EXPORT_BUDGET_MS = 4 * 60_000;
const EXPIRY_BATCH = 100;
const DELETE_BATCH = 50;

export interface DataExportReport {
  deleted: number;
  expired: number;
  failed: number;
  ready: number;
}

type ExportClient = Pick<
  PrivacyMaintenanceClient,
  | "claimDataExport"
  | "claimDataExportById"
  | "completeDataExport"
  | "expireDataExports"
  | "failDataExport"
  | "listDataExportsToDelete"
  | "markDataExportFilesDeleted"
  | "recordDataExportFile"
>;

export interface DataExportJobDependencies {
  bucket: Pick<MediaBucketBinding, "delete" | "get" | "list" | "put">;
  client: ExportClient;
  /** Reads and turns the tables into files; tests replace it. */
  collect?: typeof collectExport;
  /**
   * How many requests one run may take (default: the run's own limit). The hourly run passes 0 when
   * the queue path is live (ADR 0084): building archives does not fit the 10 ms of CPU a cron has on
   * the Free plan, so it only sweeps and the queue consumer builds.
   */
  maxExports?: number;
  now: () => Date;
  /**
   * Runs `operation` in a read-only snapshot, as the person who asked, with the same authorization a
   * request of theirs would have. It is the one place the job reads tenant data.
   */
  readAsRequester: <T>(
    claimed: ClaimedDataExport,
    operation: (transaction: TenantRequestTransaction) => Promise<T>
  ) => Promise<T>;
  /**
   * Whether the run also expires the exports whose time is up and removes their files (default
   * true: the hourly run). The queue consumer leaves it to the hourly run, so a message does not
   * repeat the sweep.
   */
  sweep?: boolean;
  /**
   * The one export a queue event names (ADR 0084): the run takes that export, by ID and organization,
   * or nothing (it is done, failed, held by another run or waiting for the delay of a failed run), and
   * never another request. Without it the run takes the oldest requests, as the hourly run does.
   */
  target?: { exportId: string; organizationId: string };
}

function exportObjectPrefix(organizationId: string, exportId: string) {
  return `exports/v1/${organizationId}/${exportId}/`;
}

/** A refusal of authorization means the person can no longer read the data: that is final, not retried. */
function failureOf(error: unknown): { code: string; final: boolean } {
  if (error instanceof ExportTooLargeError) {
    return { code: error.code, final: true };
  }
  if (error instanceof TenantAuthorizationError) {
    return { code: "export_not_authorized", final: true };
  }
  return { code: "export_failed", final: false };
}

async function buildAndStore(
  claimed: ClaimedDataExport,
  dependencies: DataExportJobDependencies
): Promise<void> {
  const { bucket, client, now } = dependencies;
  const formats = claimed.formats as ExportFormat[];
  const generatedAt = now();
  const prefix = exportObjectPrefix(claimed.organizationId, claimed.id);
  // a run that is tried again starts from nothing
  await deleteObjectsUnderPrefix(bucket, prefix);

  const collect = dependencies.collect ?? collectExport;
  const collected: CollectedExport = await dependencies.readAsRequester(
    claimed,
    (transaction) => collect(transaction, claimed.organizationId, formats)
  );

  const store = async (file: {
    bytes: Uint8Array;
    name: string;
    ordinal: number;
  }) => {
    const key = `${prefix}${file.name}`;
    await bucket.put(key, file.bytes, {
      httpMetadata: {
        cacheControl: "private, no-store",
        contentType: "application/zip",
      },
    });
    await client.recordDataExportFile({
      exportId: claimed.id,
      key,
      name: file.name,
      ordinal: file.ordinal,
      sizeBytes: file.bytes.length,
    });
  };

  const { images } = collected;
  await store({
    bytes: buildDataArchive({
      collected,
      exportId: claimed.id,
      formats,
      generatedAt,
      organizationId: claimed.organizationId,
    }),
    name: exportFileName("data", 1, generatedAt),
    ordinal: 1,
  });
  // the data is in storage: it is let go before the images take the memory
  collected.entries.length = 0;
  if (images.length > 0) {
    await buildImageParts({ bucket, generatedAt, images, sink: { store } });
  }
  await client.completeDataExport(claimed.id, EXPORT_VALIDITY_HOURS);
}

/** The export a queue event names, or the oldest one waiting. */
function claimNext(
  client: ExportClient,
  target: DataExportJobDependencies["target"]
): Promise<ClaimedDataExport | null> {
  return target
    ? client.claimDataExportById(
        target.exportId,
        target.organizationId,
        EXPORT_LEASE_SECONDS
      )
    : client.claimDataExport(EXPORT_LEASE_SECONDS);
}

/**
 * The background work of the data exports (ADR 0078): take a request, read the data as the person
 * who asked, store the archives in a private temporary place and finish, or fail it (tried again,
 * up to the attempts it has). Then make the exports whose time is up unavailable and remove their
 * files. A failure of one export never stops the others.
 */
export async function runDataExports(
  dependencies: DataExportJobDependencies
): Promise<DataExportReport> {
  const { bucket, client } = dependencies;
  const startedAt = dependencies.now().getTime();
  const report: DataExportReport = {
    deleted: 0,
    expired: 0,
    failed: 0,
    ready: 0,
  };

  const sweep = dependencies.sweep ?? true;
  if (sweep) {
    report.expired = await client.expireDataExports(
      FAILED_EXPORT_KEEP_HOURS,
      EXPIRY_BATCH
    );
  }
  const toDelete = sweep
    ? await client.listDataExportsToDelete(DELETE_BATCH)
    : [];
  for (const item of toDelete) {
    // biome-ignore lint/performance/noAwaitInLoops: one export at a time; the objects go before the record says they are gone.
    await deleteObjectsUnderPrefix(
      bucket,
      exportObjectPrefix(item.organizationId, item.id)
    );
    if (await client.markDataExportFilesDeleted(item.id)) {
      report.deleted += 1;
    }
  }

  const { target } = dependencies;
  const runs = target ? 1 : (dependencies.maxExports ?? EXPORTS_PER_RUN);
  for (let run = 0; run < runs; run += 1) {
    if (
      run > 0 &&
      dependencies.now().getTime() - startedAt > SECOND_EXPORT_BUDGET_MS
    ) {
      break;
    }
    // biome-ignore lint/performance/noAwaitInLoops: each export needs the one before out of memory.
    const claimed = await claimNext(client, target);
    if (!claimed) {
      break;
    }
    try {
      await buildAndStore(claimed, dependencies);
      report.ready += 1;
    } catch (error: unknown) {
      const failure = failureOf(error);
      logger.warn("data_export_run_failed", {
        attempt: claimed.attempt,
        errorCode: failure.code,
        exportId: claimed.id,
      });
      // recording the failure can fail too (the database, or the export already finished): the next run decides
      const isFinal = await client
        .failDataExport(claimed.id, failure.code, failure.final)
        .catch(() => {
          logger.warn("data_export_failure_not_recorded", {
            exportId: claimed.id,
          });
          return false;
        });
      if (isFinal) {
        report.failed += 1;
        // nothing of a failed export is kept
        await deleteObjectsUnderPrefix(
          bucket,
          exportObjectPrefix(claimed.organizationId, claimed.id)
        ).catch(() => undefined);
      }
    }
  }
  return report;
}
