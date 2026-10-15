import type {
  BillingRetryReport,
  BillingStore,
  BillingSweepReport,
} from "@polaris/db/billing-store";

export interface BillingMaintenanceReport {
  retry: BillingRetryReport;
  sweep: BillingSweepReport;
}

/**
 * What the hourly cron does for billing (plan PR79 and PR81). The order is the
 * point: events that were received but not applied go first, so a renewal that
 * is already confirmed is on the record before the sweep reads the end of the
 * period; then the sweep applies what time itself causes. Both are safe to run
 * again, and a failure never stops the other: every failure is logged by the
 * store with its ID, and the run reports itself as incomplete at the end so the
 * cron shows it.
 */
export async function runBillingMaintenance(
  store: BillingStore,
  now: Date = new Date()
): Promise<BillingMaintenanceReport> {
  // a part that throws (its first query failed) counts as all failed, and the other still runs
  const retry = await store.retryPending(now).catch(() => null);
  const sweep = await store.sweepDue(now).catch(() => null);
  if (retry === null || sweep === null) {
    console.error("billing_maintenance_incomplete", {
      retry: retry === null ? "threw" : retry,
      sweep: sweep === null ? "threw" : sweep,
    });
    throw new Error("billing_maintenance_incomplete");
  }
  const report = { retry, sweep };
  if (retry.failed > 0 || sweep.failed > 0) {
    console.error("billing_maintenance_incomplete", report);
    throw new Error("billing_maintenance_incomplete");
  }
  return report;
}
