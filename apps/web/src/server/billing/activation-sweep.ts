import type {
  ActivationSweepReport,
  BillingStore,
} from "@polaris/db/billing-store";
import { logger } from "@polaris/observability/logger";
import { describeError } from "@polaris/observability/wide-event";
import type { WorkerBindings } from "../environment";

/** The fixed batch of one hourly sweep (ADR 0106, D5): `truncated` says that more wait for the next hour. */
export const ACTIVATION_SWEEP_BATCH = 50;

/** Only the exact text `true` turns the series on (`ACTIVATION_EMAILS_ENABLED`): the sweep and the consumer alike. */
export function activationEmailsEnabled(
  bindings: Pick<WorkerBindings, "ACTIVATION_EMAILS_ENABLED">
): boolean {
  return bindings.ACTIVATION_EMAILS_ENABLED === "true";
}

/**
 * The hourly sweep of the activation series, in the maintenance lane that already runs: no cron of its own. It
 * records, it never sends (the consumer of `activation.notice` does). The log says only the outcome, whether the
 * switch was on, the counts and the reasons of the skipped: no store, no person and no address. A failure is logged
 * with its class and code alone and thrown as it came, like the other jobs of the lane, so the run shows itself
 * incomplete with the error's code.
 */
export async function runActivationSweep(
  bindings: Pick<WorkerBindings, "ACTIVATION_EMAILS_ENABLED">,
  store: Pick<BillingStore, "sweepActivationSeries">,
  now: Date = new Date()
): Promise<ActivationSweepReport> {
  const enabled = activationEmailsEnabled(bindings);
  let report: ActivationSweepReport;
  try {
    report = await store.sweepActivationSeries({
      enabled,
      limit: ACTIVATION_SWEEP_BATCH,
      now,
    });
  } catch (error: unknown) {
    logger.error("activation_sweep_failed", {
      ...describeError(error),
      outcome: "failure",
      seriesOn: enabled,
    });
    throw error;
  }
  logger.info(
    "activation_sweep_complete",
    enabled
      ? {
          due: report.due,
          outcome: "success",
          seriesOn: true,
          skipped: { expired: report.expired, series_off: report.seriesOff },
          truncated: report.truncated,
        }
      : { outcome: "skipped", reason: "series_switched_off", seriesOn: false }
  );
  return report;
}
