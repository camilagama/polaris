import { createMediaCleanupClient } from "@polaris/db/media-cleanup";
import { app } from "../src/server/app";
import {
  reconcileRemovedMedia,
  reconcileStagedMedia,
} from "../src/server/media-reconciler";
import type { WorkerBindings } from "../src/server/environment";

export default {
  fetch: app.fetch,
  scheduled: async (_controller, env) => {
    const mediaBucket = env.MEDIA_BUCKET;
    const connectionString = env.MEDIA_CLEANUP_HYPERDRIVE?.connectionString;
    if (!(mediaBucket && connectionString)) {
      throw new Error("media_staging_reconciler_not_configured");
    }

    const cleanupClient = createMediaCleanupClient(connectionString);
    const failures: unknown[] = [];
    try {
      // The two reconcilers are independent: one failing never hides the other.
      try {
        const report = await reconcileStagedMedia({
          cleanupClient,
          mediaBucket,
        });
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
      await cleanupClient.close();
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      // both failed: neither is hidden behind the other
      throw new AggregateError(failures, "media_reconciliation_failed");
    }
  },
} satisfies ExportedHandler<WorkerBindings>;
