import { createMediaCleanupClient } from "@polaris/db/media-cleanup";
import { app } from "../src/server/app";
import { reconcileStagedMedia } from "../src/server/media-reconciler";
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
    try {
      const report = await reconcileStagedMedia({
        cleanupClient,
        mediaBucket,
      });
      console.info("media_staging_reconciliation_complete", report);
    } finally {
      await cleanupClient.close();
    }
  },
} satisfies ExportedHandler<WorkerBindings>;
