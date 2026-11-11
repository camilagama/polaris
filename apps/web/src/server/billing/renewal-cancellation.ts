import { cancelRenewal } from "@polaris/billing/operator-commands";
import {
  type BillingProviderPort,
  ProviderNotFoundError,
} from "@polaris/billing/provider-port";
import type {
  BillingProviderLink,
  BillingStore,
  RenewalCancellationRearmReport,
} from "@polaris/db/billing-store";
import {
  checkoutOpen,
  HANDLED_BILLING_PROVIDERS,
  renewalAlive,
} from "@polaris/domain/billing/renewal-cancellation";
import { outboxIdempotencyKey } from "@polaris/domain/events/outbox";
import type { QueueEnvelope } from "@polaris/domain/events/queue-envelope";
import { logger, opaqueId } from "@polaris/observability/logger";
import { PermanentHandlerError } from "../queue/consumer";
import {
  type OperatorCommandDependencies,
  reconcileOrganization,
} from "./commands";

/**
 * Closing the organization cancels the renewal of its subscription (ADR 0074,
 * L4). The closure wrote `billing.renewal_cancel_requested` in its own
 * transaction; this is its consumer, on the critical queue. It reads the
 * billing record itself (never acting on the message alone) and, while the
 * renewal is alive, cancels it at the provider and writes the cancellation
 * through the billing inbox (`cancelRenewalEventId`: one per closure cycle and
 * subscription). Paid access runs to its end; nothing is refunded. A checkout
 * linked before the closure and not paid yet is given up at the provider, so it
 * cannot charge a closed store or start its trial there, and the ledger records
 * it (once per checkout; the hourly run does not ask for it again: the checkout
 * expires within the hour, and a failure past the queue's retries is the
 * dead-letter incident's). A provider that fails throws: the queue retries, then the dead-letter queue makes an
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
  | "checkout_discarded"
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
    Pick<
      BillingStore,
      | "checkoutDiscarded"
      | "readRecord"
      | "recordCheckoutDiscarded"
      | "recordClosureRefundIncident"
    >;
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
  let [record, link] = await Promise.all([
    store.readRecord(organizationId),
    store.readProviderLink(organizationId),
  ]);
  if (link && checkoutOpen(record, link, false)) {
    const discarded = await discardOpenCheckout(
      dependencies,
      envelope,
      link,
      ids
    );
    if (discarded === "subscribed_cancelled") {
      // the give-up itself ended the subscription the approval made, and its facts were just read in
      logger.info("billing_renewal_cancelled_at_closure", {
        ...ids,
        provider: link.provider,
        reason: "subscribed_cancelled",
      });
      return "cancelled";
    }
    if (discarded !== "subscribed") {
      return discarded;
    }
    // the checkout was paid before it could be given up: its facts were just read in, and the subscription
    // is cancelled like any live renewal. One whose facts do not apply (a trial no reservation pays for)
    // throws: the queue retries, then the dead-letter queue makes an incident, never a silent "cancelled"
    [record, link] = await Promise.all([
      store.readRecord(organizationId),
      store.readProviderLink(organizationId),
    ]);
    if (!(link && renewalAlive(record, link))) {
      throw new Error("billing_closure_checkout_subscription_unapplied");
    }
  }
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
 * Gives up the checkout linked before the closure and not paid yet, then
 * writes it in the ledger; a checkout the ledger already has is not asked
 * again. The provider answers `already_closed` for one cancelled before, one it
 * does not know, and also one already paid: then the provider is asked whether
 * the checkout made a subscription, and if it did, its facts are read in
 * (`reconcileOrganization`) and nothing is written as given up (`subscribed`).
 * The provider is asked the same after `discarded`, because an approval can land
 * between the read and the cancel: the cancel then ended the subscription, its
 * facts are read in, nothing is written as given up and the answer is
 * `subscribed_cancelled` (nothing is left to cancel). A first charge paid at
 * that approval opens the pending-refund incident; the retry of a delivery
 * that died after the cancel (the provider then answers `already_closed`) opens
 * it too when the renewal is already ended. A failure throws, and the queue
 * retries.
 */
async function discardOpenCheckout(
  dependencies: RenewalCancelDependencies,
  envelope: QueueEnvelope,
  link: BillingProviderLink,
  ids: { eventId: string; organizationId: ReturnType<typeof opaqueId> }
): Promise<RenewalCancelOutcome | "subscribed" | "subscribed_cancelled"> {
  const { store } = dependencies;
  if (!dependencies.handles(link.provider)) {
    logger.warn("billing_renewal_cancel_skipped", {
      ...ids,
      provider: link.provider,
      reason: "not_handled",
    });
    return "not_handled";
  }
  if (await store.checkoutDiscarded(envelope.organizationId, link)) {
    logger.info("billing_renewal_cancel_skipped", {
      ...ids,
      reason: "nothing_owed",
    });
    return "nothing_owed";
  }
  const port = dependencies.portFor(link.provider);
  // for Asaas the reference is the checkout's own ID
  const answer = await port.discardCheckout(link.providerRef);
  if (!(await madeSubscription(port, link))) {
    return await recordDiscard(dependencies, envelope, link, ids, answer);
  }
  const closedBefore = answer === "already_closed";
  logger.warn(
    closedBefore
      ? "billing_checkout_paid_before_closure_discard"
      : "billing_checkout_approved_during_closure_discard",
    { ...ids, provider: link.provider }
  );
  const report = await reconcileOrganization(
    {
      ...(dependencies.now ? { now: dependencies.now } : {}),
      portFor: dependencies.portFor,
      store,
    },
    envelope.organizationId
  );
  if (report.chargesSucceeded === 0) {
    return closedBefore ? "subscribed" : "subscribed_cancelled";
  }
  // a first charge paid and the renewal already ended: either this run's cancel did it, or an earlier delivery's
  // did and died before writing the incident (the provider then answers `already_closed`); a paid checkout whose
  // renewal is alive is an ordinary subscription for the closure to cancel
  if (closedBefore && (await renewalStillAlive(store, envelope))) {
    return "subscribed";
  }
  await openPaidCheckoutRefundIncident(dependencies, envelope, link, ids);
  return "subscribed_cancelled";
}

async function renewalStillAlive(
  store: RenewalCancelDependencies["store"],
  envelope: QueueEnvelope
): Promise<boolean> {
  const [record, link] = await Promise.all([
    store.readRecord(envelope.organizationId),
    store.readProviderLink(envelope.organizationId),
  ]);
  return Boolean(link && renewalAlive(record, link));
}

/**
 * The cancel ended a subscription whose first charge was paid at the approval: the payer paid for a store that is
 * closed, so the operator refunds by hand. A failure to write it throws: the queue retries, and the ledger row is
 * keyed by the request, so a repeat adds nothing.
 */
async function openPaidCheckoutRefundIncident(
  dependencies: RenewalCancelDependencies,
  envelope: QueueEnvelope,
  link: BillingProviderLink,
  ids: { eventId: string; organizationId: ReturnType<typeof opaqueId> }
): Promise<void> {
  await dependencies.store.recordClosureRefundIncident(
    {
      link,
      organizationId: envelope.organizationId,
      requestId: envelope.eventId,
    },
    dependencies.now?.() ?? new Date()
  );
  logger.error("billing_closure_paid_checkout_refund_pending", {
    ...ids,
    provider: link.provider,
  });
}

async function recordDiscard(
  dependencies: RenewalCancelDependencies,
  envelope: QueueEnvelope,
  link: BillingProviderLink,
  ids: { eventId: string; organizationId: ReturnType<typeof opaqueId> },
  answer: "already_closed" | "discarded"
): Promise<RenewalCancelOutcome> {
  const { store } = dependencies;
  await store.recordCheckoutDiscarded(
    {
      link,
      organizationId: envelope.organizationId,
      requestId: envelope.eventId,
    },
    dependencies.now?.() ?? new Date()
  );
  logger.info("billing_checkout_discarded_at_closure", {
    ...ids,
    provider: link.provider,
    reason: answer,
  });
  return "checkout_discarded";
}

/** Whether the provider made a subscription from the checkout; a "not found" is what a checkout nobody paid looks like. */
async function madeSubscription(
  port: BillingProviderPort,
  link: BillingProviderLink
): Promise<boolean> {
  try {
    return await port.hasSubscription(link.providerRef, null);
  } catch (error: unknown) {
    if (error instanceof ProviderNotFoundError) {
      return false;
    }
    throw error;
  }
}

/**
 * The hourly retry by state (V6): never a new key for the same closure cycle,
 * only the cycle's own event written when missing or sent back to pending, and
 * only at a provider Polaris cancels through (another is the person's to cancel:
 * asking again every hour would change nothing).
 */
export async function rearmRenewalCancellations(
  store: Pick<BillingStore, "rearmRenewalCancellations">
): Promise<RenewalCancellationRearmReport> {
  const report = await store.rearmRenewalCancellations(
    RENEWAL_CANCEL_REARM_MIN_AGE_SECONDS,
    RENEWAL_CANCEL_REARM_BATCH,
    HANDLED_BILLING_PROVIDERS
  );
  if (report.inserted > 0 || report.rearmed > 0) {
    // each one is a renewal still alive an hour or more after its closure: the alert reads this
    logger.warn("billing_renewal_cancel_rearmed", { ...report });
  }
  return report;
}
