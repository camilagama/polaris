import type { PrivacyMaintenanceClient } from "@polaris/db/privacy-maintenance";

/** Organizations marked closed per call, and how many calls one run makes at most. */
export const CLOSURE_SWEEP_BATCH = 100;
export const CLOSURE_SWEEP_MAX_BATCHES = 10;

export interface PrivacyMaintenanceReport {
  closedOrganizations: number;
}

/**
 * What time itself causes in the closure of organizations (ADR 0074): a closing
 * organization whose recovery window ended becomes closed. It is bounded, so a
 * backlog is worked off over several hourly runs instead of one long one, and it
 * moves nothing back and deletes nothing.
 */
export async function runPrivacyMaintenance(
  client: Pick<PrivacyMaintenanceClient, "finalizeExpiredClosures">
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
  return { closedOrganizations };
}
