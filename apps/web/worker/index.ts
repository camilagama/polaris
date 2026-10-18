import { createBillingStore } from "@polaris/db/billing-store";
import { createMediaCleanupClient } from "@polaris/db/media-cleanup";
import { createPrivacyMaintenanceClient } from "@polaris/db/privacy-maintenance";
import { app } from "../src/server/app";
import {
  reconcileRemovedMedia,
  reconcileStagedMedia,
} from "../src/server/media-reconciler";
import { runBillingMaintenance } from "../src/server/billing/maintenance";
import { runDataExports } from "../src/server/privacy/data-export-job";
import { createRequesterReader } from "../src/server/privacy/data-export-reader";
import { runPrivacyMaintenance } from "../src/server/privacy/maintenance";
import type { WorkerBindings } from "../src/server/environment";
import {
  handleQueueBatch,
  PermanentHandlerError,
  type QueueBatch,
} from "../src/server/queue/consumer";
import { createInMemoryProcessingLedger } from "../src/server/queue/processing-ledger";

/** Closing a connection is best effort: it must not replace what the job found. */
const quietly = (close: () => Promise<unknown>): Promise<unknown> =>
  close().catch(() => undefined);

/** Reclaims what media left behind: unfinished uploads and the objects of removed images. */
async function runMediaMaintenance(env: WorkerBindings): Promise<unknown[]> {
  const mediaBucket = env.MEDIA_BUCKET;
  const connectionString = env.MEDIA_CLEANUP_HYPERDRIVE?.connectionString;
  if (!(mediaBucket && connectionString)) {
    return [new Error("media_staging_reconciler_not_configured")];
  }
  const failures: unknown[] = [];
  let cleanupClient: ReturnType<typeof createMediaCleanupClient>;
  try {
    cleanupClient = createMediaCleanupClient(connectionString);
  } catch (error: unknown) {
    return [error];
  }
  try {
    // The two reconcilers are independent: one failing never hides the other.
    try {
      const report = await reconcileStagedMedia({ cleanupClient, mediaBucket });
      console.info("media_staging_reconciliation_complete", report);
    } catch (error: unknown) {
      failures.push(error);
    }
    try {
      const report = await reconcileRemovedMedia({
        cleanupClient,
        mediaBucket,
      });
      console.info("media_removed_reconciliation_complete", report);
    } catch (error: unknown) {
      failures.push(error);
    }
  } finally {
    await quietly(() => cleanupClient.close());
  }
  return failures;
}

/** Applies the events that were received but not processed, then what time itself causes. */
async function runBillingJobs(env: WorkerBindings): Promise<unknown[]> {
  const connectionString = env.BILLING_HYPERDRIVE?.connectionString;
  if (!connectionString) {
    // billing is not provisioned in this environment yet: nothing to do
    console.warn("billing_maintenance_not_configured");
    return [];
  }
  let store: ReturnType<typeof createBillingStore>;
  try {
    store = createBillingStore(connectionString);
  } catch (error: unknown) {
    return [error];
  }
  try {
    const report = await runBillingMaintenance(store);
    console.info("billing_maintenance_complete", report);
    return [];
  } catch (error: unknown) {
    return [error];
  } finally {
    await quietly(() => store.close());
  }
}

/** The data export job (ADR 0078) on a connection the caller owns; the hourly run and the queue consumer share it. */
function runDataExportsWith(
  env: WorkerBindings,
  client: ReturnType<typeof createPrivacyMaintenanceClient>,
  bucket: NonNullable<WorkerBindings["MEDIA_BUCKET"]>,
  options: { maxExports?: number; sweep?: boolean } = {}
) {
  return runDataExports({
    ...options,
    bucket,
    client,
    now: () => new Date(),
    // opened only when an export is claimed
    readAsRequester: (claimed, operation) =>
      createRequesterReader(env.HYPERDRIVE.connectionString)(
        claimed,
        operation
      ),
  });
}

/**
 * What the privacy role does in the background: marks the closures whose recovery window ended as
 * closed (ADR 0074), then builds the data exports that were asked for and removes the ones whose time
 * is up (ADR 0078). One connection serves both, and one failing never hides the other.
 */
async function runPrivacyJobs(env: WorkerBindings): Promise<unknown[]> {
  const connectionString = env.PRIVACY_HYPERDRIVE?.connectionString;
  if (!connectionString) {
    // the privacy role is not provisioned in this environment yet: nothing to do
    console.warn("privacy_maintenance_not_configured");
    return [];
  }
  let client: ReturnType<typeof createPrivacyMaintenanceClient>;
  try {
    client = createPrivacyMaintenanceClient(connectionString);
  } catch (error: unknown) {
    return [error];
  }
  const failures: unknown[] = [];
  try {
    try {
      const report = await runPrivacyMaintenance(client);
      console.info("privacy_maintenance_complete", report);
    } catch (error: unknown) {
      failures.push(error);
    }
    const bucket = env.MEDIA_BUCKET;
    if (bucket) {
      try {
        const report = await runDataExportsWith(env, client, bucket);
        console.info("data_export_complete", report);
      } catch (error: unknown) {
        failures.push(error);
      }
    } else {
      console.warn("data_export_not_configured");
    }
  } finally {
    await quietly(() => client.close());
  }
  return failures;
}

/** Runs a job so that whatever it throws becomes its failure, never another job's. */
async function isolated(job: () => Promise<unknown[]>): Promise<unknown[]> {
  try {
    return await job();
  } catch (error: unknown) {
    return [error];
  }
}

/**
 * The handler of `data_export.requested` (ADR 0083). The event only says that an export was asked
 * for: the job takes the request from the database by its own claim, as the hourly run does, so a
 * duplicate or a late message finds nothing to do. What it does is start one export without waiting
 * for the hour; the sweep of expired exports stays with the hourly run. Nothing sends this event yet (the dispatcher is PR110), and the hourly run stays.
 */
async function handleDataExportRequested(env: WorkerBindings): Promise<void> {
  const connectionString = env.PRIVACY_HYPERDRIVE?.connectionString;
  const bucket = env.MEDIA_BUCKET;
  if (!(connectionString && bucket)) {
    // not provisioned here: the hourly run reports it too, and a retry would not change it
    throw new PermanentHandlerError("data_export_not_configured");
  }
  const client = createPrivacyMaintenanceClient(connectionString);
  try {
    // one request, and no sweep of expired exports: the hourly run does that
    const report = await runDataExportsWith(env, client, bucket, {
      maxExports: 1,
      sweep: false,
    });
    console.info("data_export_complete", report);
  } finally {
    await quietly(() => client.close());
  }
}

/** One ledger for the isolate: the durable one arrives with the dispatcher (PR110); the handler is idempotent by itself. */
const processingLedger = createInMemoryProcessingLedger();

export default {
  fetch: app.fetch,
  queue: (batch: QueueBatch, env) =>
    handleQueueBatch(batch, {
      handlers: {
        "data_export.requested": () => handleDataExportRequested(env),
      },
      ledger: processingLedger,
    }),
  scheduled: async (_controller, env) => {
    // media, billing and privacy are independent jobs: one failing never hides another
    const failures = [
      ...(await isolated(() => runMediaMaintenance(env))),
      ...(await isolated(() => runBillingJobs(env))),
      ...(await isolated(() => runPrivacyJobs(env))),
    ];
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "scheduled_maintenance_failed");
    }
  },
} satisfies ExportedHandler<WorkerBindings>;
