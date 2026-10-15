import { createBillingStore } from "@polaris/db/billing-store";
import { createMediaCleanupClient } from "@polaris/db/media-cleanup";
import { app } from "../src/server/app";
import {
  reconcileRemovedMedia,
  reconcileStagedMedia,
} from "../src/server/media-reconciler";
import { runBillingMaintenance } from "../src/server/billing/maintenance";
import type { WorkerBindings } from "../src/server/environment";

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

/** Runs a job so that whatever it throws becomes its failure, never another job's. */
async function isolated(job: () => Promise<unknown[]>): Promise<unknown[]> {
  try {
    return await job();
  } catch (error: unknown) {
    return [error];
  }
}

export default {
  fetch: app.fetch,
  scheduled: async (_controller, env) => {
    // media and billing are independent jobs: one failing never hides the other
    const failures = [
      ...(await isolated(() => runMediaMaintenance(env))),
      ...(await isolated(() => runBillingJobs(env))),
    ];
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "scheduled_maintenance_failed");
    }
  },
} satisfies ExportedHandler<WorkerBindings>;
