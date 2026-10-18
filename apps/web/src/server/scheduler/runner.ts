import { logger } from "@polaris/observability/logger";
import type { ScheduledJobClaim } from "@polaris/db/outbox-dispatch";
import {
  jobsOfLane,
  type ScheduledJobId,
  type SchedulerLaneId,
  scheduledJob,
} from "@polaris/domain/scheduling/scheduled-jobs";

/**
 * The scheduler's tick (plan PR112, ADR 0086). A Cron Trigger fires for a lane; for each job of the lane
 * that the registry enables, in its order, the tick asks the database for the job's lease (due once per
 * window), runs the job, and records how it ended. A failing job never hides another, and what the jobs
 * found is thrown at the end, so the cron shows the failure as it always did.
 *
 * A job reads the work that is owed from the database, so one run after a gap catches up by itself and
 * running it twice in a window changes nothing it should not: the lease only keeps two runs from
 * overlapping and the window only keeps a tick that fires twice from doing the work twice.
 */

/** The three calls of the scheduler's state (`OutboxClient` has them); the tick needs nothing else. */
export interface SchedulerStore {
  claimScheduledJob: (
    jobId: string,
    cadenceSeconds: number,
    leaseSeconds: number
  ) => Promise<ScheduledJobClaim>;
  completeScheduledJob: (jobId: string, token: string) => Promise<boolean>;
  releaseScheduledJob: (
    jobId: string,
    token: string,
    outcome: "failed" | "skipped"
  ) => Promise<boolean>;
}

/** What a job tells the tick: it did its work, it had nothing to do here, or it found failures. */
export type JobResult =
  | { failures: unknown[]; status: "failed" }
  | { reason: "not_configured"; status: "skipped" }
  | { status: "completed" };

/** What the tick tells a job about the window it covers. */
interface JobRun {
  /** Whole windows that passed since the last successful run: this run covers them too. */
  missedWindows: number;
  /** It took over a run that died (its lease ended without an outcome). */
  recovered: boolean;
}

export type JobHandler = (run: JobRun) => Promise<JobResult>;

export type JobHandlers = Partial<Record<ScheduledJobId, JobHandler>>;

export interface RunLaneOptions {
  handlers: JobHandlers;
  lane: SchedulerLaneId;
  /** Milliseconds, for the duration in the log. */
  now?: () => number;
  /** Null where the scheduler state is not provisioned: every job of the lane then runs on every tick. */
  store: SchedulerStore | null;
}

const safeNamePattern = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;
const safeCodePattern = /^[A-Za-z0-9_.-]{1,64}$/;

/** A failure as the log may carry it: the class and a provider or SQLSTATE style code, never the message. */
function describeFailure(error: unknown): {
  errorCode?: string | undefined;
  errorName: string;
} {
  if (typeof error !== "object" || error === null) {
    return { errorName: "NonObjectError" };
  }
  const { code, name } = error as { code?: unknown; name?: unknown };
  return {
    errorCode:
      typeof code === "string" && safeCodePattern.test(code) ? code : undefined,
    errorName:
      typeof name === "string" && safeNamePattern.test(name)
        ? name
        : "UnknownError",
  };
}

/** Throws what the jobs found: one failure as itself, several together. */
function throwFailures(failures: unknown[]): void {
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "scheduled_jobs_failed");
  }
}

/** A job that throws has failed; the exception becomes its result, never another job's. */
async function runHandler(
  handler: JobHandler,
  run: JobRun
): Promise<JobResult> {
  try {
    return await handler(run);
  } catch (error: unknown) {
    return { failures: [error], status: "failed" };
  }
}

type Claimed =
  | { run: JobRun; token: string | null }
  | { skipped: true }
  | { failure: unknown };

/** Asks for the lease; without a store the job is run unguarded, with nothing to record afterwards. */
async function takeLease(
  store: SchedulerStore | null,
  lane: SchedulerLaneId,
  jobId: ScheduledJobId
): Promise<Claimed> {
  if (store === null) {
    return { run: { missedWindows: 0, recovered: false }, token: null };
  }
  const job = scheduledJob(jobId);
  try {
    const claim = await store.claimScheduledJob(
      jobId,
      job.cadenceSeconds,
      job.leaseSeconds
    );
    if (claim.result !== "claimed") {
      logger.info("scheduled_job_skipped", {
        job: jobId,
        lane,
        reason: claim.result,
      });
      return { skipped: true };
    }
    return {
      run: { missedWindows: claim.missedWindows, recovered: claim.recovered },
      token: claim.token,
    };
  } catch (error: unknown) {
    // without the lease nothing is run: two runs could overlap. The cron shows the failure.
    logger.error("scheduled_job_claim_failed", {
      job: jobId,
      lane,
      ...describeFailure(error),
    });
    return { failure: error };
  }
}

/** Records how the run ended; returns the failure to show when a success could not be recorded. */
async function recordOutcome(
  store: SchedulerStore,
  lane: SchedulerLaneId,
  jobId: ScheduledJobId,
  token: string,
  result: JobResult
): Promise<{ failure: unknown } | null> {
  try {
    const recorded =
      result.status === "completed"
        ? await store.completeScheduledJob(jobId, token)
        : await store.releaseScheduledJob(
            jobId,
            token,
            result.status === "failed" ? "failed" : "skipped"
          );
    if (!recorded) {
      // the lease ended while the job ran and another run took it over: that run records the outcome
      logger.warn("scheduled_job_lease_lost", {
        job: jobId,
        lane,
        outcome: result.status,
      });
    }
    return null;
  } catch (error: unknown) {
    logger.error("scheduled_job_record_failed", {
      job: jobId,
      lane,
      outcome: result.status,
      ...describeFailure(error),
    });
    // a success that could not be recorded runs again next tick (the jobs allow it): show it
    return result.status === "completed" ? { failure: error } : null;
  }
}

/** One metric line per run, by outcome: failures say their class and code, never their message. */
function logRun(
  metrics: Record<string, boolean | number | string>,
  result: JobResult
): void {
  if (result.status === "failed") {
    logger.error("scheduled_job_run", {
      ...metrics,
      ...describeFailure(result.failures[0]),
      failures: result.failures.length,
    });
  } else if (result.status === "skipped") {
    logger.info("scheduled_job_run", { ...metrics, reason: result.reason });
  } else {
    logger.info("scheduled_job_run", metrics);
  }
}

export async function runLane(options: RunLaneOptions): Promise<void> {
  const { handlers, lane, store } = options;
  const now = options.now ?? Date.now;
  const failures: unknown[] = [];
  if (store === null) {
    logger.warn("scheduler_state_unavailable", { lane });
  }
  for (const jobId of jobsOfLane(lane)) {
    const handler = handlers[jobId];
    if (!handler) {
      logger.error("scheduled_job_handler_missing", { job: jobId, lane });
      failures.push(new Error("scheduled_job_handler_missing"));
      continue;
    }
    // biome-ignore lint/performance/noAwaitInLoops: the jobs of a lane run one after the other.
    const claimed = await takeLease(store, lane, jobId);
    if ("skipped" in claimed) {
      continue;
    }
    if ("failure" in claimed) {
      failures.push(claimed.failure);
      continue;
    }
    const { run, token } = claimed;

    const startedAt = now();
    const result = await runHandler(handler, run);
    logRun(
      {
        durationMs: now() - startedAt,
        job: jobId,
        lane,
        missedWindows: run.missedWindows,
        outcome: result.status,
        recovered: run.recovered,
      },
      result
    );
    if (result.status === "failed") {
      failures.push(...result.failures);
    }
    if (store !== null && token !== null) {
      const unrecorded = await recordOutcome(store, lane, jobId, token, result);
      if (unrecorded) {
        failures.push(unrecorded.failure);
      }
    }
  }
  throwFailures(failures);
}
