import type {
  BillingProviderLink,
  BillingStore,
} from "@polaris/db/billing-store";
import { grantsPro } from "@polaris/domain/billing/entitlements";
import { Money } from "@polaris/domain/money/money";
import { logger, opaqueId } from "@polaris/observability/logger";
import { describeError } from "@polaris/observability/wide-event";
import type { BillingProviderPort } from "./provider-port";

/**
 * The operator's provider commands (ADR 0101, ADR 0066 and the ADR of the Admin's provider commands): cancel the
 * renewal and refund the period in force. One implementation for every caller: the closure's consumer and the hourly
 * net of the web (the cancellation), the Gate 7 script and the Admin. They talk to the provider only through its port
 * and to the billing records only through the store; the caller authorizes first. Nothing the provider answers
 * reaches a log or the caller: only result codes, the provider's name and opaque IDs.
 */

export interface ProviderCommandDependencies {
  now?: () => Date;
  /** The port of the provider an organization is linked to. */
  portFor: (provider: string) => BillingProviderPort;
}

export interface CancelRenewalDependencies extends ProviderCommandDependencies {
  store: Pick<
    BillingStore,
    "processEvent" | "readProviderLink" | "recordEvent"
  >;
}

export interface RefundCommandDependencies extends ProviderCommandDependencies {
  store: Pick<
    BillingStore,
    | "processEvent"
    | "readCurrentCharge"
    | "readProviderLink"
    | "readRecord"
    | "recordAmountMismatchIncident"
    | "recordEvent"
    | "recordOperatorDecision"
    | "withOrganizationLock"
  >;
}

export interface OperatorCancelDependencies
  extends ProviderCommandDependencies {
  store: Pick<
    BillingStore,
    | "processEvent"
    | "readProviderLink"
    | "recordEvent"
    | "recordOperatorDecision"
    | "withOrganizationLock"
  >;
}

/** Who decided and why, written in the billing ledger before the provider is asked (the Admin's commands). */
export interface OperatorDecision {
  /** `admin:<principalId>`: a stable identifier, never an e-mail. */
  actor: string;
  reason: string;
}

export type CancelRenewalResult =
  | "already_cancelled"
  | "cancelled"
  | "not_linked"
  | "nothing_to_cancel";

export type RefundResult =
  | "amount_changed"
  | "amount_mismatch"
  | "nothing_to_refund"
  | "not_linked"
  | "refund_not_supported"
  | "refund_requested";

/** Hex SHA-256 of a text. */
async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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
 * The ID of the cancellation a refund makes first: its own prefix, so it is
 * told apart from the owner's cancellation (no "renewal cancelled" notice for
 * it), and, like `cancelRenewalEventId`, one per request and per subscription.
 */
export async function refundCancelEventId(
  requestId: string,
  providerRef: string
): Promise<string> {
  const digest = await sha256Hex(providerRef);
  return `command:refund_cancel:${requestId}:${digest.slice(0, 32)}`;
}

/** Cancels at the provider the renewal of the link, and writes the cancellation through the inbox at once. */
async function cancelLinked(
  dependencies: CancelRenewalDependencies,
  input: {
    link: BillingProviderLink;
    organizationId: string;
    port: BillingProviderPort;
    requestId: string;
  }
): Promise<Exclude<CancelRenewalResult, "not_linked">> {
  const { link, port } = input;
  const now = dependencies.now?.() ?? new Date();
  const result = await port.cancelRenewal(
    link.providerRef,
    link.providerSubscriptionId
  );
  if (result !== "nothing_to_cancel") {
    const stored = await dependencies.store.recordEvent({
      fact: { occurredAt: now, type: "subscription_cancelled" },
      organizationId: input.organizationId,
      provider: port.provider,
      providerEventId: await cancelRenewalEventId(
        input.requestId,
        link.providerRef
      ),
      providerRef: link.providerRef,
    });
    await dependencies.store.processEvent(stored.id, now);
  }
  logger.info("billing_cancel_renewal_command", {
    organizationId: opaqueId(input.organizationId),
    provider: port.provider,
    reason: result,
  });
  return result;
}

/**
 * Cancels the renewal at the provider; access already paid for runs to its end.
 * The cancellation is written through the inbox at once
 * (`cancelRenewalEventId`), so the record does not wait for the provider's
 * webhook; the webhook that follows is a duplicate by value. It takes no lock:
 * the closure's consumer calls it, and a second cancellation is ignored by the
 * record. The operator's, from the Admin, is `operatorCancelRenewal`.
 */
export async function cancelRenewal(
  dependencies: CancelRenewalDependencies,
  input: { organizationId: string; requestId: string }
): Promise<CancelRenewalResult> {
  const link = await dependencies.store.readProviderLink(input.organizationId);
  if (!link) {
    return "not_linked";
  }
  return await cancelLinked(dependencies, {
    link,
    organizationId: input.organizationId,
    port: dependencies.portFor(link.provider),
    requestId: input.requestId,
  });
}

/**
 * The operator's cancellation of the renewal (the Admin): under the
 * organization's lock, so it never runs at the same time as the owner's
 * commands or a refund of the same store (`BillingCommandInProgressError`), and
 * the decision (actor and reason) is written in the ledger before the provider
 * is asked. The command ID is the request ID: a repeat after an unknown result
 * is the same fact (a duplicate) and the provider answers `already_cancelled`.
 */
export async function operatorCancelRenewal(
  dependencies: OperatorCancelDependencies,
  input: {
    commandId: string;
    decision: OperatorDecision;
    organizationId: string;
  }
): Promise<CancelRenewalResult> {
  const { store } = dependencies;
  return await store.withOrganizationLock(input.organizationId, async () => {
    const link = await store.readProviderLink(input.organizationId);
    if (!link) {
      return "not_linked";
    }
    // a provider that cannot be reached from here refuses before anything is written
    const port = dependencies.portFor(link.provider);
    await store.recordOperatorDecision(
      {
        ...input.decision,
        commandId: input.commandId,
        kind: "cancel_renewal",
        organizationId: input.organizationId,
      },
      dependencies.now?.() ?? new Date()
    );
    const result = await cancelLinked(dependencies, {
      link,
      organizationId: input.organizationId,
      port,
      requestId: input.commandId,
    });
    operatorCommandDone("cancel_renewal", input.organizationId, port, result);
    return result;
  });
}

/** The event the alert of the operator's commands reads (`alerts.ts`): one per command that reached the provider. */
function operatorCommandDone(
  command: "cancel_renewal" | "refund",
  organizationId: string,
  port: BillingProviderPort,
  result: string
): void {
  logger.warn("billing_operator_command", {
    operation: `billing.${command}`,
    organizationId: opaqueId(organizationId),
    provider: port.provider,
    reason: result,
  });
}

/** The amount of the charge is not the one the operator saw: nothing was cancelled or refunded. */
class AmountChangedError extends Error {
  constructor() {
    super("amount_changed");
    this.name = "AmountChangedError";
  }
}

/**
 * The amount the record holds for the charge in force is not the one the provider has for it: nothing was cancelled
 * or refunded, and the divergence is an operational incident.
 */
class AmountMismatchError extends Error {
  constructor() {
    super("amount_mismatch");
    this.name = "AmountMismatchError";
  }
}

/**
 * Why the charge the provider has is not the amount the operator saw, decided here and never by the screen (ADR
 * 0105). The record holds the same amount as the provider: the operator only read it before it changed (a renewal, a
 * repeat), `amount_changed`. The record holds another: the amount in force it keeps is wrong, which the write of every
 * charge should never let happen; one occurrence of the incident `billing_amount_mismatch` names its ledger row, and
 * the log names the store's opaque ID and the provider, no amount and no reference. Without an amount recorded there
 * is nothing to disagree with (the Admin offers no refund then), so no incident.
 */
async function amountRefusal(
  store: RefundCommandDependencies["store"],
  input: { charged: bigint; organizationId: string; provider: string }
): Promise<Error> {
  const recorded = await store.readCurrentCharge(input.organizationId);
  if (
    recorded.eventId === null ||
    recorded.amount === null ||
    Money.from(recorded.amount).minorUnits === input.charged
  ) {
    return new AmountChangedError();
  }
  const fields = {
    organizationId: opaqueId(input.organizationId),
    provider: input.provider,
  };
  logger.warn("billing_refund_amount_mismatch", fields);
  try {
    await store.recordAmountMismatchIncident(recorded.eventId);
  } catch (error: unknown) {
    // the refund stays refused either way; the alert of this event stands for the incident that was not written
    logger.error("billing_amount_mismatch_incident_failed", {
      ...describeError(error),
      ...fields,
    });
  }
  return new AmountMismatchError();
}

/** The amount as `money.md` writes it, or a refusal before anything is read. */
function expectedMinorUnits(expectedAmount: string | undefined): bigint | null {
  if (expectedAmount === undefined) {
    return null;
  }
  const { minorUnits } = Money.from(expectedAmount);
  if (minorUnits <= 0n) {
    throw new TypeError("invalid_expected_amount");
  }
  return minorUnits;
}

/**
 * Refunds in full the charge of the period in force, after cancelling the
 * renewal (ADR 0066): a refund leaves the subscription alive at the provider,
 * and its next charge would give Pro back and charge again. Under the
 * organization's lock, in this order: the charge to refund is read; when the
 * caller names `expectedAmount` (the Admin always does: the amount in force the
 * operator saw) and the charge's is another, it answers `amount_changed`, or
 * `amount_mismatch` with an incident when the record itself holds another
 * amount than the provider (`amountRefusal`), and nothing is cancelled or
 * refunded; the operator's decision is written in the ledger; the
 * renewal is cancelled, unless the record already shows it cancelled (by the
 * owner, an earlier request whose refund failed, or the closure); and that same
 * charge is refunded. A charge already refunded, or being refunded, is not one
 * the provider offers again (`nothing_to_refund`): a repeat, with the same or
 * another request ID, never refunds twice. A cancellation that fails refunds
 * nothing; a refund that fails after it leaves "Pro until the end", and a
 * repeat finishes it. The refund fact comes back by webhook or reconciliation
 * (Asaas), or the port answers it and it is written here (Woovi: its refund
 * event names no subscription). A provider that does not refund here (Pix while
 * its refund is off) is `refund_not_supported`, before anything is touched.
 */
export async function refundCurrentPeriod(
  dependencies: RefundCommandDependencies,
  input: {
    decision?: OperatorDecision;
    expectedAmount?: string;
    organizationId: string;
    requestId: string;
  }
): Promise<RefundResult> {
  const { store } = dependencies;
  const now = dependencies.now?.() ?? new Date();
  const expected = expectedMinorUnits(input.expectedAmount);
  return await store.withOrganizationLock(input.organizationId, async () => {
    const link = await store.readProviderLink(input.organizationId);
    if (!link) {
      return "not_linked";
    }
    const port = dependencies.portFor(link.provider);
    if (!port.refundsEnabled) {
      // the renewal is not cancelled for a refund the provider cannot make here
      return "refund_not_supported";
    }
    let renewal = "not_reached";
    const beforeRefund = async (charge: { amount: string }) => {
      const charged = Money.from(charge.amount).minorUnits;
      if (expected !== null && charged !== expected) {
        throw await amountRefusal(store, {
          charged,
          organizationId: input.organizationId,
          provider: port.provider,
        });
      }
      if (input.decision) {
        await store.recordOperatorDecision(
          {
            ...input.decision,
            commandId: input.requestId,
            kind: "refund",
            organizationId: input.organizationId,
          },
          now
        );
      }
      const record = await store.readRecord(input.organizationId);
      renewal = record?.cancelAtPeriodEnd
        ? "record_shows_cancelled"
        : await cancelBeforeRefund(dependencies, {
            link,
            organizationId: input.organizationId,
            port,
            // the record can hold the cancellation only while it gives Pro
            recordsCancellation: record !== null && grantsPro(record.state),
            requestId: input.requestId,
          });
    };
    const result = await refundCharge(dependencies, {
      beforeRefund,
      link,
      now,
      organizationId: input.organizationId,
      port,
    });
    logger.info("billing_refund_command", {
      organizationId: opaqueId(input.organizationId),
      provider: port.provider,
      reason: result,
      renewal,
    });
    if (
      input.decision &&
      result !== "amount_changed" &&
      result !== "amount_mismatch"
    ) {
      operatorCommandDone("refund", input.organizationId, port, result);
    }
    return result;
  });
}

/** Asks the provider for the refund of the paid charge in force (the operator's: whichever it is) and writes what it answers. */
async function refundCharge(
  dependencies: RefundCommandDependencies,
  input: {
    beforeRefund: (charge: { amount: string }) => Promise<void>;
    link: BillingProviderLink;
    now: Date;
    organizationId: string;
    port: BillingProviderPort;
  }
): Promise<
  | "amount_changed"
  | "amount_mismatch"
  | "nothing_to_refund"
  | "refund_requested"
> {
  const { link, now, port } = input;
  let outcome: Awaited<ReturnType<BillingProviderPort["refundCurrentPeriod"]>>;
  try {
    outcome = await port.refundCurrentPeriod(
      link.providerRef,
      now,
      link.providerSubscriptionId,
      "any_paid",
      { beforeRefund: input.beforeRefund }
    );
  } catch (error: unknown) {
    if (error instanceof AmountChangedError) {
      return "amount_changed";
    }
    if (error instanceof AmountMismatchError) {
      return "amount_mismatch";
    }
    throw error;
  }
  if (typeof outcome === "string") {
    return outcome;
  }
  // the provider's refund sends no webhook tied to the subscription (Woovi): the fact is
  // written now, through the inbox, under the refund's own ID (a repeat is a duplicate)
  const { event } = outcome;
  const stored = await dependencies.store.recordEvent({
    fact: event.fact,
    organizationId: input.organizationId,
    provider: port.provider,
    providerEventId: event.providerEventId,
    providerRef: event.providerRef,
    providerSubscriptionId: event.providerSubscriptionId ?? null,
  });
  await dependencies.store.processEvent(stored.id, now);
  return outcome.kind;
}

/** Step 1 of the refund: cancels the renewal at the provider and writes it through the inbox. */
async function cancelBeforeRefund(
  dependencies: RefundCommandDependencies,
  input: {
    link: BillingProviderLink;
    organizationId: string;
    port: BillingProviderPort;
    recordsCancellation: boolean;
    requestId: string;
  }
): Promise<string> {
  const { link, port } = input;
  const result = await port.cancelRenewal(
    link.providerRef,
    link.providerSubscriptionId
  );
  if (result !== "nothing_to_cancel" && input.recordsCancellation) {
    // the moment after the provider answered: a fact that arrived meanwhile must not make it stale
    const now = dependencies.now?.() ?? new Date();
    const stored = await dependencies.store.recordEvent({
      fact: { occurredAt: now, type: "subscription_cancelled" },
      organizationId: input.organizationId,
      provider: port.provider,
      providerEventId: await refundCancelEventId(
        input.requestId,
        link.providerRef
      ),
      providerRef: link.providerRef,
    });
    const processed = await dependencies.store.processEvent(stored.id, now);
    // the log tells a cancellation the record did not take (ignored, failed) from one it did
    return `${result}:${processed.status}`;
  }
  return result;
}
