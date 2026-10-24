import {
  ProviderNotConfiguredError,
  ProviderNotFoundError,
} from "@polaris/billing/provider-port";
import {
  type BillingRetryReport,
  type BillingStore,
  type BillingSweepReport,
  REFUND_REARM_BATCH,
  type RefundRearmReport,
} from "@polaris/db/billing-store";
import { HANDLED_BILLING_PROVIDERS } from "@polaris/domain/billing/renewal-cancellation";
import { logger, opaqueId } from "@polaris/observability/logger";
import { describeError } from "@polaris/observability/wide-event";
import {
  reconcileOrganization,
  settleUnclaimedTrials,
  type UnclaimedTrialsReport,
} from "./commands";
import {
  type BillingPortBindings,
  billingProviderPortOf,
} from "./provider-ports";

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
  bindings: BillingPortBindings,
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

/**
 * Organizations reconciled with Woovi per hourly run: the trial setups and the
 * links of the last 8 days first, then the others in an order that changes
 * every hour. Two or three calls each, well inside a Worker's subrequests.
 */
const WOOVI_RECONCILE_BATCH = 200;

export interface WooviReconcileReport {
  applied: number;
  failed: number;
  /** Organizations whose subscription Woovi does not know (404): logged, not a failure. */
  notFound: number;
  organizations: number;
  /** More organizations were due than the batch takes: the next run goes on. */
  truncated: boolean;
}

/**
 * The hourly reconciliation with Woovi (ADR 0101, emenda do PR 6): a condition
 * before the first Woovi subscription, because a webhook answered 200 without a
 * fact (a read back that found nothing, a body out of its documented shape, a
 * state not shown yet) is only caught here. Every organization linked to Woovi
 * whose subscription may still change access is read at the provider
 * (`readState`, `reconcileWooviSubscription`) and its facts go through the same
 * inbox as the webhooks (`reconcileOrganization`): the same IDs, so a fact that
 * came by webhook is a duplicate. Without Woovi's settings it does nothing and
 * says so; one organization that fails never hides the others, and makes the
 * run incomplete.
 */
export async function runWooviReconciliation(
  bindings: BillingPortBindings,
  store: Pick<
    BillingStore,
    | "listReconcilableOrganizations"
    | "processEvent"
    | "readProviderLink"
    | "recordEvent"
  >,
  now: Date = new Date()
): Promise<WooviReconcileReport | null> {
  try {
    billingProviderPortOf(bindings, "woovi");
  } catch (error: unknown) {
    if (error instanceof ProviderNotConfiguredError) {
      logger.warn("billing_woovi_reconcile_not_configured");
      return null;
    }
    throw error;
  }
  const due = await store.listReconcilableOrganizations(
    "woovi",
    WOOVI_RECONCILE_BATCH + 1,
    now
  );
  const organizations = due.slice(0, WOOVI_RECONCILE_BATCH);
  const report: WooviReconcileReport = {
    applied: 0,
    failed: 0,
    notFound: 0,
    organizations: organizations.length,
    truncated: due.length > WOOVI_RECONCILE_BATCH,
  };
  for (const organizationId of organizations) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: One organization at a time, so Woovi is never flooded.
      const reconciled = await reconcileOrganization(
        {
          now: () => now,
          portFor: (provider) => billingProviderPortOf(bindings, provider),
          store,
        },
        organizationId
      );
      report.applied += reconciled.applied;
      report.failed += reconciled.failed;
    } catch (error: unknown) {
      if (error instanceof ProviderNotFoundError) {
        // Woovi has no such subscription (a link of another account, or one long gone): nothing
        // to read, and not a failure that would leave every hourly run incomplete
        report.notFound += 1;
        logger.warn("billing_woovi_reconcile_not_found", {
          organizationId: opaqueId(organizationId),
        });
        continue;
      }
      report.failed += 1;
      logger.error("billing_woovi_reconcile_failed", {
        ...describeError(error),
        organizationId: opaqueId(organizationId),
      });
    }
  }
  if (report.truncated) {
    logger.warn("billing_woovi_reconcile_truncated", { ...report });
  }
  if (report.failed > 0) {
    logger.error("billing_woovi_reconcile_incomplete", { ...report });
    throw new Error("billing_woovi_reconcile_incomplete");
  }
  return report;
}

export interface RefundSafetyNetReport {
  /** Stores whose refund is still not completed 24 hours after the owner's request, made an incident now. */
  pendingRefundIncidents: number;
  /** Providers whose settings are missing here: their stores are not tried (and no try is spent). */
  providersNotConfigured: string[];
  rearm: RefundRearmReport;
}

/**
 * The hourly safety net of refunds and chargebacks (ADR 0104, decision 6). A refund made at the provider's panel, or
 * a chargeback, leaves the subscription alive and its next charge would give Pro back and charge again: the renewal
 * of those stores is cancelled here, at most `REFUND_REARM_BATCH` a pass, with the back-off and the stop of the store
 * (`rearmRefundedRenewals`). Then the owner's refunds still pending 24 hours after the request become an operational
 * incident, one per store and request. Only the providers whose settings exist here are tried; a failure makes the
 * run incomplete, and the next pass goes on.
 */
export async function runRefundSafetyNet(
  bindings: BillingPortBindings,
  store: Pick<
    BillingStore,
    "rearmRefundedRenewals" | "recordPendingRefundIncidents"
  >,
  now: Date = new Date()
): Promise<RefundSafetyNetReport> {
  const providers: string[] = [];
  const providersNotConfigured: string[] = [];
  for (const provider of HANDLED_BILLING_PROVIDERS) {
    try {
      billingProviderPortOf(bindings, provider);
      providers.push(provider);
    } catch (error: unknown) {
      if (!(error instanceof ProviderNotConfiguredError)) {
        throw error;
      }
      providersNotConfigured.push(provider);
    }
  }
  const rearm =
    providers.length === 0
      ? { exhausted: 0, failed: 0, rearmed: 0, scanned: 0 }
      : await store.rearmRefundedRenewals({
          cancel: (renewal) =>
            billingProviderPortOf(bindings, renewal.provider).cancelRenewal(
              renewal.providerRef,
              renewal.providerSubscriptionId
            ),
          limit: REFUND_REARM_BATCH,
          now,
          providers,
        });
  const pendingRefundIncidents = await store.recordPendingRefundIncidents(now);
  const report = { pendingRefundIncidents, providersNotConfigured, rearm };
  if (rearm.failed > 0) {
    logger.error("billing_refund_safety_net_incomplete", {
      pendingRefundIncidents,
      rearm: { ...rearm },
    });
    throw new Error("billing_refund_safety_net_incomplete");
  }
  return report;
}
