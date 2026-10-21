import { configureLogging, logger } from "@polaris/observability/logger";
import { createBillingStore } from "@polaris/db/billing-store";
import { createAuthLoginLockMaintenanceClient } from "@polaris/db/auth-login-lock-maintenance";
import { createAuthUnverifiedUserMaintenanceClient } from "@polaris/db/auth-unverified-user-maintenance";
import { createMediaCleanupClient } from "@polaris/db/media-cleanup";
import {
  createOutboxClient,
  type OutboxClient,
} from "@polaris/db/outbox-dispatch";
import { createPrivacyMaintenanceClient } from "@polaris/db/privacy-maintenance";
import { createClosureNoticeRecipientClient } from "@polaris/db/closure-notice-recipient";
import { app } from "../src/server/app";
import {
  reconcileRemovedMedia,
  reconcileStagedMedia,
} from "../src/server/media-reconciler";
import {
  runBillingMaintenance,
  runUnclaimedTrialSettlement,
  runWooviReconciliation,
} from "../src/server/billing/maintenance";
import { billingProviderPortOf } from "../src/server/billing/provider-ports";
import {
  handleRenewalCancelRequested,
  rearmRenewalCancellations,
} from "../src/server/billing/renewal-cancellation";
import {
  type ClosureNoticeEmail,
  closureNoticeEmailConfig,
  handleClosureNotice,
  handOverOwedClosureNotices,
} from "../src/server/privacy/closure-notice";
import { runDataExports } from "../src/server/privacy/data-export-job";
import {
  createClosedExportReader,
  createRequesterReader,
} from "../src/server/privacy/data-export-reader";
import {
  closureAutoPurgeEnabled,
  closureAutoPurgeVolumeHigh,
  runPrivacyMaintenance,
} from "../src/server/privacy/maintenance";
import { runOrganizationPurges } from "../src/server/privacy/organization-purge-job";
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
import { billingProviderHandled } from "@polaris/domain/billing/renewal-cancellation";
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
      logger.info("media_staging_reconciliation_complete", { ...report });
    } catch (error: unknown) {
      failures.push(error);
    }
    try {
      const report = await reconcileRemovedMedia({
        cleanupClient,
        mediaBucket,
      });
      logger.info("media_removed_reconciliation_complete", { ...report });
    } catch (error: unknown) {
      failures.push(error);
    }
  } finally {
    await quietly(() => cleanupClient.close());
  }
  return finished(failures);
}

/**
 * Applies the events that were received but not processed, then what time itself
 * causes, asks again for the renewal cancellations still owed, reads Woovi's
 * subscriptions again (the reconciliation), then settles the trials no
 * reservation paid for (ADR 0101).
 */
async function runBillingJobs(env: WorkerBindings): Promise<JobResult> {
  const connectionString = env.BILLING_HYPERDRIVE?.connectionString;
  if (!connectionString) {
    // billing is not provisioned in this environment yet: nothing to do
    logger.warn("billing_maintenance_not_configured");
    return notConfigured;
  }
  let store: ReturnType<typeof createBillingStore>;
  try {
    store = createBillingStore(connectionString);
  } catch (error: unknown) {
    return finished([error]);
  }
  const failures: unknown[] = [];
  try {
    const report = await runBillingMaintenance(store);
    logger.info("billing_maintenance_complete", {
      retry: { ...report.retry },
      sweep: { ...report.sweep },
    });
  } catch (error: unknown) {
    failures.push(error);
  }
  try {
    // after the sweep, which ends what time ended: a closed organization whose renewal is still alive asks again
    const rearmed = await rearmRenewalCancellations(store);
    logger.info("billing_renewal_cancel_rearm_complete", { ...rearmed });
  } catch (error: unknown) {
    failures.push(error);
  }
  try {
    // the reconciliation with Woovi (ADR 0101, PR 6): what a webhook answered without a fact is read here
    const reconciled = await runWooviReconciliation(env, store);
    if (reconciled) {
      logger.info("billing_woovi_reconcile_complete", { ...reconciled });
    }
  } catch (error: unknown) {
    failures.push(error);
  }
  try {
    // after the retry pass, which is what leaves an unclaimed trial past its retries
    const settled = await runUnclaimedTrialSettlement(env, store);
    if (settled) {
      logger.info("billing_unclaimed_trials_complete", { ...settled });
    }
  } catch (error: unknown) {
    failures.push(error);
  } finally {
    await quietly(() => store.close());
  }
  return finished(failures);
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
    // a closed organization's export is read through the privacy role, the only one that may become its reader
    ...(env.PRIVACY_HYPERDRIVE?.connectionString
      ? {
          readClosedExport: createClosedExportReader(
            env.PRIVACY_HYPERDRIVE.connectionString
          ),
        }
      : {}),
  });
}

/**
 * What the privacy role does in the background: marks the closures whose recovery window ended as
 * closed (ADR 0074) and, with `CLOSURE_AUTO_PURGE_ENABLED` on, schedules the purge of the closures that
 * reached D minus 7 days (ADR 0102), builds the data exports that were asked for and removes the ones whose
 * time is up (ADR 0078), and runs the purges that are due, scheduled by the closure period or by an operator
 * (ADR 0081). One connection serves them all, and one failing never hides the others.
 */
async function runPrivacyJobs(env: WorkerBindings): Promise<JobResult> {
  const connectionString = env.PRIVACY_HYPERDRIVE?.connectionString;
  if (!connectionString) {
    // the privacy role is not provisioned in this environment yet: nothing to do
    logger.warn("privacy_maintenance_not_configured");
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
      const report = await runPrivacyMaintenance(client, {
        autoPurgeEnabled: closureAutoPurgeEnabled(
          env.CLOSURE_AUTO_PURGE_ENABLED
        ),
      });
      logger.info("privacy_maintenance_complete", { ...report });
      if (closureAutoPurgeVolumeHigh(report)) {
        // more stores than expected entered the purge on their own in a day: the brake is a person's (ADR 0102)
        logger.warn("closure_auto_purge_volume_high", {
          scheduledPurgesLastDay: report.scheduledPurgesLastDay,
        });
      }
      if (
        report.overduePurges > 0 ||
        report.purgesHeldBack > 0 ||
        report.closureNoticesOverdue > 0
      ) {
        // stores left behind (a month after D with no legal hold, or a purge held back past its time) and notices
        // still owed days after their date: a person decides each one (ADR 0102)
        logger.warn("closure_purge_overdue", {
          closureNoticesOverdue: report.closureNoticesOverdue,
          overduePurges: report.overduePurges,
          purgesHeldBack: report.purgesHeldBack,
        });
      }
    } catch (error: unknown) {
      failures.push(error);
    }
    await runClosureNoticeHandover(env, client, failures);
    const live = queuePathLive(env);
    if (live) {
      // the safety net of the queue path: an export still owed gets its event sent again
      try {
        const rearmed = await client.rearmDataExportEvents(
          REARM_MIN_AGE_SECONDS,
          REARM_BATCH
        );
        logger.info("data_export_events_rearmed", { rearmed });
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
        logger.info("data_export_complete", { ...report });
      } catch (error: unknown) {
        failures.push(error);
      }
      try {
        const report = await runOrganizationPurges({
          bucket,
          client,
          now: () => new Date(),
        });
        logger.info("organization_purge_complete", { ...report });
      } catch (error: unknown) {
        failures.push(error);
      }
    } else {
      // without the bucket neither the exports nor the purges can touch storage: the purge must not reach the rows
      logger.warn("data_export_not_configured");
      logger.warn("organization_purge_not_configured");
    }
  } finally {
    await quietly(() => client.close());
  }
  return finished(failures);
}

/** How many users one run of the purge of the unverified deletes at most (the function takes 1 to 1000). */
const UNVERIFIED_USER_PURGE_LIMIT = 200;

/**
 * Removes the rows of the sign-in lock untouched for a day (retention class `auth_login_lock`, ADR 0100),
 * through the authentication role, the only one that executes the function.
 */
async function runLoginLockExpiry(env: WorkerBindings): Promise<JobResult> {
  const connectionString = env.AUTH_HYPERDRIVE?.connectionString;
  if (!connectionString) {
    // the authentication role is not provisioned in this environment yet: nothing to do
    logger.warn("auth_login_lock_expiry_not_configured");
    return notConfigured;
  }
  let client: ReturnType<typeof createAuthLoginLockMaintenanceClient>;
  try {
    client = createAuthLoginLockMaintenanceClient(connectionString);
  } catch (error: unknown) {
    return finished([error]);
  }
  try {
    const removed = await client.expire();
    logger.info("auth_login_lock_expired", { removed });
    return finished([]);
  } catch (error: unknown) {
    return finished([error]);
  } finally {
    await quietly(() => client.close());
  }
}

/**
 * Deletes the users who never verified the e-mail (retention class `auth_unverified_user`, ADR 0100, Q-D2): the
 * ones with no Google account, no session and no membership, created more than 24 hours ago, at most
 * UNVERIFIED_USER_PURGE_LIMIT per run. The conditions, the audit (without the e-mail) and the limit's range
 * live in the function; the Worker only calls it, through the authentication role. It may run while the
 * password sign-in is off: with no user by password there is nothing to delete.
 */
async function runUnverifiedUserPurge(env: WorkerBindings): Promise<JobResult> {
  const connectionString = env.AUTH_HYPERDRIVE?.connectionString;
  if (!connectionString) {
    // the authentication role is not provisioned in this environment yet: nothing to do
    logger.warn("auth_unverified_user_purge_not_configured");
    return notConfigured;
  }
  let client: ReturnType<typeof createAuthUnverifiedUserMaintenanceClient>;
  try {
    client = createAuthUnverifiedUserMaintenanceClient(connectionString);
  } catch (error: unknown) {
    return finished([error]);
  }
  try {
    const removed = await client.purge(UNVERIFIED_USER_PURGE_LIMIT);
    logger.info("auth_unverified_users_purged", { removed });
    return finished([]);
  } catch (error: unknown) {
    return finished([error]);
  } finally {
    await quietly(() => client.close());
  }
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
    logger.warn("outbox_dispatch_not_configured");
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
    logger.info("outbox_dispatch_complete", { ...report });
  } catch (error: unknown) {
    failures.push(error);
  }
  try {
    // an event past the attempt cap is no longer claimed: it becomes an incident and a dead event (ADR 0085)
    const recorded = await client.recordExhaustedOutboxEvents(EXHAUSTED_BATCH);
    if (recorded > 0) {
      logger.warn("outbox_events_exhausted", { recorded });
    }
  } catch (error: unknown) {
    failures.push(error);
  }
  try {
    const removed = await client.expireProcessing(
      PROCESSING_KEEP_HOURS,
      PROCESSING_EXPIRY_BATCH
    );
    logger.info("queue_processing_expired", { removed });
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
    "auth.login_lock_expiry": () => runLoginLockExpiry(env),
    "auth.unverified_user_purge": () => runUnverifiedUserPurge(env),
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
    logger.warn("scheduler_unknown_cron");
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
    logger.info("data_export_complete", { ...result });
  } finally {
    await quietly(() => client.close());
  }
}

/**
 * The handler of `billing.renewal_cancel_requested` (ADR 0074, L4): the closure asked to cancel the renewal.
 * Without the billing role there is no subscription to cancel here, and a retry would not change it. A
 * provider without its settings, or one that fails, throws: the queue retries, then the dead-letter queue.
 */
async function handleRenewalCancelEvent(
  env: WorkerBindings,
  envelope: QueueEnvelope
): Promise<void> {
  const connectionString = env.BILLING_HYPERDRIVE?.connectionString;
  if (!connectionString) {
    throw new PermanentHandlerError("billing_not_configured");
  }
  const store = createBillingStore(connectionString);
  try {
    await handleRenewalCancelRequested(
      {
        handles: billingProviderHandled,
        portFor: (provider) => billingProviderPortOf(env, provider),
        store,
      },
      envelope
    );
  } finally {
    await quietly(() => store.close());
  }
}

/**
 * The handler of `organization.closure_notice` (ADR 0102, amended): a milestone of a closure arrived. Without the
 * privacy role there is nothing to read, and a retry would not change it.
 */
async function handleClosureNoticeEvent(
  env: WorkerBindings,
  envelope: QueueEnvelope
): Promise<void> {
  const connectionString = env.PRIVACY_HYPERDRIVE?.connectionString;
  if (!connectionString) {
    throw new PermanentHandlerError("closure_notice_not_configured");
  }
  const client = createPrivacyMaintenanceClient(connectionString);
  const email = closureNoticeEmailOf(env);
  try {
    await handleClosureNotice(
      { email: email?.email ?? null, notices: client },
      envelope
    );
  } finally {
    await quietly(() => client.close());
    if (email) {
      await quietly(email.close);
    }
  }
}

/**
 * The notices left owed (the e-mail was off, or a delivery did not settle), only with the e-mail on: the latest of
 * each cycle goes out (ADR 0102, amended).
 */
async function runClosureNoticeHandover(
  env: WorkerBindings,
  client: ReturnType<typeof createPrivacyMaintenanceClient>,
  failures: unknown[]
): Promise<void> {
  const email = closureNoticeEmailOf(env);
  if (!email) {
    return;
  }
  try {
    const handover = await handOverOwedClosureNotices({
      email: email.email,
      notices: client,
    });
    logger.info("closure_notice_handover_complete", { ...handover });
  } catch (error: unknown) {
    failures.push(error);
  } finally {
    await quietly(email.close);
  }
}

/**
 * The e-mail of the closure notices, or null while it is off (ADR 0102, amended): the switch, the provider's secrets
 * and the authentication role, the only one that reads the address (`closure_notice_recipient`).
 */
function closureNoticeEmailOf(
  env: WorkerBindings
): { close: () => Promise<void>; email: ClosureNoticeEmail } | null {
  const config = closureNoticeEmailConfig(env);
  const authConnection = env.AUTH_HYPERDRIVE?.connectionString;
  if (!(config && authConnection)) {
    return null;
  }
  const recipients = createClosureNoticeRecipientClient(authConnection);
  return { close: () => recipients.close(), email: { config, recipients } };
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
    logger.warn("dead_letter_not_recorded_unconfigured");
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
    "billing.renewal_cancel_requested": (envelope: QueueEnvelope) =>
      handleRenewalCancelEvent(env, envelope),
    "data_export.requested": (envelope: QueueEnvelope) =>
      handleDataExportRequested(env, envelope),
    "organization.closure_notice": (envelope: QueueEnvelope) =>
      handleClosureNoticeEvent(env, envelope),
  };
  const connectionString = env.OUTBOX_HYPERDRIVE?.connectionString;
  if (!connectionString) {
    // no check against the outbox and no deduplication across isolates: only the handler's own guards
    logger.warn("queue_ledger_in_memory");
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

configureLogging({ service: "polaris-web" });

export default {
  fetch: app.fetch,
  queue: (batch: QueueBatch, env) => consumeQueue(batch, env),
  scheduled: (controller, env) => runScheduledTick(controller.cron, env),
} satisfies ExportedHandler<WorkerBindings>;
