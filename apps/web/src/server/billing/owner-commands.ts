import {
  type BillingProviderPort,
  NotFirstChargeError,
  ProviderUnavailableError,
  type RecordedFirstCharge,
} from "@polaris/billing/provider-port";
import {
  BillingCommandInProgressError,
  type BillingStore,
  type OwnerCommandRecord,
} from "@polaris/db/billing-store";
import { grantsPro } from "@polaris/domain/billing/entitlements";
import {
  REFUND_REQUEST_VALID_HOURS,
  recoveryOf,
  refundWindowClosesAt,
  refundWindowOf,
} from "@polaris/domain/billing/plan-view";
import { logger, opaqueId } from "@polaris/observability/logger";
import { describeError } from "@polaris/observability/wide-event";
import { cancelRenewalEventId, refundCancelEventId } from "./commands";

/**
 * The owner's billing commands (ADR 0104, decision 3): cancel the renewal, ask for the refund of the right of
 * withdrawal, and open the provider's page of the charge that failed. The caller authorized the owner
 * (`billing:manage`, the server's organization) and writes the audit of the request afterwards, with the type each
 * outcome names here. The refusals that call nothing (no link, nothing to cancel, already cancelled, the refund
 * through support, no first charge, the window closed with no anchor, no overdue charge) are answered before the lock,
 * from a read with no lock, so they never take the isolate's one command lock. Under the organization's command lock
 * (never waited for), each command reads the record again and judges all of it again (what the screen showed, and
 * what the read before the lock saw, are never trusted), reads the database's clock once and judges every rule with
 * it, counts the store's limit before it calls the provider and calls it with a deadline. Nothing of the provider, of the payer
 * or of the reason of the cancellation reaches a log: only codes and opaque IDs.
 */

/** The audit types of the owner's requests (the database's registry, migration 0100). */
export type OwnerCommandAudit =
  | "billing.command_in_progress"
  | "billing.command_rate_limited"
  | "billing.command_refused"
  | "billing.overdue_payment_opened"
  | "billing.owner_renewal_cancel_requested"
  | "billing.refund_requested";

export type OwnerCommandRefusalCode =
  | "billing_command_rate_limited"
  | "command_in_progress"
  | "no_overdue_payment"
  | "nothing_to_cancel"
  | "nothing_to_refund"
  | "refund_via_support"
  | "refund_window_expired";

/** A refusal the owner may act on (`CONFLICT` with the code as the reason), with the audit type of the request. */
export class OwnerCommandRefusal extends Error {
  readonly audit: OwnerCommandAudit;
  readonly code: OwnerCommandRefusalCode;

  constructor(
    code: OwnerCommandRefusalCode,
    audit: OwnerCommandAudit,
    options?: ErrorOptions
  ) {
    super(code, options);
    this.name = "OwnerCommandRefusal";
    this.code = code;
    this.audit = audit;
  }
}

/**
 * The provider failed (or the command's deadline ran out) after the command counted in the store's limit: the
 * request is audited as accepted, and the owner may try again (`billing_provider_unavailable`).
 */
export class OwnerCommandProviderFailure extends Error {
  readonly audit: OwnerCommandAudit;
  readonly code = "provider_unavailable";

  constructor(audit: OwnerCommandAudit, options?: ErrorOptions) {
    super("provider_unavailable", options);
    this.name = "OwnerCommandProviderFailure";
    this.audit = audit;
  }
}

export interface OwnerCommandOutcome<T> {
  audit: OwnerCommandAudit;
  response: T;
}

/** One call to the provider waits at most this long (below the 60 s the lock's idle transaction lasts). */
export const PROVIDER_CALL_TIMEOUT_MS = 15_000;
/** A command calls the provider for at most this long in all; the next call is not made past it. */
export const OWNER_COMMAND_BUDGET_MS = 45_000;

export interface OwnerCommandDependencies {
  /** A monotonic clock in ms (`performance.now`); a test gives its own. */
  elapsedMs?: () => number;
  /**
   * The port of the provider an organization is linked to, built for one call. `signal` is required and the port
   * must honor it: once it aborts (`PROVIDER_CALL_TIMEOUT_MS`, or what is left of `OWNER_COMMAND_BUDGET_MS`), every
   * request of that port to the provider is aborted too, so nothing it started outlives the command's deadline. The
   * command does not trust that alone: a call whose port ignores the signal is answered as the provider's failure
   * when the signal aborts, and the command makes no next call.
   */
  portFor: (provider: string, signal: AbortSignal) => BillingProviderPort;
  store: Pick<
    BillingStore,
    | "anchorRefundRequest"
    | "claimProviderCommand"
    | "databaseNow"
    | "hasLedgerEvent"
    | "processEvent"
    | "readOwnerCommandRecord"
    | "recordCancellationFeedback"
    | "recordEvent"
    | "withOrganizationLock"
  >;
  /** An `AbortSignal` that aborts after `ms` (`AbortSignal.timeout`); a test gives its own. */
  timeoutSignal?: (ms: number) => AbortSignal;
}

type CommandLink = NonNullable<OwnerCommandRecord["link"]>;

const HOUR_MS = 3_600_000;
const CANCELLABLE_STATES: ReadonlySet<string> = new Set([
  "active",
  "grace",
  "trialing",
]);

/** The provider calls of one command: each with its own deadline, all within the command's budget. */
function providerCalls(dependencies: OwnerCommandDependencies) {
  const elapsed = dependencies.elapsedMs ?? (() => performance.now());
  const timeoutSignal =
    dependencies.timeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms));
  const started = elapsed();
  return async <T>(
    provider: string,
    call: (port: BillingProviderPort) => Promise<T>
  ): Promise<T> => {
    const left = Math.min(
      PROVIDER_CALL_TIMEOUT_MS,
      OWNER_COMMAND_BUDGET_MS - (elapsed() - started)
    );
    if (left <= 0) {
      // the command's budget ran out: no next call to the provider
      throw new ProviderUnavailableError();
    }
    const signal = timeoutSignal(left);
    const port = dependencies.portFor(provider, signal);
    return await new Promise<T>((resolve, reject) => {
      // a port that does not stop at the signal is not waited for either
      const abort = () => reject(new ProviderUnavailableError());
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
      call(port)
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort));
    });
  };
}

/** Runs `operation` under the organization's command lock; a lock held elsewhere is `command_in_progress`. */
async function underLock<T>(
  dependencies: OwnerCommandDependencies,
  organizationId: string,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await dependencies.store.withOrganizationLock(
      organizationId,
      operation
    );
  } catch (error: unknown) {
    if (error instanceof BillingCommandInProgressError) {
      // biome-ignore lint/style/useErrorCause: the cause is passed in the options object.
      throw new OwnerCommandRefusal(
        "command_in_progress",
        "billing.command_in_progress",
        { cause: error }
      );
    }
    throw error;
  }
}

async function claimOrRefuse(
  dependencies: OwnerCommandDependencies,
  organizationId: string,
  now: Date
): Promise<void> {
  if (!(await dependencies.store.claimProviderCommand(organizationId, now))) {
    throw new OwnerCommandRefusal(
      "billing_command_rate_limited",
      "billing.command_rate_limited"
    );
  }
}

/** Writes a command's own cancellation through the inbox, at the moment after the provider answered. */
async function recordCancellation(
  dependencies: OwnerCommandDependencies,
  input: {
    link: NonNullable<OwnerCommandRecord["link"]>;
    organizationId: string;
    providerEventId: string;
  }
): Promise<string> {
  const { store } = dependencies;
  // the database's clock after the provider answered: a fact that arrived meanwhile must not make it stale
  const at = await store.databaseNow();
  const stored = await store.recordEvent({
    fact: { occurredAt: at, type: "subscription_cancelled" },
    organizationId: input.organizationId,
    provider: input.link.provider,
    providerEventId: input.providerEventId,
    providerRef: input.link.providerRef,
  });
  return (await store.processEvent(stored.id, at)).status;
}

/**
 * `recordCancellation` after the provider acted: a failure of the inbox there is the provider's call's (audited as
 * accepted, `billing_provider_unavailable`), and the request's repeat writes the same fact again (a duplicate) and
 * processes it.
 */
async function recordOrFail(
  dependencies: OwnerCommandDependencies,
  audit: OwnerCommandAudit,
  input: Parameters<typeof recordCancellation>[1]
): Promise<string> {
  try {
    return await recordCancellation(dependencies, input);
  } catch (error: unknown) {
    logger.warn("billing_owner_cancellation_record_failed", {
      ...describeError(error),
      organizationId: opaqueId(input.organizationId),
      provider: input.link.provider,
    });
    throw new OwnerCommandProviderFailure(audit, { cause: error });
  }
}

/** The optional reason, after `cancelled` only: its failure loses the reason, never the cancellation. */
async function keepReason(
  dependencies: OwnerCommandDependencies,
  record: OwnerCommandRecord,
  reason: string | null | undefined,
  ids: { organizationId: ReturnType<typeof opaqueId>; provider: string }
): Promise<void> {
  const text = reason?.trim() ?? "";
  if (text.length === 0) {
    return;
  }
  await dependencies.store
    .recordCancellationFeedback({
      cycleMonths: record.cycleMonths,
      reason: text,
      state: record.state as "active" | "grace" | "trialing",
    })
    .catch((error: unknown) => {
      // nothing of the text goes to the log
      logger.warn("billing_cancellation_feedback_failed", {
        ...describeError(error),
        ...ids,
      });
    });
}

type CancelDecision =
  | { kind: "already_cancelled" }
  | { eventId: string; kind: "own_repeat" | "proceed"; link: CommandLink };

/**
 * What the owner's cancellation does with this record, in order: the request's own cancellation already in the
 * ledger (`command:cancel_renewal`, by exact equality) is its repeat; a renewal already cancelled is
 * `already_cancelled`; no link, or a record outside trial, paid or grace, is `nothing_to_cancel`; else it goes on.
 * Judged before the lock (only the two refusals are answered there) and again under it.
 */
async function cancelDecisionOf(
  dependencies: OwnerCommandDependencies,
  record: OwnerCommandRecord,
  requestId: string
): Promise<CancelDecision> {
  const { link } = record;
  const eventId = link
    ? await cancelRenewalEventId(requestId, link.providerRef)
    : null;
  if (
    link &&
    eventId &&
    (await dependencies.store.hasLedgerEvent(link.provider, eventId))
  ) {
    return { eventId, kind: "own_repeat", link };
  }
  if (record.cancelAtPeriodEnd && grantsPro(record.state)) {
    return { kind: "already_cancelled" };
  }
  if (!(link && eventId && CANCELLABLE_STATES.has(record.state))) {
    throw new OwnerCommandRefusal(
      "nothing_to_cancel",
      "billing.command_refused"
    );
  }
  return { eventId, kind: "proceed", link };
}

/** A renewal already cancelled: answered with no provider, no limit and no reason (EM-30). */
function alreadyCancelled(
  record: OwnerCommandRecord
): OwnerCommandOutcome<OwnerCancelRenewalResponse> {
  return {
    audit: "billing.command_refused",
    response: {
      accessEndsAt: record.accessEndsAt,
      result: "already_cancelled",
    },
  };
}

export interface OwnerCancelRenewalInput {
  organizationId: string;
  /** Optional, 1 to 500 characters; kept with no store and no person, never logged. */
  reason?: string | null;
  requestId: string;
}

export interface OwnerCancelRenewalResponse {
  accessEndsAt: Date | null;
  result: "already_cancelled" | "cancelled";
}

/**
 * The owner cancels the renewal (ADR 0104, decision 3): access already paid for runs to its end, the store is not
 * closed and nothing is refunded; in grace it ends the provider's new tries. Cancelling cannot be undone. Before the
 * lock, `already_cancelled` and `nothing_to_cancel` are answered from a read with no lock. The order under the lock
 * (`cancelDecisionOf`, judged again): the request's own cancellation already in the ledger (`command:cancel_renewal`,
 * by exact equality) is recognized and answered again with no provider call and no second reason; a renewal already
 * cancelled is `already_cancelled` with no provider call; no link, or a record outside trial, paid or grace, is
 * `nothing_to_cancel`; then the store's limit, the provider and the fact through the inbox, and only after
 * `cancelled` the optional reason (its failure loses the reason, never the cancellation).
 */
export async function ownerCancelRenewal(
  dependencies: OwnerCommandDependencies,
  input: OwnerCancelRenewalInput
): Promise<OwnerCommandOutcome<OwnerCancelRenewalResponse>> {
  const accepted = "billing.owner_renewal_cancel_requested";
  const { store } = dependencies;
  // the cheap refusals first, with no lock: they call nothing and must not take the isolate's one command lock
  const seen = await store.readOwnerCommandRecord(input.organizationId);
  if (
    (await cancelDecisionOf(dependencies, seen, input.requestId)).kind ===
    "already_cancelled"
  ) {
    return alreadyCancelled(seen);
  }
  return await underLock(dependencies, input.organizationId, async () => {
    const now = await store.databaseNow();
    const record = await store.readOwnerCommandRecord(input.organizationId);
    const decision = await cancelDecisionOf(
      dependencies,
      record,
      input.requestId
    );
    if (decision.kind === "already_cancelled") {
      return alreadyCancelled(record);
    }
    const { eventId, link } = decision;
    const ids = {
      organizationId: opaqueId(input.organizationId),
      provider: link.provider,
    };
    if (decision.kind === "own_repeat") {
      // the request's own cancellation, repeated (its audit failed): the same answer, no second reason. A fact
      // stored and not applied (the processing failed) is processed again first: the ledger keeps its own moment
      if (!record.cancelAtPeriodEnd && grantsPro(record.state)) {
        await recordOrFail(dependencies, accepted, {
          link,
          organizationId: input.organizationId,
          providerEventId: eventId,
        });
      }
      return {
        audit: accepted,
        response: { accessEndsAt: record.accessEndsAt, result: "cancelled" },
      };
    }
    await claimOrRefuse(dependencies, input.organizationId, now);
    const call = providerCalls(dependencies);
    let result: Awaited<ReturnType<BillingProviderPort["cancelRenewal"]>>;
    try {
      result = await call(link.provider, (port) =>
        port.cancelRenewal(link.providerRef, link.providerSubscriptionId)
      );
    } catch (error: unknown) {
      logger.warn("billing_owner_cancel_renewal_failed", {
        ...describeError(error),
        ...ids,
      });
      throw new OwnerCommandProviderFailure(accepted, { cause: error });
    }
    if (result === "nothing_to_cancel") {
      // the provider has no subscription behind the link: nothing was cancelled, and the record is not touched
      logger.warn("billing_owner_cancel_renewal_not_found", ids);
      throw new OwnerCommandRefusal("nothing_to_cancel", accepted);
    }
    const processed = await recordOrFail(dependencies, accepted, {
      link,
      organizationId: input.organizationId,
      providerEventId: eventId,
    });
    await keepReason(dependencies, record, input.reason, ids);
    logger.info("billing_owner_cancel_renewal", {
      ...ids,
      reason: `${result}:${processed}`,
    });
    return {
      audit: accepted,
      response: { accessEndsAt: record.accessEndsAt, result: "cancelled" },
    };
  });
}

export interface OwnerRefundResponse {
  amount: string;
  result: "refund_pending" | "refund_requested";
  until: Date;
}

/**
 * The owner asks for the refund of the right of withdrawal (ADR 0104, decision 3). The refusals that call nothing
 * (`refundRefusalOf`) are answered first from a read with no lock, and judged again under it. Under the lock and with
 * one clock (the database's `now()`, read once): a provider that does not refund here (Pix until S3.2) is
 * `refund_via_support`, with no anchor and no limit; no first charge recorded, or with no anchor a window already
 * closed, is `nothing_to_refund` before the limit; the request's own repeat (the anchor's `refund_request_id`, or
 * its own `command:refund_cancel`, by exact equality) of a refund already done is answered again as accepted, and a
 * refund already done seen with another request ID gets the same answer audited as refused; then the store's limit;
 * then the window: with an anchor, judged at the anchor and only until 72 hours after it (`refund_window_expired`
 * after that, the operator's work), without one at `now`, and open it writes the anchor (its own autocommitted
 * statement, before the provider, the first request wins). Then the renewal is cancelled first unless the record
 * already shows it cancelled (a repeat with another request ID never writes a second cancellation), and the refund
 * of the first charge recorded only. A refund that fails, or finds another charge in force, after that is `refund_pending` (the renewal is cancelled, a repeat finishes it); a cancellation
 * that fails refunds nothing and keeps the anchor.
 */
export async function ownerRequestRefund(
  dependencies: OwnerCommandDependencies,
  input: { organizationId: string; requestId: string }
): Promise<OwnerCommandOutcome<OwnerRefundResponse>> {
  const { store } = dependencies;
  // the cheap refusals first, with no lock and at the database's clock: they call nothing and must not take the
  // isolate's one command lock
  refundRefusalOf(
    dependencies,
    await store.readOwnerCommandRecord(input.organizationId),
    await store.databaseNow()
  );
  return await underLock(dependencies, input.organizationId, async () => {
    const now = await store.databaseNow();
    const record = await store.readOwnerCommandRecord(input.organizationId);
    const { link, refundable } = refundRefusalOf(dependencies, record, now);
    if (refundable.kind === "refunded") {
      return await refundAlreadyDone(dependencies, {
        firstChargeAmount: refundable.firstChargeAmount,
        firstChargeAt: refundable.firstChargeAt,
        link,
        record,
        requestId: input.requestId,
      });
    }
    await claimOrRefuse(dependencies, input.organizationId, now);
    const window = await anchoredWindow(dependencies, {
      link,
      now,
      organizationId: input.organizationId,
      record,
      requestId: input.requestId,
    });
    const call = providerCalls(dependencies);
    const renewal = record.cancelAtPeriodEnd
      ? "record_shows_cancelled"
      : await cancelBeforeOwnerRefund(dependencies, call, {
          link,
          organizationId: input.organizationId,
          record,
          requestId: input.requestId,
        });
    const result = await refundStep(dependencies, call, {
      firstCharge: refundable.firstCharge,
      link,
      now,
      organizationId: input.organizationId,
    });
    logger.info("billing_owner_refund", {
      organizationId: opaqueId(input.organizationId),
      provider: link.provider,
      reason: result,
      renewal,
    });
    return {
      audit: REFUND_ACCEPTED,
      response: { amount: window.amount, result, until: window.until },
    };
  });
}

const REFUND_ACCEPTED = "billing.refund_requested";

type ProviderCall = ReturnType<typeof providerCalls>;

/** The first charge a refund refunds, recorded in full; `refunded` once the period's payment was revoked as a refund. */
interface Refundable {
  firstCharge: RecordedFirstCharge;
  firstChargeAmount: string;
  firstChargeAt: Date;
  kind: "open" | "refunded";
}

/**
 * The refusals of the owner's refund that call nothing, in order, judged before the lock and again under it at the
 * lock's clock: no link is `nothing_to_refund`; a provider that does not refund here (Pix until S3.2) is
 * `refund_via_support`, with no anchor and no limit; no first charge recorded (its time, its amount, its event or the
 * period that event paid) is `nothing_to_refund` (it fails closed, and no amount is ever made up); a refund already
 * done goes on to its answer; and with no anchor, the window closed at `now` is `nothing_to_refund`, before the
 * limit counts it.
 */
function refundRefusalOf(
  dependencies: OwnerCommandDependencies,
  record: OwnerCommandRecord,
  now: Date
): { link: CommandLink; refundable: Refundable } {
  const { firstCharge, link } = record;
  if (!link) {
    throw new OwnerCommandRefusal(
      "nothing_to_refund",
      "billing.command_refused"
    );
  }
  if (!refundsHere(dependencies, link.provider)) {
    // first of all (Pix until S3.2): no anchor, no limit
    throw new OwnerCommandRefusal(
      "refund_via_support",
      "billing.command_refused"
    );
  }
  if (
    record.firstChargeAt === null ||
    record.firstChargeAmount === null ||
    firstCharge.eventId === null ||
    firstCharge.periodEndsAt === null
  ) {
    throw new OwnerCommandRefusal(
      "nothing_to_refund",
      "billing.command_refused"
    );
  }
  const refundable = {
    firstCharge,
    firstChargeAmount: record.firstChargeAmount,
    firstChargeAt: record.firstChargeAt,
  };
  if (record.revoked?.reason === "refund") {
    return { link, refundable: { ...refundable, kind: "refunded" } };
  }
  if (
    record.refundRequestedAt === null &&
    refundWindowOf(record, now) === null
  ) {
    throw new OwnerCommandRefusal(
      "nothing_to_refund",
      "billing.command_refused"
    );
  }
  return { link, refundable: { ...refundable, kind: "open" } };
}

/** Whether the provider refunds in the app here; a port that cannot be built refunds nothing (the read says support). */
function refundsHere(
  dependencies: OwnerCommandDependencies,
  provider: string
): boolean {
  try {
    // only a property is read: no request goes through this port, so its signal never aborts
    return dependencies.portFor(provider, new AbortController().signal)
      .refundsEnabled;
  } catch {
    return false;
  }
}

/**
 * A refund already done (the period's payment revoked as `refund`): the same answer to every request, with the
 * accepted type only for the request's own repeat, by exact equality with the anchor's `refund_request_id` or its own
 * `command:refund_cancel` (the repair of its audit). Another request ID is audited as refused, with the cap.
 */
async function refundAlreadyDone(
  dependencies: OwnerCommandDependencies,
  input: {
    firstChargeAmount: string;
    firstChargeAt: Date;
    link: CommandLink;
    record: OwnerCommandRecord;
    requestId: string;
  }
): Promise<OwnerCommandOutcome<OwnerRefundResponse>> {
  const recognized =
    input.record.refundRequestId === input.requestId ||
    (await dependencies.store.hasLedgerEvent(
      input.link.provider,
      await refundCancelEventId(input.requestId, input.link.providerRef)
    ));
  return {
    audit: recognized ? REFUND_ACCEPTED : "billing.command_refused",
    response: {
      amount: input.firstChargeAmount,
      result: "refund_requested",
      until: new Date(
        refundWindowClosesAt(input.firstChargeAt).getTime() - 1000
      ),
    },
  };
}

/**
 * The window the request is judged by, with the anchor written when there was none (ADR 0104, decisions 3 and 5):
 * with an anchor, at the anchor, and only until 72 hours after it; without one, at `now`, and open it writes the
 * anchor at that same `now` (the first request wins; a request barred by the limit never gets here).
 */
async function anchoredWindow(
  dependencies: OwnerCommandDependencies,
  input: {
    link: CommandLink;
    now: Date;
    organizationId: string;
    record: OwnerCommandRecord;
    requestId: string;
  }
): Promise<NonNullable<ReturnType<typeof refundWindowOf>>> {
  const { link, now, record } = input;
  let judged: OwnerCommandRecord = record;
  if (record.refundRequestedAt === null) {
    if (refundWindowOf(record, now) === null) {
      throw new OwnerCommandRefusal(
        "nothing_to_refund",
        "billing.command_refused"
      );
    }
    const anchor = await dependencies.store.anchorRefundRequest(
      input.organizationId,
      { at: now, providerRef: link.providerRef, requestId: input.requestId }
    );
    if (anchor === null) {
      // the link changed between the read and the anchor: nothing to refund on the one the owner saw
      throw new OwnerCommandRefusal(
        "nothing_to_refund",
        "billing.command_refused"
      );
    }
    judged = { ...record, ...anchor };
  }
  const window = refundWindowOf(judged, now);
  if (window !== null) {
    return window;
  }
  const anchoredAt = judged.refundRequestedAt;
  if (
    anchoredAt !== null &&
    now.getTime() - anchoredAt.getTime() > REFUND_REQUEST_VALID_HOURS * HOUR_MS
  ) {
    // past the 72 hours the refund is the operator's: only the opaque store, the provider and the renewal
    logger.warn("billing_refund_window_expired", {
      organizationId: opaqueId(input.organizationId),
      provider: link.provider,
      renewalCancelled: record.cancelAtPeriodEnd,
    });
    throw new OwnerCommandRefusal(
      "refund_window_expired",
      "billing.command_refused"
    );
  }
  throw new OwnerCommandRefusal("nothing_to_refund", "billing.command_refused");
}

/**
 * Step 1 of the owner's refund (ADR 0066, emenda de 23/10): the renewal is cancelled at the provider and, while the
 * record gives Pro, written through the inbox (`command:refund_cancel:<requestId>:<digest>`). A failure refunds
 * nothing and keeps the anchor (`billing_provider_unavailable`; a repeat goes on from here).
 */
async function cancelBeforeOwnerRefund(
  dependencies: OwnerCommandDependencies,
  call: ProviderCall,
  input: {
    link: CommandLink;
    organizationId: string;
    record: OwnerCommandRecord;
    requestId: string;
  }
): Promise<string> {
  const { link } = input;
  let cancelled: Awaited<ReturnType<BillingProviderPort["cancelRenewal"]>>;
  try {
    cancelled = await call(link.provider, (port) =>
      port.cancelRenewal(link.providerRef, link.providerSubscriptionId)
    );
  } catch (error: unknown) {
    logger.warn("billing_owner_refund_cancel_failed", {
      ...describeError(error),
      organizationId: opaqueId(input.organizationId),
      provider: link.provider,
    });
    throw new OwnerCommandProviderFailure(REFUND_ACCEPTED, { cause: error });
  }
  if (cancelled === "nothing_to_cancel" || !grantsPro(input.record.state)) {
    // the record can hold the cancellation only while it gives Pro, as in the operator's command
    return cancelled;
  }
  const processed = await recordOrFail(dependencies, REFUND_ACCEPTED, {
    link,
    organizationId: input.organizationId,
    providerEventId: await refundCancelEventId(
      input.requestId,
      link.providerRef
    ),
  });
  return `${cancelled}:${processed}`;
}

/**
 * Step 2: the refund of the period in force, only if it is the first charge recorded (`firstCharge`: the port refuses
 * another one, or none, before it asks for the refund). Done, it is `refund_requested` (Asaas's fact comes back by
 * webhook; Woovi's is written now through the inbox). Nothing to refund with the anchor in time, a failure or the budget run
 * out is `refund_pending` (AS-42): the renewal is cancelled, and a repeat finishes it.
 */
async function refundStep(
  dependencies: OwnerCommandDependencies,
  call: ProviderCall,
  input: {
    firstCharge: RecordedFirstCharge;
    link: CommandLink;
    now: Date;
    organizationId: string;
  }
): Promise<OwnerRefundResponse["result"]> {
  const { link, now } = input;
  const { store } = dependencies;
  try {
    const outcome = await call(link.provider, (port) =>
      port.refundCurrentPeriod(
        link.providerRef,
        now,
        link.providerSubscriptionId,
        input.firstCharge
      )
    );
    if (typeof outcome === "string") {
      // nothing to refund now, with the anchor in time: the refund may be on its way (its webhook)
      return outcome === "refund_requested"
        ? "refund_requested"
        : "refund_pending";
    }
    const { event } = outcome;
    const stored = await store.recordEvent({
      fact: event.fact,
      organizationId: input.organizationId,
      provider: link.provider,
      providerEventId: event.providerEventId,
      providerRef: event.providerRef,
      providerSubscriptionId: event.providerSubscriptionId ?? null,
    });
    await store.processEvent(stored.id, now);
    return "refund_requested";
  } catch (error: unknown) {
    // the charge in force is not the first one recorded (the provider reordered): nothing was refunded, and the
    // operator's log says why; the renewal stays cancelled and the request waits as pending (AS-42)
    logger.warn(
      error instanceof NotFirstChargeError
        ? "billing_owner_refund_not_first_charge"
        : "billing_owner_refund_failed",
      {
        ...describeError(error),
        organizationId: opaqueId(input.organizationId),
        provider: link.provider,
      }
    );
    return "refund_pending";
  }
}

/** The link whose charge failed, in grace with the card (`recoveryOf`); anything else is `no_overdue_payment`. */
function overdueLinkOf(record: OwnerCommandRecord): CommandLink {
  const { link } = record;
  if (!link || recoveryOf(record) !== "provider_page") {
    throw new OwnerCommandRefusal(
      "no_overdue_payment",
      "billing.command_refused"
    );
  }
  return link;
}

/**
 * The owner opens the provider's page of the charge that failed (ADR 0104, decision 3; AS-43): only in grace with
 * the card (`recoveryOf`). It pays that charge and does not change the card. The address is read again from the
 * provider (its exact hosts checked by the port) and is never logged.
 */
export async function ownerOpenOverduePayment(
  dependencies: OwnerCommandDependencies,
  input: { organizationId: string; requestId: string }
): Promise<OwnerCommandOutcome<{ url: string }>> {
  const accepted = "billing.overdue_payment_opened";
  const { store } = dependencies;
  // the cheap refusal first, with no lock: it calls nothing and must not take the isolate's one command lock
  overdueLinkOf(await store.readOwnerCommandRecord(input.organizationId));
  return await underLock(dependencies, input.organizationId, async () => {
    const now = await store.databaseNow();
    const record = await store.readOwnerCommandRecord(input.organizationId);
    const link = overdueLinkOf(record);
    await claimOrRefuse(dependencies, input.organizationId, now);
    const ids = {
      organizationId: opaqueId(input.organizationId),
      provider: link.provider,
    };
    let url: string | null;
    try {
      url = await providerCalls(dependencies)(link.provider, (port) =>
        port.overduePaymentPage(link.providerRef, link.providerSubscriptionId)
      );
    } catch (error: unknown) {
      logger.warn("billing_overdue_payment_page_failed", {
        ...describeError(error),
        ...ids,
      });
      throw new OwnerCommandProviderFailure(accepted, { cause: error });
    }
    if (url === null) {
      throw new OwnerCommandRefusal("no_overdue_payment", accepted);
    }
    logger.info("billing_overdue_payment_opened", ids);
    return { audit: accepted, response: { url } };
  });
}
