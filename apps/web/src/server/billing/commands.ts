import {
  type BillingProviderPort,
  ProviderNotFoundError,
  ProviderUnavailableError,
} from "@polaris/billing/provider-port";
import type {
  BillingStore,
  UnclaimedTrialEvent,
  UnclaimedTrialOutcome,
} from "@polaris/db/billing-store";
import { grantsPro } from "@polaris/domain/billing/entitlements";
import type { BillingCycleMonths } from "@polaris/domain/billing/facts";
import { saoPauloDateOf } from "@polaris/domain/billing/provider-period";
import { TRIAL_DAYS } from "@polaris/domain/billing/subscription-state";
import { logger, opaqueId } from "@polaris/observability/logger";
import { describeError } from "@polaris/observability/wide-event";
import { sha256Hex } from "../../lib/canonical-json";

/**
 * The billing commands (ADR 0101): start the checkout, and the operator's
 * reconcile, refund and cancel, plus the settling of trials no reservation
 * paid for. They talk to the provider only through its port and to the billing
 * records only through the store; the caller authorizes first (the checkout
 * runs as the owner, with `billing:manage`; the others are for scripts and,
 * later, the Admin). Nothing the provider answers reaches a log: only codes,
 * counts and opaque IDs. The checkout link is the payer's and is never logged.
 */

const DAY_MS = 86_400_000;

export type BillingCommandErrorCode =
  | "already_subscribed"
  | "checkout_pending_confirmation"
  | "cycle_not_offered"
  | "renewal_cancelled_until"
  | "trial_already_used"
  | "trial_in_progress";

/**
 * A refusal the person can act on; the code goes to the client as the reason.
 * `until` is the end of the paid access, for `renewal_cancelled_until`: a new
 * subscription starts only after it (the client shows the date).
 */
export class BillingCommandError extends Error {
  readonly code: BillingCommandErrorCode;
  readonly until: Date | null;

  constructor(
    code: BillingCommandErrorCode,
    options?: ErrorOptions & { until?: Date }
  ) {
    super(code, options);
    this.name = "BillingCommandError";
    this.code = code;
    this.until = options?.until ?? null;
  }
}

/** Picks the price of the Pro cycle among the active prices; a cycle with none is not offered. */
export function checkoutPriceOf(
  prices: readonly { amount: string; intervalMonths: number; planId: string }[],
  cycleMonths: BillingCycleMonths
): string {
  const price = prices.find(
    (entry) => entry.planId === "pro" && entry.intervalMonths === cycleMonths
  );
  if (!price) {
    throw new BillingCommandError("cycle_not_offered");
  }
  return price.amount;
}

/**
 * The day of the first charge, in São Paulo: the day the trial ends (7 days
 * from now; the checkout is finished within the hour), or today without one.
 */
export function firstChargeDateOf(now: Date, trial: boolean): string {
  return saoPauloDateOf(
    trial ? new Date(now.getTime() + TRIAL_DAYS * DAY_MS) : now
  );
}

const trialRefusals: Readonly<Record<string, BillingCommandErrorCode>> = {
  // the person's trial was used (ADR 0101), or this organization's own
  trial_already_consumed: "trial_already_used",
  trial_already_used: "trial_already_used",
  trial_in_progress: "trial_in_progress",
};

function trialRefusalOf(error: unknown): BillingCommandError | null {
  if (!(error instanceof Error)) {
    return null;
  }
  const code =
    "code" in error && typeof error.code === "string"
      ? error.code
      : error.message;
  const refusal = Object.hasOwn(trialRefusals, code)
    ? trialRefusals[code]
    : undefined;
  return refusal ? new BillingCommandError(refusal, { cause: error }) : null;
}

export interface StartCheckoutInput {
  /** The price of one cycle, read from `billing_prices` (money.md); never from the client. */
  amount: string;
  cycleMonths: BillingCycleMonths;
  /** The organization of the server's context, never the client's claim. */
  organizationId: string;
  trial: boolean;
  /** The authenticated user of the session: the trial is once per person. */
  userId: string;
}

export interface StartCheckoutDependencies {
  now?: () => Date;
  port: BillingProviderPort;
  store: Pick<
    BillingStore,
    | "attachProvider"
    | "processEvent"
    | "readProviderLink"
    | "readRecord"
    | "recordEvent"
    | "startTrial"
  >;
}

/**
 * Before the organization's checkout is replaced by a new one, asks the
 * provider whether the old one already made a subscription (it was paid and its
 * webhook has not arrived: `provider_subscription_id` is still null). That
 * subscription would stay alive and charge with no organization behind it, so
 * the new checkout is refused (`checkout_pending_confirmation`) and the old
 * facts are read into the inbox now. A provider that cannot answer refuses too
 * (`provider_unavailable`): the swap is never made blind. Only here a provider's
 * "not found" is an empty answer: it is what a checkout nobody paid looks like.
 */
async function assertOldCheckoutMadeNoSubscription(
  dependencies: StartCheckoutDependencies,
  input: StartCheckoutInput,
  now: Date,
  ids: { organizationId: ReturnType<typeof opaqueId>; provider: string }
): Promise<void> {
  const { port, store } = dependencies;
  const link = await store.readProviderLink(input.organizationId);
  if (
    !link ||
    link.provider !== port.provider ||
    link.providerSubscriptionId !== null
  ) {
    // nothing linked, another provider's, or a subscription already matched
    return;
  }
  let subscribed: boolean;
  try {
    subscribed = await port.hasSubscription(link.providerRef, null);
  } catch (error: unknown) {
    if (error instanceof ProviderNotFoundError) {
      return;
    }
    logger.warn("billing_checkout_swap_check_failed", {
      ...describeError(error),
      ...ids,
    });
    // biome-ignore lint/style/useErrorCause: the cause is passed in the options object.
    throw new ProviderUnavailableError({ cause: error });
  }
  if (!subscribed) {
    return;
  }
  await reconcileOrganization(
    {
      now: () => now,
      portFor: () => port,
      store,
    },
    input.organizationId
  ).catch((error: unknown) => {
    // the refusal stands; the operator's reconciliation reads it again
    logger.warn("billing_checkout_pending_reconcile_failed", {
      ...describeError(error),
      ...ids,
    });
  });
  const reconciled = await store
    .readRecord(input.organizationId)
    .catch(() => null);
  if (reconciled && grantsPro(reconciled.state)) {
    // the old fact applied just now: the subscription is the organization's
    throw new BillingCommandError("already_subscribed");
  }
  logger.warn("billing_checkout_pending_confirmation", ids);
  throw new BillingCommandError("checkout_pending_confirmation");
}

/**
 * Starts the card checkout. The order is the point (AC-6): the trial is
 * reserved first (with a trial), then the checkout is created at the
 * provider, then its reference is linked to the organization, and only then
 * is the link handed over, so a payment can never arrive for a checkout that
 * no organization holds. Before any of it, a checkout of the organization that
 * the provider already turned into a subscription (paid, webhook late) is not
 * replaced: the new one is refused and the old facts are read in. If the link fails, the checkout is given up at the
 * provider (best effort; it expires within the hour anyway).
 */
export async function startCardCheckout(
  dependencies: StartCheckoutDependencies,
  input: StartCheckoutInput
): Promise<{ handoff: { kind: "redirect"; url: string } }> {
  const { port, store } = dependencies;
  const now = dependencies.now?.() ?? new Date();
  const ids = {
    organizationId: opaqueId(input.organizationId),
    provider: port.provider,
  };
  const record = await store.readRecord(input.organizationId);
  if (record && grantsPro(record.state)) {
    if (record.cancelAtPeriodEnd && record.accessEndsAt) {
      // the renewal was cancelled (a closure, even one undone, or the operator): the subscription is not
      // created again (B8), and a new one waits for the end of the access already paid for (ADR 0074)
      throw new BillingCommandError("renewal_cancelled_until", {
        until: record.accessEndsAt,
      });
    }
    // a trial running, a paid period or grace: nothing to start
    throw new BillingCommandError("already_subscribed");
  }
  await assertOldCheckoutMadeNoSubscription(dependencies, input, now, ids);
  if (input.trial) {
    try {
      await store.startTrial(input.organizationId, input.userId, now);
    } catch (error: unknown) {
      throw trialRefusalOf(error) ?? error;
    }
  }
  const prepared = await port.prepareSubscription({
    amount: input.amount,
    cycleMonths: input.cycleMonths,
    firstChargeOn: firstChargeDateOf(now, input.trial),
  });
  const { handoff } = prepared;
  let replaced: Awaited<ReturnType<typeof store.attachProvider>> = null;
  try {
    if (handoff.kind !== "redirect") {
      // the card is typed on the provider's page: anything else is not this checkout
      throw new Error("billing_unexpected_handoff");
    }
    replaced = await store.attachProvider(
      input.organizationId,
      port.provider,
      prepared.providerRef
    );
  } catch (error: unknown) {
    await port.discardCheckout(prepared.checkoutId).catch((discard) => {
      logger.warn("billing_checkout_discard_failed", {
        ...describeError(discard),
        ...ids,
      });
    });
    if (
      error instanceof Error &&
      error.message === "billing_provider_already_attached"
    ) {
      // a subscription became live in between
      throw new BillingCommandError("already_subscribed", { cause: error });
    }
    throw error;
  }
  if (
    replaced &&
    replaced.provider === port.provider &&
    replaced.providerRef !== prepared.providerRef
  ) {
    // a checkout started before (a second tab, a retry) must not stay payable:
    // its payment would find no organization while the provider charges it
    await port.discardCheckout(replaced.providerRef).catch((discard) => {
      logger.warn("billing_checkout_discard_failed", {
        ...describeError(discard),
        ...ids,
      });
    });
  }
  logger.info("billing_checkout_started", {
    ...ids,
    cycleMonths: input.cycleMonths,
    trial: input.trial,
  });
  return { handoff: { kind: "redirect", url: handoff.url } };
}

export interface OperatorCommandDependencies {
  now?: () => Date;
  /** The port of the provider an organization is linked to. */
  portFor: (provider: string) => BillingProviderPort;
  store: Pick<
    BillingStore,
    | "listUnclaimedTrials"
    | "processEvent"
    | "readProviderLink"
    | "recordEvent"
    | "settleUnclaimedTrial"
  >;
}

export interface ReconcileReport {
  applied: number;
  duplicates: number;
  failed: number;
  ignored: number;
  linked: boolean;
  read: number;
  unresolved: number;
}

/**
 * Reads the organization's subscription at the provider and writes what it
 * shows through the same inbox as the webhooks (Q8): the same mapper, IDs that
 * make a repeat a duplicate, the same order and reference checks. The
 * subscription is read by the stored `sub_`; the scan by checkout is only for
 * when no webhook ever matched (the port decides).
 */
export async function reconcileOrganization(
  dependencies: Omit<OperatorCommandDependencies, "store"> & {
    store: Pick<
      BillingStore,
      "processEvent" | "readProviderLink" | "recordEvent"
    >;
  },
  organizationId: string
): Promise<ReconcileReport> {
  const { store } = dependencies;
  const now = dependencies.now?.() ?? new Date();
  const report: ReconcileReport = {
    applied: 0,
    duplicates: 0,
    failed: 0,
    ignored: 0,
    linked: false,
    read: 0,
    unresolved: 0,
  };
  const link = await store.readProviderLink(organizationId);
  if (!link) {
    return report;
  }
  report.linked = true;
  const port = dependencies.portFor(link.provider);
  const events = await port.readState(
    link.providerRef,
    now,
    link.providerSubscriptionId
  );
  report.read = events.length;
  for (const event of events) {
    // biome-ignore lint/performance/noAwaitInLoops: Facts are stored and applied in the order the provider shows them.
    const stored = await store.recordEvent({
      fact: event.fact,
      provider: port.provider,
      providerEventId: event.providerEventId,
      providerRef: event.providerRef,
      providerSubscriptionId: event.providerSubscriptionId ?? null,
    });
    if (stored.duplicate) {
      report.duplicates += 1;
    }
    const result = await store.processEvent(stored.id, now);
    report[result.status === "received" ? "failed" : result.status] += 1;
  }
  logger.info("billing_reconcile_complete", {
    ...report,
    organizationId: opaqueId(organizationId),
    provider: port.provider,
  });
  return report;
}

/** Refunds in full the charge of the period in force; the fact comes back by webhook or reconciliation. */
export async function refundCurrentPeriod(
  dependencies: OperatorCommandDependencies,
  organizationId: string
): Promise<"nothing_to_refund" | "not_linked" | "refund_requested"> {
  const now = dependencies.now?.() ?? new Date();
  const link = await dependencies.store.readProviderLink(organizationId);
  if (!link) {
    return "not_linked";
  }
  const port = dependencies.portFor(link.provider);
  const result = await port.refundCurrentPeriod(
    link.providerRef,
    now,
    link.providerSubscriptionId
  );
  logger.info("billing_refund_command", {
    organizationId: opaqueId(organizationId),
    provider: port.provider,
    reason: result,
  });
  return result;
}

/**
 * The ID of the cancellation fact: one per request and per subscription. The
 * same request repeated for the same subscription is a duplicate; repeated
 * after the organization subscribed again (a new reference), it is a fact of
 * its own and applies, so the record says what the provider did. The reference
 * goes in as a digest: the ID has a bounded length, and the reference is kept in
 * its own column.
 */
export async function cancelRenewalEventId(
  requestId: string,
  providerRef: string
): Promise<string> {
  const digest = await sha256Hex(providerRef);
  return `command:cancel_renewal:${requestId}:${digest.slice(0, 32)}`;
}

/**
 * Cancels the renewal at the provider; access already paid for runs to its end.
 * The cancellation is written through the inbox at once
 * (`cancelRenewalEventId`), so the record does not wait for the provider's
 * webhook; the webhook that follows is a duplicate by value.
 */
export async function cancelRenewal(
  dependencies: OperatorCommandDependencies,
  input: { organizationId: string; requestId: string }
): Promise<
  "already_cancelled" | "cancelled" | "not_linked" | "nothing_to_cancel"
> {
  const { store } = dependencies;
  const now = dependencies.now?.() ?? new Date();
  const link = await store.readProviderLink(input.organizationId);
  if (!link) {
    return "not_linked";
  }
  const port = dependencies.portFor(link.provider);
  const result = await port.cancelRenewal(
    link.providerRef,
    link.providerSubscriptionId
  );
  if (result !== "nothing_to_cancel") {
    const stored = await store.recordEvent({
      fact: { occurredAt: now, type: "subscription_cancelled" },
      organizationId: input.organizationId,
      provider: port.provider,
      providerEventId: await cancelRenewalEventId(
        input.requestId,
        link.providerRef
      ),
      providerRef: link.providerRef,
    });
    await store.processEvent(stored.id, now);
  }
  logger.info("billing_cancel_renewal_command", {
    organizationId: opaqueId(input.organizationId),
    provider: port.provider,
    reason: result,
  });
  return result;
}

/**
 * Cancels the subscription of an unclaimed trial at the provider, unless the
 * provider shows one of its charges already paid (`paid`: the person was
 * charged, and the paid access is not taken away here). The event proves the
 * subscription exists, so a provider that finds nothing to cancel is an error:
 * the event stays pending and the next pass reads it again.
 */
async function cancelUnclaimed(
  dependencies: Pick<OperatorCommandDependencies, "portFor">,
  unclaimed: UnclaimedTrialEvent,
  now: Date
): Promise<"cancelled" | "paid"> {
  const port = dependencies.portFor(unclaimed.provider);
  const state = await port.readState(
    unclaimed.providerRef,
    now,
    unclaimed.providerSubscriptionId
  );
  if (state.some((event) => event.fact.type === "charge_succeeded")) {
    return "paid";
  }
  const result = await port.cancelRenewal(
    unclaimed.providerRef,
    unclaimed.providerSubscriptionId
  );
  if (result === "nothing_to_cancel") {
    throw new Error("billing_unclaimed_subscription_not_found");
  }
  return "cancelled";
}

export interface UnclaimedTrialsReport {
  cancelled: number;
  failed: number;
  leftPaid: number;
  scanned: number;
}

/**
 * Settles the trials no reservation paid for (`trial_claim_missing`, past their
 * retries). Decision (ADR 0101): the subscription is cancelled at the provider
 * before its first charge, so nobody is charged without the trial they chose
 * without consenting to it; the reason is written in the billing ledger. A
 * subscription that already gives Pro on the same reference is left alone. A
 * failure leaves the event for the next pass and never hides the others.
 */
export async function settleUnclaimedTrials(
  dependencies: Omit<OperatorCommandDependencies, "store"> & {
    store: Pick<BillingStore, "listUnclaimedTrials" | "settleUnclaimedTrial">;
  },
  limit = 20
): Promise<UnclaimedTrialsReport> {
  const { store } = dependencies;
  const now = dependencies.now?.() ?? new Date();
  const pending = await store.listUnclaimedTrials(limit);
  const report: UnclaimedTrialsReport = {
    cancelled: 0,
    failed: 0,
    leftPaid: 0,
    scanned: pending.length,
  };
  const counted: Record<
    UnclaimedTrialOutcome,
    keyof UnclaimedTrialsReport | null
  > = { cancelled: "cancelled", left_paid: "leftPaid", not_pending: null };
  for (const event of pending) {
    const ids = {
      eventId: event.eventId,
      organizationId: opaqueId(event.organizationId),
      provider: event.provider,
    };
    try {
      // biome-ignore lint/performance/noAwaitInLoops: One provider call at a time, each under its own lock.
      const outcome = await store.settleUnclaimedTrial(
        event.eventId,
        (unclaimed) => cancelUnclaimed(dependencies, unclaimed, now),
        now
      );
      const key = counted[outcome];
      if (key) {
        report[key] += 1;
      }
      logger.warn("billing_unclaimed_trial_settled", {
        ...ids,
        reason: outcome,
      });
    } catch (error: unknown) {
      report.failed += 1;
      logger.error("billing_unclaimed_trial_settle_failed", {
        ...describeError(error),
        ...ids,
      });
    }
  }
  return report;
}
