import { ProviderNotConfiguredError } from "@polaris/billing/provider-port";
import type {
  BillingRetryReport,
  BillingStore,
  BillingSweepReport,
} from "@polaris/db/billing-store";
import { logger } from "@polaris/observability/logger";
import type { WorkerBindings } from "../environment";
import { settleUnclaimedTrials, type UnclaimedTrialsReport } from "./commands";
import { billingProviderPortOf } from "./provider-ports";

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
    logger.error("billing_maintenance_incomplete", {
      retry: retry === null ? "threw" : { ...retry },
      sweep: sweep === null ? "threw" : { ...sweep },
    });
    throw new Error("billing_maintenance_incomplete");
  }
  const report = { retry, sweep };
  if (retry.failed > 0 || sweep.failed > 0) {
    logger.error("billing_maintenance_incomplete", {
      retry: { ...retry },
      sweep: { ...sweep },
    });
    throw new Error("billing_maintenance_incomplete");
  }
  return report;
}

/**
 * The hourly settling of the trials no reservation paid for (ADR 0101): their
 * subscription is cancelled at the provider well before its first charge (the
 * trial's 7 days; the retries end within hours). Without the provider's
 * settings it does nothing and says so; a failure makes the run incomplete.
 */
export async function runUnclaimedTrialSettlement(
  bindings: Pick<
    WorkerBindings,
    "ASAAS_API_KEY" | "ASAAS_BASE_URL" | "BETTER_AUTH_BASE_URL"
  >,
  store: Pick<BillingStore, "listUnclaimedTrials" | "settleUnclaimedTrial">,
  now: Date = new Date()
): Promise<UnclaimedTrialsReport | null> {
  try {
    billingProviderPortOf(bindings, "asaas");
  } catch (error: unknown) {
    if (error instanceof ProviderNotConfiguredError) {
      logger.warn("billing_unclaimed_trials_not_configured");
      return null;
    }
    throw error;
  }
  const report = await settleUnclaimedTrials({
    now: () => now,
    portFor: (provider) => billingProviderPortOf(bindings, provider),
    store,
  });
  if (report.failed > 0) {
    logger.error("billing_unclaimed_trials_incomplete", { ...report });
    throw new Error("billing_unclaimed_trials_incomplete");
  }
  return report;
}
