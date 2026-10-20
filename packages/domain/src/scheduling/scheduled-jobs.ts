import type { RetentionPurgeJobId } from "../privacy/retention";

/**
 * The registry of scheduled jobs (plan PR112, ADR 0086): every job the Worker runs on a clock, with its
 * cadence, its lease and what makes running it again safe. It is the single place a job is declared; the
 * scheduler reads it, and the wrangler config must declare exactly the crons of its lanes (a test).
 *
 * The scheduler is one **tick per lane**, not one cron per job: a cron fires, the scheduler asks the
 * database which of the lane's jobs are due, takes the lease of each, runs it and records the success.
 * The Workers Free plan gives five Cron Triggers per account and 10 ms of CPU per invocation, so a lane
 * exists only where a job must not share its CPU with another (the outbox dispatcher has its own).
 *
 * Time is cut in fixed windows of the job's cadence, counted from the Unix epoch in UTC. A job is due
 * when the current window is later than the one its last successful run started in. A tick that was
 * lost, late or failed therefore never runs a job twice in a window, and one run after a gap covers all
 * the windows missed: every job reads the work owed from the database (level-triggered), so a single
 * run catches up. Jobs are plain TypeScript data, with no framework import.
 */

export const SCHEDULED_JOB_IDS = [
  "media.maintenance",
  "billing.maintenance",
  "privacy.maintenance",
  "auth.login_lock_expiry",
  "outbox.dispatch",
  "billing.provider_reconcile",
  "expenses.recurring_generation",
] as const;

export type ScheduledJobId = (typeof SCHEDULED_JOB_IDS)[number];

export type SchedulerLaneId = "maintenance" | "outbox";

/** A Cron Trigger and the jobs it runs. Its expression must be declared in `apps/web/wrangler.jsonc`. */
export interface SchedulerLane {
  cron: string;
  id: SchedulerLaneId;
  /** How often the cron fires, in seconds. */
  tickSeconds: number;
}

export const SCHEDULER_LANES: readonly SchedulerLane[] = Object.freeze([
  // media, billing and privacy share an invocation
  { cron: "17 * * * *", id: "maintenance", tickSeconds: 3600 },
  // the dispatcher has its own invocation: its 10 ms of CPU on the Free plan are not shared (ADR 0084)
  { cron: "19 * * * *", id: "outbox", tickSeconds: 3600 },
]);

interface ScheduledJobBase {
  /** Seconds between windows; a divisor of a day so that a window never straddles midnight UTC. */
  cadenceSeconds: number;
  description: string;
  id: ScheduledJobId;
  /** Why running the job again, or running it once for several windows, changes nothing it should not. */
  idempotentBy: string;
  /** The lease on a run, longer than the 15 minutes of wall time a cron invocation can live. */
  leaseSeconds: number;
  /** The retention purge jobs (ADR 0079) this job performs; each serves one approved class. */
  purges: readonly RetentionPurgeJobId[];
}

interface EnabledScheduledJob extends ScheduledJobBase {
  lane: SchedulerLaneId;
  status: "enabled";
}

/** Registered so that it is seen and counted, but never run: it has no lane and no handler. */
interface DisabledScheduledJob extends ScheduledJobBase {
  lane: null;
  /** What is missing, in the words of the person who will turn it on. */
  pending: string;
  purges: readonly [];
  status: "disabled";
  /** The decision, gate or credential it waits for. */
  waitsFor: string;
}

export type ScheduledJob = DisabledScheduledJob | EnabledScheduledJob;

const HOUR_SECONDS = 3600;
const LEASE_SECONDS = 960;

export const SCHEDULED_JOBS: readonly ScheduledJob[] = Object.freeze([
  {
    cadenceSeconds: HOUR_SECONDS,
    description:
      "Reclaims what media left behind: unfinished uploads (staging markers and orphan masters) and the objects of removed images.",
    id: "media.maintenance",
    idempotentBy:
      "each reconciler lists what is owed (by age) and removes it; nothing owed, nothing done",
    lane: "maintenance",
    leaseSeconds: LEASE_SECONDS,
    purges: ["media.staging_reconcile", "media.removed_cleanup"],
    status: "enabled",
  },
  {
    cadenceSeconds: HOUR_SECONDS,
    description:
      "Billing: applies the provider facts received but not applied, then the sweep that ends the trial without a first charge, puts an unrenewed paid period in grace and ends the grace (billing rule).",
    id: "billing.maintenance",
    idempotentBy:
      "the facts are stored once per provider and ID, and each transition of the sweep is written to the ledger once",
    lane: "maintenance",
    leaseSeconds: LEASE_SECONDS,
    purges: [],
    status: "enabled",
  },
  {
    cadenceSeconds: HOUR_SECONDS,
    description:
      "Privacy: closes the organizations whose recovery window ended, schedules the purge of the closures 7 local days before D behind CLOSURE_AUTO_PURGE_ENABLED (ADR 0102), writes the notices of the closure milestones whose date arrived, sends back the data export events still owed, builds (without the queue path) or expires the data exports, and carries out the purges scheduled by the closure period or by an operator.",
    id: "privacy.maintenance",
    idempotentBy:
      "closing, scheduling and expiring act on what time already made due (an organization already scheduled is no longer closed, so it is not scheduled twice); a notice is unique by milestone and closure cycle, so it is written once; the re-arm, the export claim and the purge claim are fenced by the database, and every purge step can run again without effect",
    lane: "maintenance",
    leaseSeconds: LEASE_SECONDS,
    purges: ["privacy.closure_purge_schedule", "privacy.data_export_expiry"],
    status: "enabled",
  },
  {
    cadenceSeconds: HOUR_SECONDS,
    description:
      "Authentication: removes the rows of the sign-in lock untouched for a day (the e-mails typed, kept only as an HMAC).",
    id: "auth.login_lock_expiry",
    idempotentBy:
      "it deletes what the clock already made old; nothing old, nothing deleted",
    lane: "maintenance",
    leaseSeconds: LEASE_SECONDS,
    purges: ["auth.login_lock_expiry"],
    status: "enabled",
  },
  {
    cadenceSeconds: HOUR_SECONDS,
    description:
      "Outbox: sends the due events (and those whose claim ran out) to their queues and marks them dispatched, then removes the consumer's old processing records.",
    id: "outbox.dispatch",
    idempotentBy:
      "an event is claimed, sent and marked under a fence of attempts; a duplicate send is absorbed by the handler (ADR 0084)",
    lane: "outbox",
    leaseSeconds: LEASE_SECONDS,
    purges: ["outbox.processing_expiry"],
    status: "enabled",
  },
  {
    cadenceSeconds: HOUR_SECONDS,
    description:
      "Reconciles the product state of the subscriptions with what the payment provider reports.",
    id: "billing.provider_reconcile",
    idempotentBy: "not written yet",
    lane: null,
    leaseSeconds: LEASE_SECONDS,
    pending:
      "No provider code exists: the adapters and their credentials come with the provider gate, and the provider reports while the Polaris decides.",
    purges: [],
    status: "disabled",
    waitsFor: "Gate 7 (Asaas and Woovi, sandbox credentials)",
  },
  {
    cadenceSeconds: 86_400,
    description:
      "Generates the recurring expense occurrences that came due, for every organization, without anyone opening the screen.",
    id: "expenses.recurring_generation",
    idempotentBy: "not written yet",
    lane: null,
    leaseSeconds: LEASE_SECONDS,
    pending:
      "The rule exists (ADR 0052) and already generates on read, with catch-up, so no result is wrong without the job. A job needs a privileged role that writes expenses and audit events across every tenant, which no role has today.",
    purges: [],
    status: "disabled",
    waitsFor:
      "a decision of the responsible person on a cross-tenant writer (security review), if the month's result must not wait for someone to open the screen",
  },
]);

export function isScheduledJobId(value: string): value is ScheduledJobId {
  return SCHEDULED_JOB_IDS.some((candidate) => candidate === value);
}

export function scheduledJob(id: ScheduledJobId): ScheduledJob {
  const job = SCHEDULED_JOBS.find((candidate) => candidate.id === id);
  if (!job) {
    throw new Error("scheduled_job_unknown");
  }
  return job;
}

/** The enabled jobs a lane runs, in the order they run. */
export function jobsOfLane(lane: SchedulerLaneId): ScheduledJobId[] {
  return SCHEDULED_JOBS.flatMap((job) =>
    job.status === "enabled" && job.lane === lane ? [job.id] : []
  );
}

export function laneOfCron(
  cron: string | undefined
): SchedulerLane | undefined {
  return SCHEDULER_LANES.find((lane) => lane.cron === cron);
}

function checkCadence(cadenceSeconds: number): void {
  if (!Number.isSafeInteger(cadenceSeconds) || cadenceSeconds < 1) {
    throw new Error("invalid_cadence");
  }
}

/** The window an instant falls in: whole cadences since the Unix epoch, in UTC. */
export function windowIndex(at: Date, cadenceSeconds: number): number {
  checkCadence(cadenceSeconds);
  return Math.floor(at.getTime() / 1000 / cadenceSeconds);
}

/**
 * How many whole windows passed without a successful run between the last one (the instant it started)
 * and now; none for a job that never ran. A report only: one run covers them all.
 */
export function windowsMissed(
  lastCoveredAt: Date | null,
  now: Date,
  cadenceSeconds: number
): number {
  if (lastCoveredAt === null) {
    return 0;
  }
  return Math.max(
    0,
    windowIndex(now, cadenceSeconds) -
      windowIndex(lastCoveredAt, cadenceSeconds) -
      1
  );
}
