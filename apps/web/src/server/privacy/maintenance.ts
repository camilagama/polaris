import type { PrivacyMaintenanceClient } from "@polaris/db/privacy-maintenance";

/** Organizations marked closed per call, and how many calls one run makes at most. */
export const CLOSURE_SWEEP_BATCH = 100;
export const CLOSURE_SWEEP_MAX_BATCHES = 10;

/** Above this many organizations put into the purge by the closure period in a day, the run raises an alert. */
export const CLOSURE_AUTO_PURGE_ALERT_PER_DAY = 5;

export interface PrivacyMaintenanceReport {
  closedOrganizations: number;
  /** Notices of a closure milestone written to go out by this run, each with its outbox event (ADR 0102, amended). */
  closureNoticesRecorded: number;
  /** Earlier milestones written skipped, because a later one was due with them (no e-mail). */
  closureNoticesSkipped: number;
  /** Notices still owed 3 days after their date, for a store still in closure (`closure_purge_overdue`). */
  closureNoticesOverdue: number;
  /**
   * Closed organizations still waiting 30 days after D with no legal hold (0 with the switch off): a store left
   * behind by a cancellation of the Admin, a renewal still alive, a temporary access or a notice not delivered
   * (`closure_purge_overdue`).
   */
  overduePurges: number;
  /**
   * Scheduled purges (the closure period's or the Admin's) held back past their time by a live temporary access, a
   * renewal still alive or a notice not delivered, whatever the switch (`closure_purge_overdue`).
   */
  purgesHeldBack: number;
  /** Whether the automatic schedule ran: `CLOSURE_AUTO_PURGE_ENABLED` is on (ADR 0102). */
  purgeSchedulingEnabled: boolean;
  /** Organizations this run put into the purge (0 with the switch off). */
  scheduledPurges: number;
  /** Organizations the closure period put into the purge in the last 24 hours (0 with the switch off). */
  scheduledPurgesLastDay: number;
}

export interface PrivacyMaintenanceOptions {
  /** `CLOSURE_AUTO_PURGE_ENABLED === "true"`: off by default, on only at the go-live. */
  autoPurgeEnabled: boolean;
}

/** Whether the switch of the automatic purge is on: only the exact text `true` turns it on. */
export function closureAutoPurgeEnabled(value: string | undefined): boolean {
  return value === "true";
}

/** Whether the day's automatic schedules call for the alert (`closure_auto_purge_volume_high`). */
export function closureAutoPurgeVolumeHigh(
  report: PrivacyMaintenanceReport
): boolean {
  return report.scheduledPurgesLastDay > CLOSURE_AUTO_PURGE_ALERT_PER_DAY;
}

/**
 * What time itself causes in the closure of organizations (ADR 0074 and 0102): a closing organization whose
 * recovery window ended becomes closed, and then, with the switch on, a closed organization whose D minus 7
 * local days arrived has its purge scheduled (the purge itself runs later, never before D plus 48 hours). Both
 * are bounded, so a backlog is worked off over several hourly runs instead of one long one; neither moves
 * anything back nor deletes anything. Last, whatever the switch, the notices of the milestones whose date
 * arrived are written (the request, D minus 30 and minus 7, D, and a purge pushed by the release of a legal
 * hold), after the schedule, so the notice of D minus 7 goes out with it.
 */
export async function runPrivacyMaintenance(
  client: Pick<
    PrivacyMaintenanceClient,
    | "countPurgesHeldBack"
    | "finalizeExpiredClosures"
    | "recordClosureNotices"
    | "scheduleClosedOrganizationPurges"
  >,
  options: PrivacyMaintenanceOptions
): Promise<PrivacyMaintenanceReport> {
  let closedOrganizations = 0;
  for (let batch = 0; batch < CLOSURE_SWEEP_MAX_BATCHES; batch += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each batch decides whether another is needed.
    const closed = await client.finalizeExpiredClosures(CLOSURE_SWEEP_BATCH);
    closedOrganizations += closed;
    if (closed < CLOSURE_SWEEP_BATCH) {
      break;
    }
  }
  let scheduledPurges = 0;
  let scheduledPurgesLastDay = 0;
  let overduePurges = 0;
  if (options.autoPurgeEnabled) {
    for (let batch = 0; batch < CLOSURE_SWEEP_MAX_BATCHES; batch += 1) {
      const result =
        // biome-ignore lint/performance/noAwaitInLoops: each batch decides whether another is needed.
        await client.scheduleClosedOrganizationPurges(CLOSURE_SWEEP_BATCH);
      scheduledPurges += result.scheduled;
      scheduledPurgesLastDay = result.scheduledLastDay;
      overduePurges = result.overdue;
      if (result.scheduled < CLOSURE_SWEEP_BATCH) {
        break;
      }
    }
  }
  let closureNoticesRecorded = 0;
  let closureNoticesSkipped = 0;
  let closureNoticesOverdue = 0;
  for (let batch = 0; batch < CLOSURE_SWEEP_MAX_BATCHES; batch += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each batch decides whether another is needed.
    const notices = await client.recordClosureNotices(CLOSURE_SWEEP_BATCH);
    closureNoticesRecorded += notices.recorded;
    closureNoticesSkipped += notices.skipped;
    closureNoticesOverdue = notices.overdue;
    if (notices.organizations < CLOSURE_SWEEP_BATCH) {
      break;
    }
  }
  const purgesHeldBack = await client.countPurgesHeldBack();
  return {
    closedOrganizations,
    closureNoticesOverdue,
    closureNoticesRecorded,
    closureNoticesSkipped,
    overduePurges,
    purgeSchedulingEnabled: options.autoPurgeEnabled,
    purgesHeldBack,
    scheduledPurges,
    scheduledPurgesLastDay,
  };
}
