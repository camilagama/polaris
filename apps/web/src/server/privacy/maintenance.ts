import type { PrivacyMaintenanceClient } from "@polaris/db/privacy-maintenance";

/** Organizations marked closed per call, and how many calls one run makes at most. */
export const CLOSURE_SWEEP_BATCH = 100;
export const CLOSURE_SWEEP_MAX_BATCHES = 10;

/** Above this many organizations put into the purge by the closure period in a day, the run raises an alert. */
export const CLOSURE_AUTO_PURGE_ALERT_PER_DAY = 5;

export interface PrivacyMaintenanceReport {
  closedOrganizations: number;
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
 * anything back nor deletes anything.
 */
export async function runPrivacyMaintenance(
  client: Pick<
    PrivacyMaintenanceClient,
    "finalizeExpiredClosures" | "scheduleClosedOrganizationPurges"
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
  if (options.autoPurgeEnabled) {
    for (let batch = 0; batch < CLOSURE_SWEEP_MAX_BATCHES; batch += 1) {
      const result =
        // biome-ignore lint/performance/noAwaitInLoops: each batch decides whether another is needed.
        await client.scheduleClosedOrganizationPurges(CLOSURE_SWEEP_BATCH);
      scheduledPurges += result.scheduled;
      scheduledPurgesLastDay = result.scheduledLastDay;
      if (result.scheduled < CLOSURE_SWEEP_BATCH) {
        break;
      }
    }
  }
  return {
    closedOrganizations,
    purgeSchedulingEnabled: options.autoPurgeEnabled,
    scheduledPurges,
    scheduledPurgesLastDay,
  };
}
