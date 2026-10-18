import { createBillingStore } from "@polaris/db/billing-store";
import { createMediaCleanupClient } from "@polaris/db/media-cleanup";
import {
  createOutboxClient,
  type OutboxClient,
} from "@polaris/db/outbox-dispatch";
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
import { outboxIdempotencyKey } from "@polaris/domain/events/outbox";
import type { QueueEnvelope } from "@polaris/domain/events/queue-envelope";
import { approvedRetention } from "@polaris/domain/privacy/retention";
import { laneOfCron } from "@polaris/domain/scheduling/scheduled-jobs";
import { dispatchOutbox } from "../src/server/queue/dispatcher";
import {
  createDurableProcessingLedger,
  createInMemoryProcessingLedger,
} from "../src/server/queue/processing-ledger";
import {
  type JobHandlers,
  type JobResult,
  runLane,
} from "../src/server/scheduler/runner";

/** An export event dispatched this long ago whose export is still owed is sent again (the re-arm). */
const REARM_MIN_AGE_SECONDS = 30 * 60;
const REARM_BATCH = 100;
const PROCESSING_KEEP_HOURS = approvedRetention("queue_processing") / 3_600_000;
const PROCESSING_EXPIRY_BATCH = 500;

/**
 * The queue path of the data export is live when the outbox role and the default queue are bound: the
 * hourly run then builds nothing (an archive does not fit the cron's 10 ms of CPU on the Free plan) and
 * the queue consumer builds, with up to 30 s of CPU. Without them the hourly run builds, as before.
 */
function queuePathLive(env: WorkerBindings): boolean {
  return Boolean(env.OUTBOX_HYPERDRIVE?.connectionString && env.QUEUE_DEFAULT);
}

/** Closing a connection is best effort: it must not replace what the job found. */
const quietly = (close: () => Promise<unknown>): Promise<unknown> =>
  close().catch(() => undefined);

/** A job that finished: with the failures it found, or none. */
function finished(failures: unknown[]): JobResult {
  return failures.length > 0
    ? { failures, status: "failed" }
    : { status: "completed" };
}

/** A job with nothing to do in this environment: the window stays open, so it runs once it is provisioned. */
const notConfigured: JobResult = {
  reason: "not_configured",
  status: "skipped",
};

/** Reclaims what media left behind: unfinished uploads and the objects of removed images. */
async function runMediaMaintenance(env: WorkerBindings): Promise<JobResult> {
  const mediaBucket = env.MEDIA_BUCKET;
  const connectionString = env.MEDIA_CLEANUP_HYPERDRIVE?.connectionString;
  if (!(mediaBucket && connectionString)) {
    return finished([new Error("media_staging_reconciler_not_configured")]);
  }
  const failures: unknown[] = [];
  let cleanupClient: ReturnType<typeof createMediaCleanupClient>;
  try {
    cleanupClient = createMediaCleanupClient(connectionString);
  } catch (error: unknown) {
    return finished([error]);
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
  return finished(failures);
}

/** Applies the events that were received but not processed, then what time itself causes. */
async function runBillingJobs(env: WorkerBindings): Promise<JobResult> {
  const connectionString = env.BILLING_HYPERDRIVE?.connectionString;
  if (!connectionString) {
    // billing is not provisioned in this environment yet: nothing to do
    console.warn("billing_maintenance_not_configured");
    return notConfigured;
  }
  let store: ReturnType<typeof createBillingStore>;
  try {
    store = createBillingStore(connectionString);
  } catch (error: unknown) {
    return finished([error]);
  }
  try {
    const report = await runBillingMaintenance(store);
    console.info("billing_maintenance_complete", report);
    return finished([]);
  } catch (error: unknown) {
    return finished([error]);
  } finally {
    await quietly(() => store.close());
  }
}

/** The data export job (ADR 0078) on a connection the caller owns; the hourly run and the queue consumer share it. */
function runDataExportsWith(
  env: WorkerBindings,
  client: ReturnType<typeof createPrivacyMaintenanceClient>,
  bucket: NonNullable<WorkerBindings["MEDIA_BUCKET"]>,
  options: {
    maxExports?: number;
    sweep?: boolean;
    target?: { exportId: string; organizationId: string };
  } = {}
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
async function runPrivacyJobs(env: WorkerBindings): Promise<JobResult> {
  const connectionString = env.PRIVACY_HYPERDRIVE?.connectionString;
  if (!connectionString) {
    // the privacy role is not provisioned in this environment yet: nothing to do
    console.warn("privacy_maintenance_not_configured");
    return notConfigured;
  }
  let client: ReturnType<typeof createPrivacyMaintenanceClient>;
  try {
    client = createPrivacyMaintenanceClient(connectionString);
  } catch (error: unknown) {
    return finished([error]);
  }
  const failures: unknown[] = [];
  try {
    try {
      const report = await runPrivacyMaintenance(client);
      console.info("privacy_maintenance_complete", report);
    } catch (error: unknown) {
      failures.push(error);
    }
    const live = queuePathLive(env);
    if (live) {
      // the safety net of the queue path: an export still owed gets its event sent again
      try {
        const rearmed = await client.rearmDataExportEvents(
          REARM_MIN_AGE_SECONDS,
          REARM_BATCH
        );
        console.info("data_export_events_rearmed", { rearmed });
      } catch (error: unknown) {
        failures.push(error);
      }
    }
    const bucket = env.MEDIA_BUCKET;
    if (bucket) {
      try {
        // on the queue path the hourly run only sweeps; the consumer builds
        const report = await runDataExportsWith(
          env,
          client,
          bucket,
          live ? { maxExports: 0 } : {}
        );
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
  return finished(failures);
}

/**
 * The outbox dispatcher and sweeper (ADR 0084): sends the due events (and those whose claim ran out)
 * to their queues and marks them dispatched, then removes the consumer's old processing records. It
 * uses the connection of the tick (the outbox role also keeps the scheduler's state), which the tick
 * closes; there is none where the outbox role is not provisioned.
 */
async function runOutboxJobs(
  env: WorkerBindings,
  client: OutboxClient | null
): Promise<JobResult> {
  if (client === null) {
    // the outbox role is not provisioned in this environment yet: the events wait, pending
    console.warn("outbox_dispatch_not_configured");
    return notConfigured;
  }
  const failures: unknown[] = [];
  try {
    const report = await dispatchOutbox({
      queues: {
        critical: env.QUEUE_CRITICAL,
        default: env.QUEUE_DEFAULT,
        media: env.QUEUE_MEDIA,
      },
      store: client,
    });
    console.info("outbox_dispatch_complete", report);
  } catch (error: unknown) {
    failures.push(error);
  }
  try {
    const removed = await client.expireProcessing(
      PROCESSING_KEEP_HOURS,
      PROCESSING_EXPIRY_BATCH
    );
    console.info("queue_processing_expired", { removed });
  } catch (error: unknown) {
    failures.push(error);
  }
  return finished(failures);
}

/** The jobs of the registry that are enabled, each tied to the code that runs it. */
function jobHandlers(
  env: WorkerBindings,
  outbox: OutboxClient | null
): JobHandlers {
  return {
    "billing.maintenance": () => runBillingJobs(env),
    "media.maintenance": () => runMediaMaintenance(env),
    "outbox.dispatch": () => runOutboxJobs(env, outbox),
    "privacy.maintenance": () => runPrivacyJobs(env),
  };
}

/**
 * One tick of the scheduler (ADR 0086) for the lane of the cron that fired: the lane's due jobs run, each
 * under its lease. The connection of the outbox role serves the scheduler's state and the dispatcher
 * alike; without it every job of the lane runs on every tick, as the crons did before the scheduler.
 */
async function runScheduledTick(
  cron: string | undefined,
  env: WorkerBindings
): Promise<void> {
  const known = laneOfCron(cron);
  if (!known) {
    // an expression this Worker does not declare (a manual trigger): the maintenance, as it always was
    console.warn("scheduler_unknown_cron");
  }
  const lane = known?.id ?? "maintenance";
  const connectionString = env.OUTBOX_HYPERDRIVE?.connectionString;
  const outbox = connectionString ? createOutboxClient(connectionString) : null;
  try {
    await runLane({ handlers: jobHandlers(env, outbox), lane, store: outbox });
  } finally {
    if (outbox) {
      await quietly(() => outbox.close());
    }
  }
}

/**
 * The handler of `data_export.requested` (ADRs 0083 and 0084). The event names an export: the job takes
 * that one, by ID and organization, through the privacy role's own claim (never by the envelope alone),
 * so a duplicate, a late message or one for an export already done, failed or waiting for the delay of a
 * failed run finds nothing to do. A failed build is recorded by the job (it does not throw) and tried
 * again later: the re-arm sends the event again once the delay is over.
 */
async function handleDataExportRequested(
  env: WorkerBindings,
  envelope: QueueEnvelope
): Promise<void> {
  const connectionString = env.PRIVACY_HYPERDRIVE?.connectionString;
  const bucket = env.MEDIA_BUCKET;
  if (!(connectionString && bucket)) {
    // not provisioned here: the hourly run reports it too, and a retry would not change it
    throw new PermanentHandlerError("data_export_not_configured");
  }
  const { exportId } = envelope.event;
  // the export the body names must be the one the outbox key (checked against the outbox) names
  if (
    typeof exportId !== "string" ||
    envelope.idempotencyKey !== outboxIdempotencyKey(envelope.type, exportId)
  ) {
    throw new PermanentHandlerError("data_export_event_invalid");
  }
  const client = createPrivacyMaintenanceClient(connectionString);
  try {
    // that export only, and no sweep of expired exports: the hourly run does that
    const result = await runDataExportsWith(env, client, bucket, {
      sweep: false,
      target: { exportId, organizationId: envelope.organizationId },
    });
    console.info("data_export_complete", result);
  } finally {
    await quietly(() => client.close());
  }
}

/** The ledger of an isolate without the outbox role (local development, or before it is provisioned). */
const inMemoryLedger = createInMemoryProcessingLedger();

async function consumeQueue(batch: QueueBatch, env: WorkerBindings) {
  const handlers = {
    "data_export.requested": (envelope: QueueEnvelope) =>
      handleDataExportRequested(env, envelope),
  };
  const connectionString = env.OUTBOX_HYPERDRIVE?.connectionString;
  if (!connectionString) {
    // no check against the outbox and no deduplication across isolates: only the handler's own guards
    console.warn("queue_ledger_in_memory");
    await handleQueueBatch(batch, { handlers, ledger: inMemoryLedger });
    return;
  }
  // the durable record: shared by every isolate and deploy, and it refuses an event the outbox does not hold
  const client = createOutboxClient(connectionString);
  try {
    await handleQueueBatch(batch, {
      handlers,
      ledger: createDurableProcessingLedger(client),
    });
  } finally {
    await quietly(() => client.close());
  }
}

export default {
  fetch: app.fetch,
  queue: (batch: QueueBatch, env) => consumeQueue(batch, env),
  scheduled: (controller, env) => runScheduledTick(controller.cron, env),
} satisfies ExportedHandler<WorkerBindings>;
