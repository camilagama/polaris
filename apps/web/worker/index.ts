import { createBillingStore } from "@polaris/db/billing-store";
import { createMediaCleanupClient } from "@polaris/db/media-cleanup";
import { createOutboxClient } from "@polaris/db/outbox-dispatch";
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
  handleDeadLetterBatch,
  isDeadLetterQueue,
} from "../src/server/queue/dead-letter";
import {
  handleQueueBatch,
  PermanentHandlerError,
  type QueueBatch,
} from "../src/server/queue/consumer";
import { outboxIdempotencyKey } from "@polaris/domain/events/outbox";
import type { QueueEnvelope } from "@polaris/domain/events/queue-envelope";
import { approvedRetention } from "@polaris/domain/privacy/retention";
import { dispatchOutbox } from "../src/server/queue/dispatcher";
import {
  createDurableProcessingLedger,
  createInMemoryProcessingLedger,
} from "../src/server/queue/processing-ledger";

/**
 * The outbox dispatcher's own cron (ADR 0084): an invocation of its own, so its 10 ms of CPU on the
 * Free plan are not shared with the maintenance jobs, two minutes after them (the database is still
 * awake). Its cadence is the scheduler's to change (plan PR112).
 */
const OUTBOX_CRON = "19 * * * *";
/** An export event dispatched this long ago whose export is still owed is sent again (the re-arm). */
const REARM_MIN_AGE_SECONDS = 30 * 60;
const REARM_BATCH = 100;
const PROCESSING_KEEP_HOURS = approvedRetention("queue_processing") / 3_600_000;
const PROCESSING_EXPIRY_BATCH = 500;
/** How many events past the attempt cap one dispatcher run turns into incidents (ADR 0085). */
const EXHAUSTED_BATCH = 100;

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
  return failures;
}

/**
 * The outbox dispatcher and sweeper (ADR 0084): sends the due events (and those whose claim ran out)
 * to their queues and marks them dispatched, then removes the consumer's old processing records.
 */
async function runOutboxJobs(env: WorkerBindings): Promise<unknown[]> {
  const connectionString = env.OUTBOX_HYPERDRIVE?.connectionString;
  if (!connectionString) {
    // the outbox role is not provisioned in this environment yet: the events wait, pending
    console.warn("outbox_dispatch_not_configured");
    return [];
  }
  let client: ReturnType<typeof createOutboxClient>;
  try {
    client = createOutboxClient(connectionString);
  } catch (error: unknown) {
    return [error];
  }
  const failures: unknown[] = [];
  try {
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
      // an event past the attempt cap is no longer claimed: it becomes an incident and a dead event (ADR 0085)
      const recorded =
        await client.recordExhaustedOutboxEvents(EXHAUSTED_BATCH);
      if (recorded > 0) {
        console.warn("outbox_events_exhausted", { recorded });
      }
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
  } finally {
    await quietly(() => client.close());
  }
  return failures;
}

/** Throws what the jobs found: one failure as itself, several together. */
function throwFailures(failures: unknown[], message: string): void {
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, message);
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

/**
 * The dead-letter queue (ADR 0085): its messages become incidents. Without the outbox role there is nowhere to
 * record them, so the messages are retried (the queue keeps them for its retention and its retries).
 */
async function consumeDeadLetters(batch: QueueBatch, env: WorkerBindings) {
  const connectionString = env.OUTBOX_HYPERDRIVE?.connectionString;
  if (!connectionString) {
    console.warn("dead_letter_not_recorded_unconfigured");
    for (const message of batch.messages) {
      message.retry({ delaySeconds: 3600 });
    }
    return;
  }
  const client = createOutboxClient(connectionString);
  try {
    await handleDeadLetterBatch(batch, client);
  } finally {
    await quietly(() => client.close());
  }
}

async function consumeQueue(batch: QueueBatch, env: WorkerBindings) {
  if (isDeadLetterQueue(batch.queue)) {
    await consumeDeadLetters(batch, env);
    return;
  }
  const handlers = {
    "data_export.requested": (envelope: QueueEnvelope) =>
      handleDataExportRequested(env, envelope),
  };
  const connectionString = env.OUTBOX_HYPERDRIVE?.connectionString;
  if (!connectionString) {
    // no check against the outbox and no deduplication across isolates: only the handler's own guards
    console.warn("queue_ledger_in_memory");
    // and no dead-letter queue either: nothing could record what lands there, so a refused message is only dropped
    await handleQueueBatch(batch, { handlers, ledger: inMemoryLedger });
    return;
  }
  // the durable record: shared by every isolate and deploy, and it refuses an event the outbox does not hold
  const client = createOutboxClient(connectionString);
  try {
    await handleQueueBatch(batch, {
      deadLetters: env.QUEUE_DLQ,
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
  scheduled: async (controller, env) => {
    if (controller.cron === OUTBOX_CRON) {
      throwFailures(
        await isolated(() => runOutboxJobs(env)),
        "outbox_jobs_failed"
      );
      return;
    }
    // media, billing and privacy are independent jobs: one failing never hides another
    throwFailures(
      [
        ...(await isolated(() => runMediaMaintenance(env))),
        ...(await isolated(() => runBillingJobs(env))),
        ...(await isolated(() => runPrivacyJobs(env))),
      ],
      "scheduled_maintenance_failed"
    );
  },
} satisfies ExportedHandler<WorkerBindings>;
