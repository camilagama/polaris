import type { BillingProviderPort } from "@polaris/billing/provider-port";
import type {
  BillingStore,
  RenewalCancellationRearmReport,
} from "@polaris/db/billing-store";
import { renewalAlive } from "@polaris/domain/billing/renewal-cancellation";
import { outboxIdempotencyKey } from "@polaris/domain/events/outbox";
import type { QueueEnvelope } from "@polaris/domain/events/queue-envelope";
import { logger, opaqueId } from "@polaris/observability/logger";
import { PermanentHandlerError } from "../queue/consumer";
import { cancelRenewal, type OperatorCommandDependencies } from "./commands";

/**
 * Closing the organization cancels the renewal of its subscription (ADR 0074,
 * L4). The closure wrote `billing.renewal_cancel_requested` in its own
 * transaction; this is its consumer, on the critical queue. It reads the
 * billing record itself (never acting on the message alone) and, while the
 * renewal is alive, cancels it at the provider and writes the cancellation
 * through the billing inbox (`command:cancel_renewal:<event ID>`, one per
 * closure cycle). Paid access runs to its end; nothing is refunded. A provider
 * that fails throws: the queue retries, then the dead-letter queue makes an
 * incident, and the hourly billing run sends the event again while the state
 * still says the renewal is alive. The closure is never undone for it, and
 * undoing the closure does not stop it (B8): the request was made.
 */

/** An event dispatched this long ago whose renewal is still alive is sent again by the hourly run. */
export const RENEWAL_CANCEL_REARM_MIN_AGE_SECONDS = 3600;
export const RENEWAL_CANCEL_REARM_BATCH = 100;

export type RenewalCancelOutcome =
  | "already_cancelled"
  | "cancelled"
  | "not_handled"
  | "nothing_owed"
  | "nothing_to_cancel";

export interface RenewalCancelDependencies {
  /** Whether Polaris cancels through this provider (it has its adapter). */
  handles: (provider: string) => boolean;
  now?: () => Date;
  /** The provider's port; a provider without its settings throws, and the queue retries. */
  portFor: (provider: string) => BillingProviderPort;
  store: OperatorCommandDependencies["store"] &
    Pick<BillingStore, "readRecord">;
}

/** The closure cycle the event names; anything else is a forged or broken message, which a retry does not fix. */
function closureCycleOf(envelope: QueueEnvelope): number {
  const { requestedAt } = envelope.event;
  if (
    typeof requestedAt !== "number" ||
    !Number.isSafeInteger(requestedAt) ||
    requestedAt <= 0 ||
    envelope.idempotencyKey !==
      outboxIdempotencyKey(envelope.type, String(requestedAt))
  ) {
    throw new PermanentHandlerError("renewal_cancel_event_invalid");
  }
  return requestedAt;
}

export async function handleRenewalCancelRequested(
  dependencies: RenewalCancelDependencies,
  envelope: QueueEnvelope
): Promise<RenewalCancelOutcome> {
  closureCycleOf(envelope);
  const { organizationId } = envelope;
  const ids = {
    eventId: envelope.eventId,
    organizationId: opaqueId(organizationId),
  };
  const { store } = dependencies;
  const [record, link] = await Promise.all([
    store.readRecord(organizationId),
    store.readProviderLink(organizationId),
  ]);
  if (!(link && renewalAlive(record, link))) {
    // no provider, no Pro, or already cancelled: a repeat or a late message finds nothing to do
    logger.info("billing_renewal_cancel_skipped", {
      ...ids,
      reason: "nothing_owed",
    });
    return "nothing_owed";
  }
  if (!dependencies.handles(link.provider)) {
    // a provider Polaris does not cancel through yet: the panel says so, and the person cancels there
    logger.warn("billing_renewal_cancel_skipped", {
      ...ids,
      provider: link.provider,
      reason: "not_handled",
    });
    return "not_handled";
  }
  const result = await cancelRenewal(
    {
      ...(dependencies.now ? { now: dependencies.now } : {}),
      portFor: dependencies.portFor,
      store,
    },
    { organizationId, requestId: envelope.eventId }
  );
  if (result === "nothing_to_cancel" || result === "not_linked") {
    // the provider shows no subscription for the reference: nothing renews there; the record waits for its
    // fact (webhook or reconciliation) and the hourly run asks again while it still says alive
    logger.warn("billing_renewal_cancel_nothing_found", {
      ...ids,
      provider: link.provider,
    });
    return "nothing_to_cancel";
  }
  logger.info("billing_renewal_cancelled_at_closure", {
    ...ids,
    provider: link.provider,
    reason: result,
  });
  return result;
}

/**
 * The hourly retry by state (V6): never a new key for the same closure cycle,
 * only the cycle's own event written when missing or sent back to pending.
 */
export async function rearmRenewalCancellations(
  store: Pick<BillingStore, "rearmRenewalCancellations">
): Promise<RenewalCancellationRearmReport> {
  const report = await store.rearmRenewalCancellations(
    RENEWAL_CANCEL_REARM_MIN_AGE_SECONDS,
    RENEWAL_CANCEL_REARM_BATCH
  );
  if (report.inserted > 0 || report.rearmed > 0) {
    // each one is a renewal still alive an hour or more after its closure: the alert reads this
    logger.warn("billing_renewal_cancel_rearmed", { ...report });
  }
  return report;
}
