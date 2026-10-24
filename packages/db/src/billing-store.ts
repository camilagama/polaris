import { createHash, randomUUID } from "node:crypto";
import {
  type BillingState,
  grantsPro,
} from "@polaris/domain/billing/entitlements";
import {
  type BillingCycleMonths,
  type BillingFact,
  type BillingRecord,
  dueTransition,
  type IgnoredFactReason,
  isBillingCycleMonths,
  parseBillingFact,
  reconcileFact,
  serializeBillingFact,
} from "@polaris/domain/billing/facts";
import {
  type GrantRequest,
  InvalidEntitlementGrantError,
  isValidGrantActor,
  normalizeGrant,
} from "@polaris/domain/billing/grants";
import {
  type BillingNoticeMark,
  welcomeNotice,
} from "@polaris/domain/billing/notices";
import { episodeStartAfter } from "@polaris/domain/billing/operational-selection";
import { applyBillingEvent } from "@polaris/domain/billing/subscription-state";
import {
  outboxEvent,
  outboxIdempotencyKey,
} from "@polaris/domain/events/outbox";
import { logger, opaqueId } from "@polaris/observability/logger";
import { describeError } from "@polaris/observability/wide-event";
import { type PoolClient, Pool } from "pg";
import { guardPoolErrors } from "./pool-errors";

/**
 * The billing path (plan PR79 and PR81, ADR 0062): the one place that writes an
 * organization's billing record. It runs on its own database role
 * (`polaris_billing_runtime`, a separate Hyperdrive binding), never on a tenant
 * request: webhooks, the sweep of expired access and the command that starts a
 * trial all come here. The caller decides which organization a request is for
 * (a webhook by the subscription reference the provider reported, a tenant
 * command by the authenticated context); this module trusts that and checks the
 * rest: facts are deduplicated, ordered by the moment they happened, checked
 * against the record and applied through the state machine, and every outcome is
 * kept in the `billing_events` ledger.
 */

/** A failed event is retried this many times before it is left for a person. */
const MAX_BILLING_EVENT_ATTEMPTS = 5;
/** A received event not processed after this long is picked up again by the retry pass. */
const RECEIVED_RETRY_AFTER_MS = 60_000;

interface RecordBillingEventInput {
  fact: BillingFact;
  /** The organization, when the caller knows it; otherwise it is resolved from the reference. */
  organizationId?: string | null;
  provider: string;
  /** The provider's own ID of the event: the key that makes a redelivery a no-op. */
  providerEventId: string;
  /** The subscription reference the provider reported. */
  providerRef?: string | null;
  /** The provider's own ID of the subscription (Asaas `sub_`), when the fact carries one. */
  providerSubscriptionId?: string | null;
}

/** How the organization's subscription is reached at its provider. */
export interface BillingProviderLink {
  provider: string;
  /** The reference `attachProvider` stored (for Asaas, the checkout's ID). */
  providerRef: string;
  /** The provider's own ID of the subscription, once a fact matched the reference; null before. */
  providerSubscriptionId: string | null;
}

type BillingEventStatus =
  | "applied"
  | "failed"
  | "ignored"
  | "received"
  | "unresolved";

interface ProcessedBillingEvent {
  eventId: string;
  organizationId: string | null;
  outcomeCode: string | null;
  status: BillingEventStatus;
}

export interface BillingSweepReport {
  failed: number;
  scanned: number;
  transitioned: number;
}

/** What one hourly pass of the retry by state did to the renewal cancellations owed by closures (ADR 0074, L4). */
export interface RenewalCancellationRearmReport {
  /** Events written for a closure that had none (closed before the event existed, or a checkout paid after it). */
  inserted: number;
  /** Events dispatched a while ago sent back to pending: the renewal is still alive. */
  rearmed: number;
}

export interface BillingRetryReport {
  failed: number;
  processed: number;
  scanned: number;
  /** Events read again that still cannot apply (`trial_claim_missing`): kept for the next pass and the reconciliation. */
  unresolved: number;
}

/**
 * The provider checkout an organization was setting up its trial with, when the
 * person's trial reservation leaves it for another organization (ADR 0101).
 */
export interface AbandonedTrialCheckout {
  /** The organization the reservation left. */
  organizationId: string;
  provider: string;
  /** The reference `attachProvider` stored (for Asaas, the checkout's ID). */
  providerRef: string;
}

/**
 * A fact that would have started a trial no reservation pays for
 * (`trial_claim_missing`), left `unresolved` after its retries (ADR 0101). The
 * subscription it names exists at the provider and will charge, without a
 * trial, on the day the trial would have ended: it is cancelled there, never
 * charged without the person's consent.
 */
export interface UnclaimedTrialEvent {
  eventId: string;
  organizationId: string;
  provider: string;
  /** The reference the event named (for Asaas, the checkout's ID). */
  providerRef: string;
  /** The provider's own ID of the subscription, when the event carried it. */
  providerSubscriptionId: string | null;
}

/**
 * `cancelled`: cancelled at the provider and recorded. `left_paid`: the same
 * subscription already gives the organization Pro (it was paid for since), so it
 * is left alone and only recorded. `not_pending`: someone else settled it first,
 * or the event is no longer an unclaimed trial past its retries.
 */
export type UnclaimedTrialOutcome = "cancelled" | "left_paid" | "not_pending";

/**
 * What the checkout asked the provider for, recorded with the link (ADR 0104, §7 of design t268): the price of one
 * cycle (`billing_prices`, as money.md writes it) with its catalog ID, and the day of the first charge (São Paulo).
 */
export interface CheckoutTerms {
  /** `AAAA-MM-DD`, the `firstChargeOn` sent to the provider. */
  firstChargeOn: string;
  /** `"24.90"`: never passes through `number`. */
  priceAmount: string;
  priceId: string;
}

/**
 * A subscription whose payment was taken back (a refund or a chargeback) while its renewal is still alive at the
 * provider, handed to the hourly safety net (ADR 0104, decision 6). `attempt` counts this try (1 to 10).
 */
export interface RefundedRenewal extends BillingProviderLink {
  attempt: number;
  organizationId: string;
  reason: "chargeback" | "refund";
}

/** What one pass of the safety net did (ADR 0104, decision 6). */
export interface RefundRearmReport {
  /** Stores whose 10th try failed: the net stops for them (`billing_refund_rearm_exhausted`). */
  exhausted: number;
  failed: number;
  rearmed: number;
  scanned: number;
}

/** What one hourly pass of the welcome's sweep did (ADR 0104, decision 6). */
export interface WelcomeNoticeReport {
  /** Stores of the last 24 hours whose oldest owner had no welcome yet. */
  candidates: number;
  /** Welcomes recorded now, each with its outbox event (a concurrent pass may have recorded the others). */
  recorded: number;
}

/** The most stores one pass of the welcome's sweep reads. */
export const WELCOME_NOTICE_BATCH = 100;

/** The reference a new `attachProvider` replaced (a checkout given up or a subscription no longer live). */
export interface ReplacedProviderReference {
  provider: string;
  providerRef: string;
}

export interface BillingStoreOptions {
  /**
   * Gives up, at the provider, the checkout of the organization a trial
   * reservation was moved away from, so that it can no longer be paid (the
   * port's `discardCheckout`). Called after the move is committed, best effort:
   * a failure is logged and never undoes the move. Without it nothing is called;
   * a checkout paid anyway does not start a trial (`trial_claim_missing`).
   */
  discardCheckout?: (checkout: AbandonedTrialCheckout) => Promise<unknown>;
}

export interface GrantEntitlementInput extends GrantRequest {
  /** The caller's own ID for the grant (a UUID): giving it twice is one grant. */
  id?: string;
  organizationId: string;
}

/** What is stored of a grant, enough to tell whether a repeat of a command is the same grant. */
export interface StoredEntitlementGrant {
  expiresAt: Date;
  flagValue: boolean | null;
  grantedBy: string;
  key: string;
  limitValue: number | null;
  organizationId: string;
  reason: string;
  startsAt: Date;
}

export interface BillingStore {
  /**
   * Links the organization's subscription at a provider (the reference webhooks
   * name). Answers the reference it replaced, if any, so the caller can give
   * that checkout up at the provider; null when nothing was replaced.
   */
  attachProvider: (
    organizationId: string,
    provider: string,
    providerRef: string,
    /**
     * The price and the day of the first charge sent to the provider, recorded with a new link (ADR 0104). A new
     * link also clears what belonged to the previous one: its first charge, the owner's refund request and the
     * back-off of the safety net, so each new subscription opens a new window of the right of withdrawal.
     */
    terms?: CheckoutTerms
  ) => Promise<ReplacedProviderReference | null>;
  /**
   * Counts one owner's command that calls the provider (ADR 0104, decision 4): at most one every 30 seconds and 10
   * an hour per organization, the hour counted from its first command. Answers false, counting nothing, when the
   * command is over the limit. The caller holds the organization's command lock.
   */
  claimProviderCommand: (
    organizationId: string,
    now?: Date
  ) => Promise<boolean>;
  /**
   * Whether the closure already gave up, at the provider, the checkout this
   * link names (the ledger row `recordCheckoutDiscarded` wrote for it).
   */
  checkoutDiscarded: (
    organizationId: string,
    link: Pick<BillingProviderLink, "provider" | "providerRef">
  ) => Promise<boolean>;
  close: () => Promise<void>;
  /**
   * Gives an organization a temporary entitlement (plan PR85): more than its plan,
   * for a while, with who, why, from when and until when. It is never a
   * subscription and changes no billing state; a repeat of the same ID is the
   * same grant. Only the billing role writes grants: an organization cannot
   * grant itself anything.
   */
  grantEntitlement: (
    input: GrantEntitlementInput,
    now?: Date
  ) => Promise<{ created: boolean; id: string }>;
  /** The grant with this ID, or null. A command that names its own ID reads this first, so a repeat later is the same grant whatever its relative duration. */
  findEntitlementGrant: (id: string) => Promise<StoredEntitlementGrant | null>;
  /** Applies one stored event to its organization; safe to call again for an event already processed. */
  processEvent: (eventId: string, now?: Date) => Promise<ProcessedBillingEvent>;
  /** The provider link of the organization, or null when none is attached. */
  readProviderLink: (
    organizationId: string
  ) => Promise<BillingProviderLink | null>;
  readRecord: (organizationId: string) => Promise<BillingRecord | null>;
  /**
   * The retry by state of the renewal cancellations the closures asked for
   * (ADR 0074, L4): every organization in closure whose renewal is still alive
   * at a provider of `providers` (the ones Polaris cancels through) gets its
   * cycle's `billing.renewal_cancel_requested` written, or sent again when it
   * was dispatched at least `minAgeSeconds` ago (and fewer than 200 times).
   * Never a new key for the same cycle; a pending event is left to the dispatcher.
   */
  rearmRenewalCancellations: (
    minAgeSeconds: number,
    limit: number,
    providers: readonly string[]
  ) => Promise<RenewalCancellationRearmReport>;
  /**
   * Writes in the billing ledger that the checkout the link names was given up
   * at the provider at the closure (ADR 0074, L4): a `command` row of the
   * organization, `checkout_discarded`, with the checkout's reference in its
   * column and `command:discard_checkout:<requestId>:<digest of the reference>`
   * as its ID, so the same request for the same checkout written twice is one row. It changes no state (an abandoned trial
   * setup still ends by the sweep).
   */
  recordCheckoutDiscarded: (
    input: {
      link: Pick<BillingProviderLink, "provider" | "providerRef">;
      organizationId: string;
      requestId: string;
    },
    now?: Date
  ) => Promise<void>;
  /**
   * The hourly safety net of a refund or a chargeback (ADR 0104, decision 6): a store whose current link had a
   * payment taken back (`refund` or `chargeback`, never `won`) while its renewal was not cancelled gets the renewal
   * cancelled through `cancel`, at most `limit` stores a pass. Each try is counted before the call, and a store that
   * failed waits 1 h, 2 h, 4 h and so on up to 24 h before the next one; the 10th failure stops the net for that
   * link (`billing_refund_rearm_exhausted`) and opens one operational incident `billing_refund_pending` with the cause
   * `refund_rearm_exhausted` for the store and link. A cancellation is recorded on the memory of the payment taken back
   * (`revoked_cancel_at_period_end`) with the ledger row `command:revoked_cancel:<store>:<digest>:<n>`. A new link
   * clears the memory, so a new subscription is never touched. Only stores linked to one of `providers`.
   */
  rearmRefundedRenewals: (input: {
    cancel: (
      renewal: RefundedRenewal
    ) => Promise<"already_cancelled" | "cancelled" | "nothing_to_cancel">;
    limit?: number;
    now?: Date;
    providers: readonly string[];
  }) => Promise<RefundRearmReport>;
  /**
   * The owner's refunds still not completed 24 hours after the request (ADR 0104, decision 6): each store and
   * request becomes one occurrence of the operational incident `billing_refund_pending`, with a ledger row of its own
   * (`command:refund_pending:<store>:<moment of the request>`), so a second pass adds nothing. It also writes the
   * incident of a safety net stopped after its 10th failure (cause `refund_rearm_exhausted`, ledger row
   * `command:refund_rearm_exhausted:<store>:<digest>`, one per store and link) when that pass could not, an hour
   * after the 10th try at the earliest. Reads at most `limit` stores of each cause. Answers how many were recorded now.
   */
  recordPendingRefundIncidents: (now?: Date, limit?: number) => Promise<number>;
  /**
   * The hourly sweep of the welcome (E1, ADR 0104, decision 6): for each store created in the last 24 hours, still
   * active, whose oldest owner has no welcome and no older store, records the welcome of that person and its outbox
   * event `billing.notice`, in one transaction (`welcome_notice_candidates` reads them; the database keeps one welcome
   * per person). The caller runs it only with `WELCOME_EMAIL_ENABLED`: off, no row is written, so turning it on later
   * sends no late welcome.
   */
  recordWelcomeNotices: (
    now?: Date,
    limit?: number
  ) => Promise<WelcomeNoticeReport>;
  /** Stores an event once; a redelivery returns the same ID with `duplicate: true`. */
  recordEvent: (
    input: RecordBillingEventInput
  ) => Promise<{ duplicate: boolean; id: string }>;
  /** The unclaimed trials past their retries, oldest first (see `UnclaimedTrialEvent`). */
  listUnclaimedTrials: (limit?: number) => Promise<UnclaimedTrialEvent[]>;
  /**
   * The organizations linked to `provider` that the hourly reconciliation reads
   * (ADR 0101, emenda do PR 6): a subscription that may still change access
   * (`trial_setup`, `trialing`, `active`, `grace`), or any link written in the
   * last 8 days (a Pix Automático without trial waits on Free for its first
   * charge). At most `limit`: first the ones a lost webhook hurts most (a trial
   * setup or a link of the last 8 days), then the others in an order that
   * changes every hour, so a batch smaller than the list still reaches every
   * organization in a few hours.
   */
  listReconcilableOrganizations: (
    provider: string,
    limit: number,
    now?: Date
  ) => Promise<string[]>;
  /** Processes events that were received but not applied, and retries failed and unresolved ones. */
  retryPending: (now?: Date, limit?: number) => Promise<BillingRetryReport>;
  /** Ends a grant now (or, if it has not started, as soon as it could); ending one twice is one ending. */
  revokeEntitlementGrant: (
    /** `organizationId`, when given, must be the grant's own: a grant of another organization is left as it is. */
    input: { actor: string; id: string; organizationId?: string },
    now?: Date
  ) => Promise<{ revoked: boolean }>;
  /**
   * The organization opts into the trial (the renewal method comes next). The
   * trial is once per person (ADR 0101): `userId` is the authenticated user of
   * the session, set by the server, never taken from the client. It reserves
   * that person's trial for the organization; a trial already used is
   * `trial_already_used`, and one reserved for another organization still
   * setting up its trial is `trial_in_progress`. A reservation that moves here
   * from an organization with a checkout still linked has that checkout given
   * up at the provider afterwards (`discardCheckout` of the options), best effort.
   */
  startTrial: (
    organizationId: string,
    userId: string,
    now?: Date
  ) => Promise<BillingRecord>;
  /**
   * Settles one unclaimed trial: `cancel` is called with the event's own
   * subscription (never the organization's current one) while the event is
   * locked, and only when it succeeds is the event closed (`ignored`, the outcome
   * kept as `trial_claim_missing`) and the decision written in the ledger
   * (`unclaimed_trial_cancelled` or `unclaimed_trial_left_paid`, under
   * `command:settle_unclaimed_trial:<eventId>`). A failure of `cancel` changes
   * nothing, so the next pass tries again; `cancel` must be safe to repeat.
   * `cancel` answers `paid` when the provider shows a charge of that
   * subscription already paid: it cancels nothing and the event is recorded as
   * `left_paid`, like a record that already gives Pro on that reference.
   */
  settleUnclaimedTrial: (
    eventId: string,
    cancel: (event: UnclaimedTrialEvent) => Promise<"cancelled" | "paid">,
    now?: Date
  ) => Promise<UnclaimedTrialOutcome>;
  /**
   * Applies what time itself causes: records whose access has run out, grants
   * that ended, and trial setups abandoned (no checkout can still be finished).
   */
  sweepDue: (now?: Date, limit?: number) => Promise<BillingSweepReport>;
  /**
   * Runs `operation` while holding the payer's lock (ADR 0101, emenda do PR 6):
   * two Pix checkouts of the same CPF or CNPJ never align the customer and
   * create the subscription at the same time. `key` is a keyed digest of the
   * document (8 hex digits), never the document: without the server's key it
   * cannot be aimed at, and two documents that share it only wait for each
   * other. The lock is a transaction-scoped advisory lock on its own
   * connection; waiting longer than 10 s fails with SQLSTATE 55P03, and the
   * transaction ends if it sits idle for 60 s (a Worker stopped mid-way never
   * keeps it).
   */
  withPayerLock: <T>(key: string, operation: () => Promise<T>) => Promise<T>;
  /**
   * Runs `operation` while holding the organization's command lock (ADR 0066,
   * emenda de 23/10): two commands that take it never run at once for the same
   * organization, and the second decides by the state the first left. Today
   * only the refund takes it; the cancellation commands and the closure's
   * consumer do not (their second fact is ignored by the record). The lock is
   * never waited for: when another command holds it,
   * this fails at once with `BillingCommandInProgressError`, so a loop of
   * commands cannot fill the pool. Like the payer's lock, it is a
   * transaction-scoped advisory lock on its own connection, and the
   * transaction ends if it sits idle for 60 s (an operation longer than that
   * loses the lock and its commit fails; a repeat is safe). Webhooks and the
   * maintenance never take it: the inbox orders the facts.
   */
  withOrganizationLock: <T>(
    organizationId: string,
    operation: () => Promise<T>
  ) => Promise<T>;
}

/** Another command holds the organization's lock; nothing was done, and a retry later is safe. */
export class BillingCommandInProgressError extends Error {
  readonly code = "command_in_progress";

  constructor() {
    super("command_in_progress");
    this.name = "BillingCommandInProgressError";
  }
}

/** The key of the payer's lock: 8 hex digits of a keyed digest of the document. */
const payerLockKeyPattern = /^[\da-f]{8}$/;

/** Takes the payer's lock on `client`, inside its transaction, then runs `operation` on the pool's other connections. */
async function holdPayerLock<T>(
  client: PoolClient,
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  await client.query("SET LOCAL lock_timeout = '10s'");
  // a Worker stopped while it holds the lock must not keep it: the server ends the transaction
  await client.query("SET LOCAL idle_in_transaction_session_timeout = '60s'");
  await client.query(
    "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
    [`polaris.billing.payer:${key}`]
  );
  return await operation();
}

interface BillingRow {
  access_ends_at: Date | null;
  cancel_at_period_end: boolean;
  cycle_months: number | null;
  last_fact_at: Date | null;
  organization_id: string;
  over_limit_since: Date | null;
  pending_cycle_months: number | null;
  provider: string | null;
  provider_ref: string | null;
  provider_subscription_id: string | null;
  revoked_cancel_at_period_end: boolean;
  revoked_cycle_months: number | null;
  revoked_reason: string | null;
  revoked_through: Date | null;
  state: string;
  trial_started_at: Date | null;
}

const BILLING_COLUMNS =
  "organization_id, state, access_ends_at, cancel_at_period_end, cycle_months, pending_cycle_months, last_fact_at, provider, provider_ref, provider_subscription_id, trial_started_at, revoked_through, revoked_reason, revoked_cycle_months, revoked_cancel_at_period_end, over_limit_since";

function cycle(value: number | null): BillingCycleMonths | null {
  return value !== null && isBillingCycleMonths(value) ? value : null;
}

function toRecord(row: BillingRow): BillingRecord {
  return {
    accessEndsAt: row.access_ends_at,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    cycleMonths: cycle(row.cycle_months),
    lastFactAt: row.last_fact_at,
    pendingCycleMonths: cycle(row.pending_cycle_months),
    state: row.state as BillingState,
    revoked:
      row.revoked_through !== null &&
      (row.revoked_reason === "refund" ||
        row.revoked_reason === "chargeback" ||
        row.revoked_reason === "won")
        ? {
            cancelAtPeriodEnd: row.revoked_cancel_at_period_end,
            cycleMonths: cycle(row.revoked_cycle_months),
            periodEndsAt: row.revoked_through,
            reason: row.revoked_reason,
          }
        : null,
    trialConsumed: row.trial_started_at !== null,
  };
}

/**
 * Records notices of one store in the caller's transaction and, for each one new, its outbox event `billing.notice`
 * (ADR 0104, decision 7): the same notice again records nothing and writes no second event. The welcome carries its
 * person; a notice of the billing cycle has none (the consumer reads the owner when it sends). Answers how many were new.
 */
async function recordNotices(
  client: PoolClient,
  organizationId: string,
  marks: readonly BillingNoticeMark[]
): Promise<number> {
  let recorded = 0;
  for (const mark of marks) {
    // biome-ignore lint/performance/noAwaitInLoops: a notice and its event, one after the other, in one transaction
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO public.billing_notices (organization_id, kind, dedupe_key, due_at, user_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        organizationId,
        mark.kind,
        mark.dedupeKey,
        mark.dueAt,
        mark.kind === "welcome" ? mark.dedupeKey : null,
      ]
    );
    const noticeId = inserted.rows[0]?.id;
    if (!noticeId) {
      continue;
    }
    const event = outboxEvent({
      event: { noticeId },
      idempotencyKey: outboxIdempotencyKey("billing.notice", noticeId),
      organizationId,
      type: "billing.notice",
    });
    // only the five columns the billing role may insert; its policy takes nothing but this event
    await client.query(
      `INSERT INTO public.event_outbox (organization_id, type, event, idempotency_key, correlation_id)
       VALUES ($1, $2, $3::jsonb, $4, $5)`,
      [
        event.organizationId,
        event.type,
        JSON.stringify(event.event),
        event.idempotencyKey,
        randomUUID(),
      ]
    );
    recorded += 1;
  }
  return recorded;
}

async function inTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** The organization's billing row, created as Free when it has none, locked for the rest of the transaction. */
async function lockRecord(
  client: PoolClient,
  organizationId: string
): Promise<BillingRow> {
  await client.query(
    "INSERT INTO public.organization_billing (organization_id) VALUES ($1) ON CONFLICT (organization_id) DO NOTHING",
    [organizationId]
  );
  const result = await client.query<BillingRow>(
    `SELECT ${BILLING_COLUMNS} FROM public.organization_billing WHERE organization_id = $1 FOR UPDATE`,
    [organizationId]
  );
  const [row] = result.rows;
  if (!row) {
    throw new Error("billing_record_missing");
  }
  return row;
}

async function exceedsFreeLimits(
  client: PoolClient,
  organizationId: string
): Promise<boolean> {
  const result = await client.query<{ exceeds: boolean }>(
    "SELECT public.organization_exceeds_free_limits($1) AS exceeds",
    [organizationId]
  );
  return result.rows[0]?.exceeds === true;
}

/**
 * The trial reservation the fact that starts this organization's trial consumes:
 * the one reserved for it last (the person whose opt-in put it in
 * `trial_setup`), locked for the rest of the transaction so it cannot move
 * before it is consumed. The record is locked first, as in `startTrial`. Null
 * when the organization holds none.
 */
async function lockTrialClaim(
  client: PoolClient,
  organizationId: string
): Promise<string | null> {
  const result = await client.query<{ user_id: string }>(
    `SELECT user_id FROM public.billing_trial_claims
      WHERE organization_id = $1 AND consumed_at IS NULL
      ORDER BY reserved_at DESC, user_id
      LIMIT 1
      FOR UPDATE`,
    [organizationId]
  );
  return result.rows[0]?.user_id ?? null;
}

/**
 * Writes the record. `trialClaimUserId` is given when the fact that starts the
 * trial (`trial_method_ready`) applied: that person's reservation (locked by
 * `lockTrialClaim`) is consumed in the same statement that records
 * `trial_started_at` (ADR 0101), so one never exists without the other.
 * Abandoning the checkout consumes nothing.
 */
async function saveRecord(
  client: PoolClient,
  organizationId: string,
  before: BillingRecord,
  next: BillingRecord,
  now: Date,
  trialClaimUserId: string | null = null
): Promise<void> {
  // when the organization left Pro (the start of the Free Over Limit adaptation window, ADR 0064)
  const episode = episodeStartAfter({
    before,
    nextState: next.state,
    now,
  });
  const saved = await client.query<{ consumed_claims: number }>(
    `WITH trial_claim AS (
       UPDATE public.billing_trial_claims SET consumed_at = $9::timestamptz
        WHERE user_id = $16 AND organization_id = $1 AND consumed_at IS NULL
        RETURNING user_id
     )
     UPDATE public.organization_billing SET
       state = $2,
       access_ends_at = $3,
       cancel_at_period_end = $4,
       cycle_months = $5,
       pending_cycle_months = $6,
       last_fact_at = $7,
       trial_started_at = CASE WHEN $8::boolean THEN COALESCE(trial_started_at, $9::timestamptz) ELSE trial_started_at END,
       over_limit_since = CASE WHEN $10::boolean THEN over_limit_since ELSE $11::timestamptz END,
       revoked_through = $12::timestamptz,
       revoked_reason = $13,
       revoked_cycle_months = $14,
       revoked_cancel_at_period_end = $15,
       updated_at = $9::timestamptz,
       version = version + 1
     WHERE organization_id = $1
     RETURNING (SELECT count(*) FROM trial_claim)::integer AS consumed_claims`,
    [
      organizationId,
      next.state,
      next.accessEndsAt,
      next.cancelAtPeriodEnd,
      next.cycleMonths,
      next.pendingCycleMonths,
      next.lastFactAt,
      next.trialConsumed,
      now,
      episode === "keep",
      // a kept episode keeps whatever the record says, including nothing (never a fresh window)
      episode === "keep" ? null : episode,
      next.revoked?.periodEndsAt ?? null,
      next.revoked?.reason ?? null,
      next.revoked?.cycleMonths ?? null,
      next.revoked?.cancelAtPeriodEnd ?? false,
      trialClaimUserId,
    ]
  );
  if (
    trialClaimUserId !== null &&
    (saved.rows[0]?.consumed_claims ?? 0) !== 1
  ) {
    // the reservation was locked a moment ago: never a trial without its consumption
    throw new Error("billing_trial_claim_not_consumed");
  }
}

interface EventRow {
  attempts: number;
  fact: unknown;
  id: string;
  organization_id: string | null;
  provider: string;
  provider_ref: string | null;
  provider_subscription_id: string | null;
  status: BillingEventStatus;
}

async function finishEvent(
  client: PoolClient,
  eventId: string,
  result: {
    organizationId: string | null;
    outcomeCode: string | null;
    stateAfter: string | null;
    stateBefore: string | null;
    status: "applied" | "failed" | "ignored" | "unresolved";
  },
  now: Date,
  attempts: number
): Promise<void> {
  await client.query(
    `UPDATE public.billing_events SET
       organization_id = COALESCE($2, organization_id),
       status = $3,
       outcome_code = $4,
       state_before = $5,
       state_after = $6,
       attempts = $7,
       processed_at = $8
     WHERE id = $1`,
    [
      eventId,
      result.organizationId,
      result.status,
      result.outcomeCode,
      result.stateBefore,
      result.stateAfter,
      attempts,
      now,
    ]
  );
}

/** The states a first charge takes to `active`: a trial (being set up or running) or Free (Pix Automático without a trial). */
const FIRST_CHARGE_FROM: ReadonlySet<BillingState> = new Set([
  "free",
  "free_over_limit",
  "trial_setup",
  "trialing",
]);

/**
 * The first charge of the link (ADR 0104, §7 of design t268), when an applied `charge_succeeded` takes the record
 * from a trial or Free to `active`: the moment the provider says it happened (`occurredAt`), never the moment it was
 * processed, so a late webhook does not push the window of the right of withdrawal; the amount the fact carries (the
 * price sent to the provider without one); and the ledger row of the fact. Only the first one of the link: a renewal,
 * or a charge after one taken back on the same link, keeps what is there.
 */
async function recordFirstCharge(
  client: PoolClient,
  input: {
    after: BillingState;
    before: BillingState;
    eventId: string;
    fact: BillingFact;
    organizationId: string;
  }
): Promise<void> {
  const { fact } = input;
  if (
    fact.type !== "charge_succeeded" ||
    !FIRST_CHARGE_FROM.has(input.before) ||
    input.after !== "active"
  ) {
    return;
  }
  await client.query(
    `UPDATE public.organization_billing SET
       first_charge_at = $2::timestamptz,
       first_charge_amount = COALESCE($3::numeric, price_amount),
       first_charge_event_id = $4::uuid
     WHERE organization_id = $1 AND first_charge_at IS NULL`,
    [
      input.organizationId,
      fact.occurredAt,
      fact.amount?.value ?? null,
      input.eventId,
    ]
  );
}

const ignoredCode: Record<IgnoredFactReason, string> = {
  not_applicable: "not_applicable",
  stale: "stale",
};

async function resolveOrganization(
  client: PoolClient,
  row: EventRow
): Promise<string | null> {
  if (row.organization_id) {
    return row.organization_id;
  }
  if (!row.provider_ref) {
    return null;
  }
  const result = await client.query<{ organization_id: string }>(
    "SELECT organization_id FROM public.organization_billing WHERE provider = $1 AND provider_ref = $2",
    [row.provider, row.provider_ref]
  );
  return result.rows[0]?.organization_id ?? null;
}

/** Whether the subscription reference is linked to an organization other than this one. */
async function claimedByAnother(
  client: PoolClient,
  provider: string,
  providerRef: string,
  organizationId: string
): Promise<boolean> {
  const result = await client.query(
    "SELECT 1 FROM public.organization_billing WHERE provider = $1 AND provider_ref = $2 AND organization_id <> $3",
    [provider, providerRef, organizationId]
  );
  return (result.rowCount ?? 0) > 0;
}

async function processInTransaction(
  client: PoolClient,
  eventId: string,
  now: Date
): Promise<ProcessedBillingEvent> {
  const found = await client.query<EventRow>(
    "SELECT id, provider, provider_ref, provider_subscription_id, organization_id, fact, status, attempts FROM public.billing_events WHERE id = $1 FOR UPDATE",
    [eventId]
  );
  const [event] = found.rows;
  if (!event) {
    throw new Error("billing_event_not_found");
  }
  if (event.status === "applied" || event.status === "ignored") {
    const done = await client.query<{ outcome_code: string | null }>(
      "SELECT outcome_code FROM public.billing_events WHERE id = $1",
      [eventId]
    );
    return {
      eventId,
      organizationId: event.organization_id,
      outcomeCode: done.rows[0]?.outcome_code ?? null,
      status: event.status,
    };
  }
  const attempts = event.attempts + 1;
  const fail = async (
    outcomeCode: string,
    knownOrganizationId: string | null
  ) => {
    await finishEvent(
      client,
      eventId,
      {
        organizationId: knownOrganizationId,
        outcomeCode,
        stateAfter: null,
        stateBefore: null,
        status: "failed",
      },
      now,
      attempts
    );
    return {
      eventId,
      organizationId: knownOrganizationId,
      outcomeCode,
      status: "failed" as const,
    };
  };

  const fact = parseBillingFact(event.fact);
  if (!fact) {
    return await fail("error", event.organization_id);
  }
  const recordIncident = async (
    cause: "reference_mismatch" | "reference_unresolved"
  ) => {
    await client.query(
      "SELECT public.record_billing_reference_incident($1, $2, $3)",
      [cause, fact.type, eventId]
    );
  };
  // A fact no subscription claims yet waits for the link (the retry pass); the one
  // that is still unclaimed at its last attempt is an incident too: a provider
  // reference that never matches is a field mapped wrong, not a delay (ADR 0087).
  const failUnresolved = async () => {
    if (attempts === MAX_BILLING_EVENT_ATTEMPTS) {
      await recordIncident("reference_unresolved");
    }
    return await fail("unknown_organization", null);
  };
  const organizationId = await resolveOrganization(client, event);
  if (!organizationId) {
    return await failUnresolved();
  }

  const row = await lockRecord(client, organizationId);
  const before = toRecord(row);
  // Every fact comes from the provider, so every fact names the subscription it is
  // about and the record must have that very subscription attached (ADR 0087): a
  // fact without a reference, or with another one (an old checkout, a subscription
  // since replaced), changes nothing, and the mistake is an operational incident
  // instead of a silent loss (as is a fact that never finds its subscription).
  // `attachProvider` is the only way a reference is linked, so a fact that arrives
  // before the link finds no subscription yet: it fails and the retry pass applies
  // it once the link exists. A reference that is linked to another organization is
  // not a wait: it is a mismatch.
  const waitsForLink =
    event.provider_ref !== null &&
    row.provider === null &&
    !(await claimedByAnother(
      client,
      event.provider,
      event.provider_ref,
      organizationId
    ));
  if (waitsForLink) {
    return await failUnresolved();
  }
  if (
    !event.provider_ref ||
    row.provider !== event.provider ||
    row.provider_ref !== event.provider_ref
  ) {
    await recordIncident("reference_mismatch");
    await finishEvent(
      client,
      eventId,
      {
        organizationId,
        outcomeCode: "reference_mismatch",
        stateAfter: before.state,
        stateBefore: before.state,
        status: "ignored",
      },
      now,
      attempts
    );
    return {
      eventId,
      organizationId,
      outcomeCode: "reference_mismatch",
      status: "ignored",
    };
  }
  // the first fact that matched the reference tells which subscription it is at the
  // provider: the commands find it by that ID from then on (ADR 0101). The first
  // one stays: a checkout makes one subscription
  if (
    event.provider_subscription_id !== null &&
    row.provider_subscription_id === null
  ) {
    // never the ID another organization already holds (one subscription, one organization)
    await client.query(
      `UPDATE public.organization_billing SET provider_subscription_id = $3, updated_at = $4, version = version + 1
        WHERE organization_id = $1 AND provider_subscription_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM public.organization_billing AS other
             WHERE other.provider = $2 AND other.provider_subscription_id = $3
          )`,
      [organizationId, event.provider, event.provider_subscription_id, now]
    );
  }
  const result = reconcileFact(before, fact, {
    now,
    // every state asks: an abandoned trial checkout returns to Free Over Limit, not to Free,
    // when the organization still holds more than Free allows
    overFreeLimits: await exceedsFreeLimits(client, organizationId),
  });
  if (result.outcome === "ignored") {
    await finishEvent(
      client,
      eventId,
      {
        organizationId,
        outcomeCode: ignoredCode[result.reason],
        stateAfter: before.state,
        stateBefore: before.state,
        status: "ignored",
      },
      now,
      attempts
    );
    return {
      eventId,
      organizationId,
      outcomeCode: ignoredCode[result.reason],
      status: "ignored",
    };
  }
  // the one place that decides whether this fact starts the trial (and so spends a reservation)
  const startsTrial =
    fact.type === "trial_method_ready" &&
    !before.trialConsumed &&
    result.record.trialConsumed;
  const trialClaimUserId = startsTrial
    ? await lockTrialClaim(client, organizationId)
    : null;
  if (startsTrial && trialClaimUserId === null) {
    // a trial nobody's reservation pays for (a checkout paid after the person took
    // the reservation to another organization, or an opt-in from before the trial
    // was per person): it does not start, which the trial per person exists to
    // prevent. The organization stays as it is and nothing is charged here; the
    // event waits, read again by the retry pass, and the reconciliation decides
    // (cancel the subscription, or charge it without a trial)
    // the last attempt is an error: from then on only the reconciliation reads it
    const unclaimed = {
      eventId,
      organizationId: opaqueId(organizationId),
    };
    if (attempts >= MAX_BILLING_EVENT_ATTEMPTS) {
      logger.error("billing_trial_fact_without_claim", unclaimed);
    } else {
      logger.warn("billing_trial_fact_without_claim", unclaimed);
    }
    await finishEvent(
      client,
      eventId,
      {
        organizationId,
        outcomeCode: "trial_claim_missing",
        stateAfter: before.state,
        stateBefore: before.state,
        status: "unresolved",
      },
      now,
      attempts
    );
    return {
      eventId,
      organizationId,
      outcomeCode: "trial_claim_missing",
      status: "unresolved",
    };
  }
  await saveRecord(
    client,
    organizationId,
    before,
    result.record,
    now,
    trialClaimUserId
  );
  await recordFirstCharge(client, {
    after: result.record.state,
    before: before.state,
    eventId,
    fact,
    organizationId,
  });
  await finishEvent(
    client,
    eventId,
    {
      organizationId,
      outcomeCode: null,
      stateAfter: result.record.state,
      stateBefore: before.state,
      status: "applied",
    },
    now,
    attempts
  );
  return { eventId, organizationId, outcomeCode: null, status: "applied" };
}

/** A ledger row for a transition the system caused itself (the sweep, a command). */
async function writeLedger(
  client: PoolClient,
  entry: {
    fact: Record<string, number | string>;
    factType: "command" | "time_elapsed";
    organizationId: string;
    providerEventId: string;
    /** The provider's reference the command acted on, kept in its column (never in the fact). */
    providerRef?: string;
    stateAfter: BillingState;
    stateBefore: BillingState;
  },
  now: Date
): Promise<void> {
  await client.query(
    `INSERT INTO public.billing_events
       (provider, provider_event_id, organization_id, fact, fact_type, occurred_at, status, state_before, state_after, attempts, processed_at, provider_ref)
     VALUES ('polaris', $1, $2, $3::jsonb, $4, $5, 'applied', $6, $7, 1, $5, $8)
     ON CONFLICT (provider, provider_event_id) DO NOTHING`,
    [
      entry.providerEventId,
      entry.organizationId,
      JSON.stringify(entry.fact),
      entry.factType,
      now,
      entry.stateBefore,
      entry.stateAfter,
      entry.providerRef ?? null,
    ]
  );
}

async function sweepOne(
  pool: Pool,
  organizationId: string,
  now: Date
): Promise<boolean> {
  return await inTransaction(pool, async (client) => {
    const row = await lockRecord(client, organizationId);
    const before = toRecord(row);
    if (!grantsPro(before.state)) {
      return false;
    }
    const due = dueTransition(before, {
      now,
      overFreeLimits: await exceedsFreeLimits(client, organizationId),
    });
    if (!due) {
      return false;
    }
    await saveRecord(client, organizationId, before, due.record, now);
    await writeLedger(
      client,
      {
        fact: { transition: due.transition, type: "time_elapsed" },
        factType: "time_elapsed",
        organizationId,
        // one row per transition of one period: running the sweep twice adds nothing
        providerEventId: `time:${organizationId}:${due.transition}:${before.accessEndsAt?.toISOString() ?? "none"}`,
        stateAfter: due.record.state,
        stateBefore: before.state,
      },
      now
    );
    return true;
  });
}

/**
 * How long an organization may stay setting up its trial (`trial_setup`) with
 * nothing happening before the setup counts as abandoned. "Nothing happening"
 * is read from `updated_at`, which every write of the record moves (the opt-in,
 * the link of a checkout, a fact that changes it): the time counts from the
 * last of them, never less than from the opt-in. The hosted checkout
 * expires within the hour, so after this nobody can still finish it; without
 * the end, the person's reservation would stay held there and every other
 * organization of the person would get `trial_in_progress` (ADR 0101).
 */
const TRIAL_SETUP_ABANDONED_AFTER_HOURS = 2;

/**
 * Ends one abandoned trial setup (back to Free, or Free Over Limit). The
 * reservation is not consumed and stays with the organization, so a payment of
 * the checkout that still arrives late starts the trial as before; once the
 * reservation moves elsewhere, that payment is `trial_claim_missing`.
 */
async function abandonOne(
  pool: Pool,
  organizationId: string,
  now: Date
): Promise<boolean> {
  return await inTransaction(pool, async (client) => {
    const row = await lockRecord(client, organizationId);
    const before = toRecord(row);
    const stale = await client.query<{ updated_at: Date }>(
      `SELECT updated_at FROM public.organization_billing
        WHERE organization_id = $1 AND state = 'trial_setup'
          AND updated_at < $2::timestamptz - make_interval(hours => $3)`,
      [organizationId, now, TRIAL_SETUP_ABANDONED_AFTER_HOURS]
    );
    const [setup] = stale.rows;
    if (!setup) {
      // something happened since it was listed
      return false;
    }
    const next: BillingRecord = {
      ...before,
      ...applyBillingEvent(
        before,
        { type: "abandon_trial_setup" },
        {
          now,
          overFreeLimits: await exceedsFreeLimits(client, organizationId),
          trialConsumed: before.trialConsumed,
        }
      ),
    };
    await saveRecord(client, organizationId, before, next, now);
    await writeLedger(
      client,
      {
        fact: { transition: "abandon_trial_setup", type: "time_elapsed" },
        factType: "time_elapsed",
        organizationId,
        // one row per abandoned setup: running the sweep twice adds nothing
        providerEventId: `time:${organizationId}:abandon_trial_setup:${setup.updated_at.toISOString()}`,
        stateAfter: next.state,
        stateBefore: before.state,
      },
      now
    );
    return true;
  });
}

async function sweepAbandonedTrialSetups(
  pool: Pool,
  now: Date,
  limit: number
): Promise<BillingSweepReport> {
  const stale = await pool.query<{ organization_id: string }>(
    `SELECT organization_id FROM public.organization_billing
      WHERE state = 'trial_setup'
        AND updated_at < $1::timestamptz - make_interval(hours => $3)
      ORDER BY updated_at, organization_id
      LIMIT $2`,
    [now, limit, TRIAL_SETUP_ABANDONED_AFTER_HOURS]
  );
  const report: BillingSweepReport = {
    failed: 0,
    scanned: stale.rows.length,
    transitioned: 0,
  };
  for (const { organization_id: organizationId } of stale.rows) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: One organization at a time keeps the load on the billing role bounded.
      if (await abandonOne(pool, organizationId, now)) {
        report.transitioned += 1;
      }
    } catch (error: unknown) {
      report.failed += 1;
      logger.error("billing_trial_setup_sweep_failed", {
        ...describeError(error),
        organizationId: opaqueId(organizationId),
      });
    }
  }
  return report;
}

const LIMIT_KEYS_SQL =
  "('goals.active.max', 'images.active.max', 'images.per_product.max', 'variants.active.max')";
/** A grant that ended more than this long ago no longer starts an adaptation window. */
const GRANT_EXPIRY_LOOKBACK = "90 days";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A grant is in force between its start and its end, unless it was revoked before it started. */
const IN_FORCE_SQL =
  "starts_at <= $2 AND expires_at > $2 AND (revoked_at IS NULL OR revoked_at > starts_at)";

/**
 * An organization that held more than Free allows only because of a limit grant,
 * and whose grant for that very limit has ended (none for it in force), is in the
 * same position as one that left Pro (ADR 0064): the data stays and the
 * adaptation window starts at the end of the grant. It is decided limit by
 * limit: a grant for another limit that still runs does not hide it. A plain
 * Free record becomes `free_over_limit`; one that already was gets a fresh
 * window if the grant ended after its window began. A Pro record, or one setting
 * up a trial, is left alone (the plan decides).
 */
async function sweepGrantOne(
  pool: Pool,
  organizationId: string,
  now: Date
): Promise<boolean> {
  return await inTransaction(pool, async (client) => {
    const row = await lockRecord(client, organizationId);
    const state = row.state as BillingState;
    if (grantsPro(state) || state === "trial_setup") {
      return false;
    }
    const excess = await client.query<{ keys: string[] }>(
      "SELECT public.organization_free_limit_excess($1) AS keys",
      [organizationId]
    );
    const [first] = excess.rows;
    const exceeded = first?.keys ?? [];
    if (exceeded.length === 0) {
      return false;
    }
    // for each limit it exceeds: the end of its latest grant, unless one for it is still in force
    const ended = await client.query<{ expired_at: Date | null }>(
      `SELECT max(expires_at) FILTER (WHERE expires_at <= $2 AND expires_at > $2::timestamptz - interval '${GRANT_EXPIRY_LOOKBACK}'
                                         AND (revoked_at IS NULL OR revoked_at > starts_at)) AS expired_at
         FROM public.entitlement_grants
        WHERE organization_id = $1 AND key = ANY($3::text[])
        GROUP BY key
       HAVING NOT bool_or(${IN_FORCE_SQL})`,
      [organizationId, now, exceeded]
    );
    const [expiredAt] = ended.rows
      .map((entry) => entry.expired_at)
      .filter((value): value is Date => value !== null)
      .map((value) => new Date(value))
      .sort((left, right) => right.getTime() - left.getTime());
    if (!expiredAt) {
      return false;
    }
    if (
      state === "free_over_limit" &&
      row.over_limit_since !== null &&
      row.over_limit_since.getTime() >= expiredAt.getTime()
    ) {
      return false;
    }
    await client.query(
      `UPDATE public.organization_billing
          SET state = 'free_over_limit', over_limit_since = $2, updated_at = $3::timestamptz, version = version + 1
        WHERE organization_id = $1`,
      [organizationId, expiredAt, now]
    );
    await writeLedger(
      client,
      {
        fact: { transition: "grant_expired", type: "time_elapsed" },
        factType: "time_elapsed",
        organizationId,
        providerEventId: `time:${organizationId}:grant_expired:${expiredAt.toISOString()}`,
        stateAfter: "free_over_limit",
        stateBefore: state,
      },
      now
    );
    return true;
  });
}

/**
 * The organizations whose limit grants ended recently and who could be affected:
 * not paying, not setting up a trial, and not already moved past that end (a
 * `free_over_limit` record without a start is not past it: the sweep dates it). The
 * newest first, so a run that cannot look at them all never leaves the freshest
 * end unexamined behind older ones that were examined when they were new.
 */
async function sweepExpiredGrants(
  pool: Pool,
  now: Date,
  limit: number
): Promise<BillingSweepReport> {
  const candidates = await pool.query<{ organization_id: string }>(
    `SELECT g.organization_id
       FROM public.entitlement_grants g
       LEFT JOIN public.organization_billing b ON b.organization_id = g.organization_id
      WHERE g.key IN ${LIMIT_KEYS_SQL}
        AND g.expires_at <= $1
        AND g.expires_at > $1::timestamptz - interval '${GRANT_EXPIRY_LOOKBACK}'
        AND (g.revoked_at IS NULL OR g.revoked_at > g.starts_at)
        AND (b.organization_id IS NULL OR b.state NOT IN ('trialing', 'active', 'grace', 'trial_setup'))
      GROUP BY g.organization_id, b.state, b.over_limit_since
     HAVING NOT (b.state = 'free_over_limit' AND b.over_limit_since IS NOT NULL AND b.over_limit_since >= max(g.expires_at))
      ORDER BY max(g.expires_at) DESC, g.organization_id
      LIMIT $2`,
    [now, limit]
  );
  const report: BillingSweepReport = {
    failed: 0,
    scanned: candidates.rows.length,
    transitioned: 0,
  };
  for (const { organization_id: id } of candidates.rows) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: One organization at a time keeps the load on the billing role bounded.
      if (await sweepGrantOne(pool, id, now)) {
        report.transitioned += 1;
      }
    } catch (error: unknown) {
      report.failed += 1;
      logger.error("billing_grant_sweep_failed", {
        ...describeError(error),
        organizationId: opaqueId(id),
      });
    }
  }
  return report;
}

/**
 * Reserves the person's trial for the organization (ADR 0101), inside the
 * transaction that moves the organization to `trial_setup` (its record is
 * locked). The person's claim row is the lock: two organizations of the same
 * person starting a trial at the same time wait for each other here, and the
 * second one sees what the first one did. A trial already consumed is refused;
 * one reserved for another organization moves only if that organization is no
 * longer setting up its trial (its checkout was abandoned or it subscribed
 * without one). An organization already setting up the trial of another person
 * (a co-owner) refuses a second one: its trial is that person's. Answers the
 * checkout the reservation left behind, when it moved from an organization
 * that still has one linked and is not on Pro: the caller gives it up at the
 * provider once the move is committed.
 */
async function reserveTrial(
  client: PoolClient,
  input: {
    now: Date;
    organizationId: string;
    /** The organization is setting up a trial (`trial_setup`) before this command. */
    settingUp: boolean;
    userId: string;
  }
): Promise<AbandonedTrialCheckout | null> {
  const { now, organizationId, userId } = input;
  if (input.settingUp) {
    const current = await client.query<{ user_id: string }>(
      `SELECT user_id FROM public.billing_trial_claims
        WHERE organization_id = $1 AND consumed_at IS NULL
        ORDER BY reserved_at DESC, user_id LIMIT 1`,
      [organizationId]
    );
    const holder = current.rows[0]?.user_id;
    if (holder !== undefined && holder !== userId) {
      throw new Error("trial_in_progress");
    }
  }
  const inserted = await client.query(
    `INSERT INTO public.billing_trial_claims (user_id, organization_id, reserved_at)
     VALUES ($1, $2, $3) ON CONFLICT (user_id) DO NOTHING`,
    [userId, organizationId, now]
  );
  if (inserted.rowCount === 1) {
    return null;
  }
  const found = await client.query<{
    consumed_at: Date | null;
    organization_id: string;
  }>(
    "SELECT organization_id, consumed_at FROM public.billing_trial_claims WHERE user_id = $1 FOR UPDATE",
    [userId]
  );
  const [claim] = found.rows;
  if (!claim) {
    throw new Error("billing_trial_claim_missing");
  }
  if (claim.consumed_at !== null) {
    throw new Error("trial_already_used");
  }
  if (claim.organization_id === organizationId) {
    return null;
  }
  // read in one statement, not locked: locking the other record here, after the
  // claim, could deadlock with a `startTrial` of that organization
  const other = await client.query<{
    provider: string | null;
    provider_ref: string | null;
    state: string;
  }>(
    "SELECT state, provider, provider_ref FROM public.organization_billing WHERE organization_id = $1",
    [claim.organization_id]
  );
  const [left] = other.rows;
  if (left?.state === "trial_setup") {
    throw new Error("trial_in_progress");
  }
  await client.query(
    "UPDATE public.billing_trial_claims SET organization_id = $2, reserved_at = $3 WHERE user_id = $1",
    [userId, organizationId, now]
  );
  // a subscription that is live there is not a pending checkout: it is left alone
  return left?.provider &&
    left.provider_ref &&
    !grantsPro(left.state as BillingState)
    ? {
        organizationId: claim.organization_id,
        provider: left.provider,
        providerRef: left.provider_ref,
      }
    : null;
}

/** The owner's limit on the commands that call the provider (ADR 0104, decision 4). */
const PROVIDER_COMMAND_SPACING_SECONDS = 30;
const PROVIDER_COMMANDS_PER_HOUR = 10;

/** The safety net reads this many stores a pass and stops trying a link after this many failures (ADR 0104). */
export const REFUND_REARM_BATCH = 20;
export const REFUND_REARM_MAX_ATTEMPTS = 10;

/**
 * A link the safety net acts on: the payment of the current link was taken back by a refund or a chargeback (never
 * `won`, which gave nothing back), the renewal was not cancelled at the moment of that fact (the memory keeps it) nor
 * since, and fewer than 10 tries were spent. `attachProvider` clears the memory, so this always describes the current
 * link. Constants only: no input reaches this text.
 */
const REFUND_REARM_CONDITION = `revoked_reason IN ('refund', 'chargeback')
  AND revoked_through IS NOT NULL
  AND provider IS NOT NULL AND provider_ref IS NOT NULL
  AND NOT revoked_cancel_at_period_end
  AND NOT cancel_at_period_end
  AND COALESCE(refund_rearm_attempts, 0) < ${REFUND_REARM_MAX_ATTEMPTS}`;

/**
 * A link whose safety net stopped: the same payment taken back, the renewal still not cancelled, and the 10 tries
 * spent. Constants only.
 */
const REFUND_REARM_EXHAUSTED_CONDITION = `revoked_reason IN ('refund', 'chargeback')
  AND revoked_through IS NOT NULL
  AND provider IS NOT NULL AND provider_ref IS NOT NULL
  AND NOT revoked_cancel_at_period_end
  AND NOT cancel_at_period_end
  AND refund_rearm_attempts >= ${REFUND_REARM_MAX_ATTEMPTS}`;

/** The ledger key of a stopped net: one per store and link (the reference goes in as a digest, as the tries'). */
const REFUND_REARM_EXHAUSTED_KEY = `'command:refund_rearm_exhausted:' || organization_id || ':' || left(encode(sha256(convert_to(provider_ref, 'UTF8')), 'hex'), 32)`;

/**
 * The back-off from the last try: 1 h, 2 h, 4 h, 8 h, 16 h, then 24 h, read against `$1` (the pass's clock). Five
 * minutes of slack, so a pass of the hourly cron is not skipped for the seconds the previous one took.
 */
const REFUND_REARM_DUE = `(refund_rearm_at IS NULL
  OR refund_rearm_at + make_interval(hours => LEAST(power(2, refund_rearm_attempts - 1)::integer, 24)) - interval '5 minutes' <= $1::timestamptz)`;

/** An owner's refund request of the current link still not completed 24 hours later, read against `$1`. */
const REFUND_PENDING_CONDITION = `refund_requested_at IS NOT NULL
  AND refund_requested_at <= $1::timestamptz - interval '24 hours'
  AND provider IS NOT NULL AND provider_ref IS NOT NULL
  AND revoked_reason IS DISTINCT FROM 'refund'`;

/** The ledger key of a pending refund: one per store and request (the moment of the request, to the microsecond). */
const REFUND_PENDING_KEY = `'command:refund_pending:' || organization_id || ':' || to_char(refund_requested_at AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MISSUS')`;

/**
 * One store of the safety net: the try is counted first (a Worker that stops mid-way never retries at once), then
 * the provider is called outside any transaction, then the cancellation is recorded if the link is still the same.
 */
async function rearmOne(
  pool: Pool,
  organizationId: string,
  input: {
    cancel: (
      renewal: RefundedRenewal
    ) => Promise<"already_cancelled" | "cancelled" | "nothing_to_cancel">;
  },
  now: Date
): Promise<"exhausted" | "failed" | "rearmed" | "skipped"> {
  const claimed = await pool.query<{
    provider: string;
    provider_ref: string;
    provider_subscription_id: string | null;
    refund_rearm_attempts: number;
    revoked_reason: "chargeback" | "refund";
  }>(
    `UPDATE public.organization_billing SET
       refund_rearm_attempts = COALESCE(refund_rearm_attempts, 0) + 1,
       refund_rearm_at = $1::timestamptz
     WHERE organization_id = $2 AND ${REFUND_REARM_CONDITION} AND ${REFUND_REARM_DUE}
     RETURNING provider, provider_ref, provider_subscription_id, refund_rearm_attempts, revoked_reason`,
    [now, organizationId]
  );
  const [row] = claimed.rows;
  if (!row) {
    // something changed since it was listed (a new link, a cancellation)
    return "skipped";
  }
  const renewal: RefundedRenewal = {
    attempt: row.refund_rearm_attempts,
    organizationId,
    provider: row.provider,
    providerRef: row.provider_ref,
    providerSubscriptionId: row.provider_subscription_id,
    reason: row.revoked_reason,
  };
  const ids = {
    attempt: renewal.attempt,
    organizationId: opaqueId(organizationId),
    provider: renewal.provider,
    reason: renewal.reason,
  };
  let result: "already_cancelled" | "cancelled" | "nothing_to_cancel";
  try {
    result = await input.cancel(renewal);
  } catch (error: unknown) {
    if (renewal.attempt >= REFUND_REARM_MAX_ATTEMPTS) {
      // the net stops here: an incident for a person, the renewal may still charge
      logger.error("billing_refund_rearm_exhausted", {
        ...describeError(error),
        ...ids,
      });
      await recordRearmExhaustedIncidentOf(pool, organizationId, now);
      return "exhausted";
    }
    logger.warn("billing_refund_rearm_failed", {
      ...describeError(error),
      ...ids,
    });
    return "failed";
  }
  // every answer means no renewal is alive at the provider: the memory says so, and the net stops
  let recorded: boolean;
  try {
    recorded = await inTransaction(pool, async (client) => {
      const locked = await lockRecord(client, organizationId);
      if (
        locked.provider !== renewal.provider ||
        locked.provider_ref !== renewal.providerRef ||
        (locked.revoked_reason !== "refund" &&
          locked.revoked_reason !== "chargeback") ||
        locked.revoked_cancel_at_period_end
      ) {
        return false;
      }
      await client.query(
        `UPDATE public.organization_billing SET revoked_cancel_at_period_end = true, updated_at = $2, version = version + 1
        WHERE organization_id = $1`,
        [organizationId, now]
      );
      await writeLedger(
        client,
        {
          fact: { occurredAt: now.toISOString(), type: "revoked_cancel" },
          factType: "command",
          organizationId,
          // one row per link and try; the reference goes in as a digest (the ID has a bounded length)
          providerEventId: `command:revoked_cancel:${organizationId}:${createHash("sha256").update(renewal.providerRef).digest("hex").slice(0, 32)}:${renewal.attempt}`,
          providerRef: renewal.providerRef,
          stateAfter: locked.state as BillingState,
          stateBefore: locked.state as BillingState,
        },
        now
      );
      return true;
    });
  } catch (error: unknown) {
    // the database failed after the provider answered: this store waits for its back-off, the pass goes on
    if (renewal.attempt >= REFUND_REARM_MAX_ATTEMPTS) {
      logger.error("billing_refund_rearm_exhausted", {
        ...describeError(error),
        ...ids,
      });
      await recordRearmExhaustedIncidentOf(pool, organizationId, now);
      return "exhausted";
    }
    logger.warn("billing_refund_rearm_failed", {
      ...describeError(error),
      ...ids,
    });
    return "failed";
  }
  logger.info("billing_refund_renewal_rearmed", {
    ...ids,
    recorded,
    renewal: result,
  });
  // a link that changed meanwhile is not counted: the memory of the new one was never the net's
  return recorded ? "rearmed" : "skipped";
}

/** Writes the ledger row and the incident of one store's pending refund, if the request is still pending. */
async function recordPendingRefundIncident(
  pool: Pool,
  organizationId: string,
  now: Date
): Promise<boolean> {
  return await inTransaction(pool, async (client) => {
    const row = await lockRecord(client, organizationId);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO public.billing_events
         (provider, provider_event_id, organization_id, fact, fact_type, occurred_at, status, state_before, state_after, attempts, processed_at, provider_ref)
       SELECT 'polaris', ${REFUND_PENDING_KEY}, organization_id,
              jsonb_build_object('type', 'refund_pending', 'occurredAt', to_char($1::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
              'command', $1::timestamptz, 'applied', state, state, 1, $1::timestamptz, provider_ref
         FROM public.organization_billing
        WHERE organization_id = $2 AND ${REFUND_PENDING_CONDITION}
       ON CONFLICT (provider, provider_event_id) DO NOTHING
       RETURNING id`,
      [now, organizationId]
    );
    const [event] = inserted.rows;
    if (!event) {
      return false;
    }
    await client.query(
      "SELECT public.record_billing_refund_pending_incident($1::uuid, 'refund_not_completed')",
      [event.id]
    );
    // for the operator: the store's opaque ID only (no amount, no reference of the provider)
    logger.error("billing_refund_pending_incident", {
      organizationId: opaqueId(organizationId),
      provider: row.provider ?? undefined,
    });
    return true;
  });
}

/**
 * Writes the ledger row and the incident of one store whose safety net stopped, if it is still stopped on the same
 * link: one occurrence per store and link, so a later pass adds nothing.
 */
async function recordRearmExhaustedIncident(
  pool: Pool,
  organizationId: string,
  now: Date
): Promise<boolean> {
  return await inTransaction(pool, async (client) => {
    // the log of the 10th failure (`billing_refund_rearm_exhausted`) already names the store
    await lockRecord(client, organizationId);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO public.billing_events
         (provider, provider_event_id, organization_id, fact, fact_type, occurred_at, status, state_before, state_after, attempts, processed_at, provider_ref)
       SELECT 'polaris', ${REFUND_REARM_EXHAUSTED_KEY}, organization_id,
              jsonb_build_object('type', 'refund_rearm_exhausted', 'occurredAt', to_char($1::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
              'command', $1::timestamptz, 'applied', state, state, 1, $1::timestamptz, provider_ref
         FROM public.organization_billing
        WHERE organization_id = $2 AND ${REFUND_REARM_EXHAUSTED_CONDITION}
       ON CONFLICT (provider, provider_event_id) DO NOTHING
       RETURNING id`,
      [now, organizationId]
    );
    const [event] = inserted.rows;
    if (!event) {
      return false;
    }
    await client.query(
      "SELECT public.record_billing_refund_pending_incident($1::uuid, 'refund_rearm_exhausted')",
      [event.id]
    );
    return true;
  });
}

/**
 * The incident of the 10th failure, written in the same pass. A failure here does not stop the pass: it is logged
 * (`billing_refund_pending_incident_failed`) and `recordPendingRefundIncidents` writes it on a later pass.
 */
async function recordRearmExhaustedIncidentOf(
  pool: Pool,
  organizationId: string,
  now: Date
): Promise<void> {
  try {
    await recordRearmExhaustedIncident(pool, organizationId, now);
  } catch (error: unknown) {
    logger.error("billing_refund_pending_incident_failed", {
      ...describeError(error),
      cause: "refund_rearm_exhausted",
      organizationId: opaqueId(organizationId),
    });
  }
}

export function createBillingStore(
  connectionString: string,
  options: BillingStoreOptions = {}
): BillingStore {
  const pool = guardPoolErrors(
    new Pool({
      connectionString,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 5000,
      max: 3,
    })
  );

  const store: BillingStore = {
    async attachProvider(organizationId, provider, providerRef, terms) {
      return await inTransaction(pool, async (client) => {
        const row = await lockRecord(client, organizationId);
        const sameSubscription =
          row.provider === provider && row.provider_ref === providerRef;
        if (sameSubscription) {
          return null;
        }
        // a subscription that is live (a trial running, a paid period, grace) is not
        // replaced; one that is not (a checkout that was abandoned, a person who left
        // and came back) is: the new reference is the one webhooks will name
        if (row.provider !== null && grantsPro(row.state as BillingState)) {
          throw new Error("billing_provider_already_attached");
        }
        await client.query(
          // a new subscription reference is a new checkout: a payment taken back on the old one does not follow it,
          // and neither do its first charge, the owner's refund request nor the safety net's back-off (ADR 0104: each
          // new subscription opens a new window of the right of withdrawal)
          `UPDATE public.organization_billing SET provider = $2, provider_ref = $3, provider_subscription_id = NULL,
             revoked_through = NULL, revoked_reason = NULL, revoked_cycle_months = NULL, revoked_cancel_at_period_end = false,
             price_amount = $4::numeric, price_id = $5, first_charge_on = $6::date,
             first_charge_at = NULL, first_charge_amount = NULL, first_charge_event_id = NULL,
             refund_requested_at = NULL, refund_request_id = NULL, refund_rearm_attempts = NULL, refund_rearm_at = NULL,
             updated_at = now(), version = version + 1 WHERE organization_id = $1`,
          [
            organizationId,
            provider,
            providerRef,
            terms?.priceAmount ?? null,
            terms?.priceId ?? null,
            terms?.firstChargeOn ?? null,
          ]
        );
        // the checkout it replaces may still be open at the provider: the caller gives
        // it up. One that a subscription already came from was finished: nothing to give up
        return row.provider &&
          row.provider_ref &&
          row.provider_subscription_id === null
          ? { provider: row.provider, providerRef: row.provider_ref }
          : null;
      });
    },
    async claimProviderCommand(organizationId, now = new Date()) {
      if (!uuidPattern.test(organizationId)) {
        throw new TypeError("invalid_organization_id");
      }
      return await inTransaction(pool, async (client) => {
        await lockRecord(client, organizationId);
        // one statement decides and counts: over the limit, nothing changes
        const counted = await client.query(
          `UPDATE public.organization_billing SET
             provider_command_at = $2::timestamptz,
             provider_commands_hour_start = CASE
               WHEN provider_commands_hour_start IS NULL OR provider_commands_hour_start <= $2::timestamptz - interval '1 hour'
               THEN $2::timestamptz ELSE provider_commands_hour_start END,
             provider_commands_hour = CASE
               WHEN provider_commands_hour_start IS NULL OR provider_commands_hour_start <= $2::timestamptz - interval '1 hour'
               THEN 1 ELSE provider_commands_hour + 1 END
           WHERE organization_id = $1
             AND (provider_command_at IS NULL OR provider_command_at <= $2::timestamptz - make_interval(secs => $3))
             AND (provider_commands_hour_start IS NULL
               OR provider_commands_hour_start <= $2::timestamptz - interval '1 hour'
               OR provider_commands_hour < $4)`,
          [
            organizationId,
            now,
            PROVIDER_COMMAND_SPACING_SECONDS,
            PROVIDER_COMMANDS_PER_HOUR,
          ]
        );
        return (counted.rowCount ?? 0) === 1;
      });
    },
    async close() {
      await pool.end();
    },
    async findEntitlementGrant(id) {
      if (!uuidPattern.test(id)) {
        throw new InvalidEntitlementGrantError("invalid_id");
      }
      const found = await pool.query<{
        expires_at: Date;
        flag_value: boolean | null;
        granted_by: string;
        key: string;
        limit_value: number | null;
        organization_id: string;
        reason: string;
        starts_at: Date;
      }>(
        `SELECT organization_id, key, limit_value, flag_value, reason, granted_by, starts_at, expires_at
           FROM public.entitlement_grants WHERE id = $1`,
        [id]
      );
      const [row] = found.rows;
      return row
        ? {
            expiresAt: row.expires_at,
            flagValue: row.flag_value,
            grantedBy: row.granted_by,
            key: row.key,
            limitValue: row.limit_value,
            organizationId: row.organization_id,
            reason: row.reason,
            startsAt: row.starts_at,
          }
        : null;
    },
    async grantEntitlement(input, now = new Date()) {
      const grant = normalizeGrant(input, now);
      const id = input.id ?? randomUUID();
      if (!uuidPattern.test(id)) {
        throw new InvalidEntitlementGrantError("invalid_id");
      }
      return await inTransaction(pool, async (client) => {
        // the billing row exists for any organization that has a grant, and is locked
        const row = await lockRecord(client, input.organizationId).catch(
          (error: unknown) => {
            if (
              error instanceof Error &&
              Reflect.get(error, "code") === "23503"
            ) {
              throw new Error("organization_not_found");
            }
            throw error;
          }
        );
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO public.entitlement_grants
             (id, organization_id, key, limit_value, flag_value, reason, granted_by, starts_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (id) DO NOTHING
           RETURNING id`,
          [
            id,
            input.organizationId,
            grant.key,
            grant.limitValue,
            grant.flagValue,
            grant.reason,
            grant.actor,
            grant.startsAt,
            grant.expiresAt,
          ]
        );
        if (inserted.rowCount === 0) {
          // the same ID again: the same grant, or a different one wearing its ID
          const existing = await client.query<{
            expires_at: Date;
            flag_value: boolean | null;
            granted_by: string;
            key: string;
            limit_value: number | null;
            organization_id: string;
            reason: string;
            starts_at: Date;
          }>(
            `SELECT organization_id, key, limit_value, flag_value, reason, granted_by, starts_at, expires_at
               FROM public.entitlement_grants WHERE id = $1`,
            [id]
          );
          const [stored] = existing.rows;
          // the same grant again, never a different one under the same ID
          if (
            !stored ||
            stored.organization_id !== input.organizationId ||
            stored.key !== grant.key ||
            stored.limit_value !== grant.limitValue ||
            stored.flag_value !== grant.flagValue ||
            stored.reason !== grant.reason ||
            stored.granted_by !== grant.actor ||
            stored.expires_at.getTime() !== grant.expiresAt.getTime() ||
            (input.startsAt !== undefined &&
              stored.starts_at.getTime() !== grant.startsAt.getTime())
          ) {
            throw new Error("entitlement_grant_id_conflict");
          }
          return { created: false, id };
        }
        // the ledger tells that it happened, by whom and for how long; why stays with the grant
        await writeLedger(
          client,
          {
            fact: {
              actor: grant.actor,
              expiresAt: grant.expiresAt.toISOString(),
              grantId: id,
              key: grant.key,
              startsAt: grant.startsAt.toISOString(),
              type: "grant_entitlement",
            },
            factType: "command",
            organizationId: input.organizationId,
            providerEventId: `command:grant:${id}`,
            stateAfter: row.state as BillingState,
            stateBefore: row.state as BillingState,
          },
          now
        );
        return { created: true, id };
      });
    },
    async revokeEntitlementGrant(input, now = new Date()) {
      if (!uuidPattern.test(input.id)) {
        throw new InvalidEntitlementGrantError("invalid_id");
      }
      if (!isValidGrantActor(input.actor)) {
        throw new InvalidEntitlementGrantError("invalid_actor");
      }
      const actor = input.actor.trim();
      return await inTransaction(pool, async (client) => {
        // a grant ends now; one that has not started ends as soon as the table allows (a millisecond after its start, and it never counts: it was revoked before it began)
        const ended = await client.query<{
          key: string;
          organization_id: string;
        }>(
          `UPDATE public.entitlement_grants
              SET expires_at = LEAST(expires_at, GREATEST($3::timestamptz, starts_at + interval '1 millisecond')), revoked_at = $3, revoked_by = $2
            WHERE id = $1 AND revoked_at IS NULL AND expires_at > $3::timestamptz
              AND ($4::text IS NULL OR organization_id = $4)
            RETURNING organization_id, key`,
          [input.id, actor, now, input.organizationId ?? null]
        );
        const [grant] = ended.rows;
        if (!grant) {
          return { revoked: false };
        }
        const row = await lockRecord(client, grant.organization_id);
        await writeLedger(
          client,
          {
            fact: {
              actor,
              grantId: input.id,
              key: grant.key,
              type: "revoke_entitlement_grant",
            },
            factType: "command",
            organizationId: grant.organization_id,
            providerEventId: `command:revoke-grant:${input.id}`,
            stateAfter: row.state as BillingState,
            stateBefore: row.state as BillingState,
          },
          now
        );
        return { revoked: true };
      });
    },
    async processEvent(eventId, now = new Date()) {
      try {
        return await inTransaction(pool, (client) =>
          processInTransaction(client, eventId, now)
        );
      } catch (error: unknown) {
        // the work was rolled back: record the failure on its own so a retry sees it
        await inTransaction(pool, async (client) => {
          await client.query(
            "UPDATE public.billing_events SET status = 'failed', outcome_code = 'error', attempts = attempts + 1, processed_at = $2 WHERE id = $1 AND status IN ('received', 'failed', 'unresolved')",
            [eventId, now]
          );
        }).catch(() => undefined);
        throw error;
      }
    },
    async checkoutDiscarded(organizationId, link) {
      // the reference is the checkout's own (for Asaas, its ID): one provider's references never name another's
      const result = await pool.query(
        `SELECT 1 FROM public.billing_events
          WHERE provider = 'polaris' AND organization_id = $1 AND fact_type = 'command'
            AND fact ->> 'type' = 'checkout_discarded' AND provider_ref = $2
          LIMIT 1`,
        [organizationId, link.providerRef]
      );
      return result.rows.length > 0;
    },
    async recordCheckoutDiscarded(input, now = new Date()) {
      await inTransaction(pool, async (client) => {
        const row = await lockRecord(client, input.organizationId);
        await writeLedger(
          client,
          {
            fact: { occurredAt: now.toISOString(), type: "checkout_discarded" },
            factType: "command",
            organizationId: input.organizationId,
            // one row per request and checkout; the reference goes in as a digest (the ID has a bounded length)
            providerEventId: `command:discard_checkout:${input.requestId}:${createHash("sha256").update(input.link.providerRef).digest("hex").slice(0, 32)}`,
            providerRef: input.link.providerRef,
            stateAfter: row.state as BillingState,
            stateBefore: row.state as BillingState,
          },
          now
        );
      });
    },
    async readProviderLink(organizationId) {
      const result = await pool.query<{
        provider: string | null;
        provider_ref: string | null;
        provider_subscription_id: string | null;
      }>(
        "SELECT provider, provider_ref, provider_subscription_id FROM public.organization_billing WHERE organization_id = $1",
        [organizationId]
      );
      const [row] = result.rows;
      return row?.provider && row.provider_ref
        ? {
            provider: row.provider,
            providerRef: row.provider_ref,
            providerSubscriptionId: row.provider_subscription_id,
          }
        : null;
    },
    async readRecord(organizationId) {
      const result = await pool.query<BillingRow>(
        `SELECT ${BILLING_COLUMNS} FROM public.organization_billing WHERE organization_id = $1`,
        [organizationId]
      );
      const [row] = result.rows;
      return row ? toRecord(row) : null;
    },
    async rearmRenewalCancellations(minAgeSeconds, limit, providers) {
      const result = await pool.query<{
        result: RenewalCancellationRearmReport;
      }>(
        "SELECT public.rearm_renewal_cancellations($1::integer, $2::integer, $3::text[]) AS result",
        [minAgeSeconds, limit, [...providers]]
      );
      const report = result.rows[0]?.result;
      return {
        inserted: Number(report?.inserted ?? 0),
        rearmed: Number(report?.rearmed ?? 0),
      };
    },
    async rearmRefundedRenewals(input) {
      const now = input.now ?? new Date();
      const limit = input.limit ?? REFUND_REARM_BATCH;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new RangeError("invalid_limit");
      }
      const due = await pool.query<{ organization_id: string }>(
        `SELECT organization_id FROM public.organization_billing
          WHERE ${REFUND_REARM_CONDITION} AND ${REFUND_REARM_DUE} AND provider = ANY($3::text[])
          ORDER BY refund_rearm_at NULLS FIRST, organization_id
          LIMIT $2`,
        [now, limit, [...input.providers]]
      );
      const report: RefundRearmReport = {
        exhausted: 0,
        failed: 0,
        rearmed: 0,
        scanned: due.rows.length,
      };
      for (const { organization_id: organizationId } of due.rows) {
        // biome-ignore lint/performance/noAwaitInLoops: One store at a time, so the provider is never flooded.
        const outcome = await rearmOne(pool, organizationId, input, now);
        if (outcome !== "skipped") {
          report[outcome] += 1;
          if (outcome === "exhausted") {
            report.failed += 1;
          }
        }
      }
      return report;
    },
    async recordPendingRefundIncidents(now = new Date(), limit = 50) {
      const due = await pool.query<{ organization_id: string }>(
        `SELECT pending.organization_id
           FROM (
             SELECT organization_id, ${REFUND_PENDING_KEY} AS ledger_key
               FROM public.organization_billing
              WHERE ${REFUND_PENDING_CONDITION}
           ) AS pending
          WHERE NOT EXISTS (
            SELECT 1 FROM public.billing_events AS ledger
             WHERE ledger.provider = 'polaris' AND ledger.provider_event_id = pending.ledger_key
          )
          ORDER BY pending.organization_id
          LIMIT $2`,
        [now, limit]
      );
      // a stopped net whose incident was not written in its pass (the database failed then)
      const stopped = await pool.query<{ organization_id: string }>(
        `SELECT stopped.organization_id
           FROM (
             SELECT organization_id, ${REFUND_REARM_EXHAUSTED_KEY} AS ledger_key
               FROM public.organization_billing
              WHERE ${REFUND_REARM_EXHAUSTED_CONDITION}
                -- the 10th try is counted before the call: one still running (or a pass that overlaps) is not a stop
                AND refund_rearm_at <= $2::timestamptz - interval '1 hour'
           ) AS stopped
          WHERE NOT EXISTS (
            SELECT 1 FROM public.billing_events AS ledger
             WHERE ledger.provider = 'polaris' AND ledger.provider_event_id = stopped.ledger_key
          )
          ORDER BY stopped.organization_id
          LIMIT $1`,
        [limit, now]
      );
      let recorded = 0;
      let failed = 0;
      const work = [
        ...due.rows.map((entry) => ({
          cause: "refund_not_completed" as const,
          organizationId: entry.organization_id,
        })),
        ...stopped.rows.map((entry) => ({
          cause: "refund_rearm_exhausted" as const,
          organizationId: entry.organization_id,
        })),
      ];
      for (const { cause, organizationId } of work) {
        try {
          const record =
            cause === "refund_not_completed"
              ? recordPendingRefundIncident
              : recordRearmExhaustedIncident;
          // biome-ignore lint/performance/noAwaitInLoops: One store at a time keeps the load on the billing role bounded.
          if (await record(pool, organizationId, now)) {
            recorded += 1;
            if (cause === "refund_rearm_exhausted") {
              // the pass that stopped the net could not write the incident: the alert sees it now
              logger.error("billing_refund_rearm_exhausted", {
                attempt: REFUND_REARM_MAX_ATTEMPTS,
                organizationId: opaqueId(organizationId),
                source: "sweep",
              });
            }
          }
        } catch (error: unknown) {
          failed += 1;
          logger.error("billing_refund_pending_incident_failed", {
            ...describeError(error),
            cause,
            organizationId: opaqueId(organizationId),
          });
        }
      }
      if (failed > 0) {
        // the others were recorded; the run shows itself incomplete and the next pass tries again
        throw new Error("billing_refund_pending_incident_failed");
      }
      return recorded;
    },
    async recordWelcomeNotices(now = new Date(), limit = WELCOME_NOTICE_BATCH) {
      return await inTransaction(pool, async (client) => {
        const candidates = await client.query<{
          organization_id: string;
          user_id: string;
        }>(
          "SELECT organization_id, user_id FROM public.welcome_notice_candidates($1)",
          [limit]
        );
        let recorded = 0;
        for (const candidate of candidates.rows) {
          // biome-ignore lint/performance/noAwaitInLoops: one store after the other, in one transaction
          recorded += await recordNotices(client, candidate.organization_id, [
            welcomeNotice(candidate.user_id, now),
          ]);
        }
        return { candidates: candidates.rows.length, recorded };
      });
    },
    async recordEvent(input) {
      const fact = serializeBillingFact(input.fact);
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO public.billing_events
           (provider, provider_event_id, organization_id, provider_ref, provider_subscription_id, fact, fact_type, occurred_at)
         VALUES ($1, $2, $3, $4, $8, $5::jsonb, $6, $7)
         ON CONFLICT (provider, provider_event_id) DO NOTHING
         RETURNING id`,
        [
          input.provider,
          input.providerEventId,
          input.organizationId ?? null,
          input.providerRef ?? null,
          JSON.stringify(fact),
          input.fact.type,
          input.fact.occurredAt,
          input.providerSubscriptionId ?? null,
        ]
      );
      const [created] = inserted.rows;
      if (created) {
        return { duplicate: false, id: created.id };
      }
      const existing = await pool.query<{ id: string }>(
        "SELECT id FROM public.billing_events WHERE provider = $1 AND provider_event_id = $2",
        [input.provider, input.providerEventId]
      );
      const [row] = existing.rows;
      if (!row) {
        throw new Error("billing_event_missing_after_conflict");
      }
      return { duplicate: true, id: row.id };
    },
    async retryPending(now = new Date(), limit = 50) {
      const pending = await pool.query<{ id: string }>(
        `SELECT id FROM public.billing_events
          WHERE (status = 'received' AND received_at < $1)
             OR (
               status IN ('failed', 'unresolved')
               AND attempts < $2
               AND processed_at < $4::timestamptz - (attempts * interval '15 minutes')
             )
          ORDER BY received_at, id
          LIMIT $3`,
        [
          new Date(now.getTime() - RECEIVED_RETRY_AFTER_MS),
          MAX_BILLING_EVENT_ATTEMPTS,
          limit,
          now,
        ]
      );
      const report: BillingRetryReport = {
        failed: 0,
        processed: 0,
        scanned: pending.rows.length,
        unresolved: 0,
      };
      for (const { id } of pending.rows) {
        try {
          // biome-ignore lint/performance/noAwaitInLoops: One event at a time keeps the load on the billing role bounded.
          const result = await store.processEvent(id, now);
          if (result.status === "failed") {
            report.failed += 1;
          } else if (result.status === "unresolved") {
            report.unresolved += 1;
          } else {
            report.processed += 1;
          }
        } catch (error: unknown) {
          report.failed += 1;
          logger.error("billing_event_retry_failed", {
            ...describeError(error),
            eventId: id,
          });
        }
      }
      return report;
    },
    async listReconcilableOrganizations(provider, limit, now = new Date()) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
        throw new RangeError("invalid_limit");
      }
      const hour = Math.floor(now.getTime() / 3_600_000);
      const found = await pool.query<{ organization_id: string }>(
        `SELECT organization_id FROM public.organization_billing
          WHERE provider = $1 AND provider_ref IS NOT NULL
            AND (state IN ('trial_setup', 'trialing', 'active', 'grace')
              OR updated_at > $2::timestamptz - interval '8 days')
          ORDER BY (state = 'trial_setup' OR updated_at > $2::timestamptz - interval '8 days') DESC,
                   md5(organization_id || ':' || $4::text), organization_id
          LIMIT $3`,
        [provider, now, limit, String(hour)]
      );
      return found.rows.map((row) => row.organization_id);
    },
    async listUnclaimedTrials(limit = 50) {
      const found = await pool.query<{
        id: string;
        organization_id: string;
        provider: string;
        provider_ref: string;
        provider_subscription_id: string | null;
      }>(
        `SELECT id, organization_id, provider, provider_ref, provider_subscription_id
           FROM public.billing_events
          WHERE status = 'unresolved' AND outcome_code = 'trial_claim_missing'
            AND attempts >= $1
            AND organization_id IS NOT NULL AND provider_ref IS NOT NULL
          ORDER BY received_at
          LIMIT $2`,
        [MAX_BILLING_EVENT_ATTEMPTS, limit]
      );
      return found.rows.map((row) => ({
        eventId: row.id,
        organizationId: row.organization_id,
        provider: row.provider,
        providerRef: row.provider_ref,
        providerSubscriptionId: row.provider_subscription_id,
      }));
    },
    async withOrganizationLock(organizationId, operation) {
      if (!uuidPattern.test(organizationId)) {
        throw new TypeError("invalid_organization_id");
      }
      return await inTransaction(pool, async (client) => {
        // the connection sits idle while the operation runs on others (see withPayerLock)
        const ignore = () => undefined;
        client.on("error", ignore);
        try {
          await client.query(
            "SET LOCAL idle_in_transaction_session_timeout = '60s'"
          );
          const result = await client.query<{ taken: boolean }>(
            "SELECT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended($1, 0)) AS taken",
            [`polaris.billing.organization:${organizationId.toLowerCase()}`]
          );
          if (!result.rows[0]?.taken) {
            throw new BillingCommandInProgressError();
          }
          return await operation();
        } finally {
          client.off("error", ignore);
        }
      });
    },
    async withPayerLock(key, operation) {
      if (!payerLockKeyPattern.test(key)) {
        throw new TypeError("invalid_payer_lock_key");
      }
      return await inTransaction(pool, async (client) => {
        // the connection sits idle while the operation runs on others: if the server ends it
        // (the idle timeout below, a network cut), its error event must not go unhandled
        const ignore = () => undefined;
        client.on("error", ignore);
        try {
          return await holdPayerLock(client, key, operation);
        } finally {
          client.off("error", ignore);
        }
      });
    },
    async settleUnclaimedTrial(eventId, cancel, now = new Date()) {
      if (!uuidPattern.test(eventId)) {
        return "not_pending";
      }
      return await inTransaction(pool, async (client) => {
        // the provider is called with the locks held: a provider that hangs must not
        // keep the billing connection (and this organization's webhooks) waiting
        await client.query(
          "SET LOCAL idle_in_transaction_session_timeout = '60s'"
        );
        // the event first, as `processEvent` locks it: a redelivery processed meanwhile waits here
        const found = await client.query<{
          organization_id: string | null;
          provider: string;
          provider_ref: string | null;
          provider_subscription_id: string | null;
        }>(
          `SELECT organization_id, provider, provider_ref, provider_subscription_id
             FROM public.billing_events
            WHERE id = $1 AND status = 'unresolved' AND outcome_code = 'trial_claim_missing'
              AND attempts >= $2
            FOR UPDATE`,
          [eventId, MAX_BILLING_EVENT_ATTEMPTS]
        );
        const [event] = found.rows;
        if (!(event?.organization_id && event.provider_ref)) {
          return "not_pending";
        }
        const organizationId = event.organization_id;
        const row = await lockRecord(client, organizationId);
        const before = toRecord(row);
        // a subscription that gives Pro now was paid for: cancelling it would take what the person bought
        const paid =
          grantsPro(before.state) &&
          row.provider === event.provider &&
          row.provider_ref === event.provider_ref;
        const result = paid
          ? "paid"
          : await cancel({
              eventId,
              organizationId,
              provider: event.provider,
              providerRef: event.provider_ref,
              providerSubscriptionId: event.provider_subscription_id,
            });
        const outcome = result === "paid" ? "left_paid" : "cancelled";
        const decision = `unclaimed_trial_${outcome}`;
        await client.query(
          "UPDATE public.billing_events SET status = 'ignored', processed_at = $2 WHERE id = $1",
          [eventId, now]
        );
        await writeLedger(
          client,
          {
            // the reason is in the type: the purge keeps only the keys of its list
            fact: { type: decision },
            factType: "command",
            organizationId,
            providerEventId: `command:settle_unclaimed_trial:${eventId}`,
            stateAfter: before.state,
            stateBefore: before.state,
          },
          now
        );
        return outcome;
      });
    },
    async startTrial(organizationId, userId, now = new Date()) {
      const { abandoned, record: started } = await inTransaction(
        pool,
        async (client) => {
          const row = await lockRecord(client, organizationId);
          const before = toRecord(row);
          // the state machine refuses a trial that is running, a subscriber and a second trial
          const next = applyBillingEvent(
            before,
            { type: "start_trial" },
            {
              now,
              overFreeLimits: false,
              trialConsumed: before.trialConsumed,
            }
          );
          const left = await reserveTrial(client, {
            now,
            organizationId,
            settingUp: before.state === "trial_setup",
            userId,
          });
          const record: BillingRecord = { ...before, ...next };
          await saveRecord(client, organizationId, before, record, now);
          await writeLedger(
            client,
            {
              fact: { type: "start_trial" },
              factType: "command",
              organizationId,
              providerEventId: `command:start_trial:${randomUUID()}`,
              stateAfter: record.state,
              stateBefore: before.state,
            },
            now
          );
          return { abandoned: left, record };
        }
      );
      if (abandoned && options.discardCheckout) {
        try {
          await options.discardCheckout(abandoned);
        } catch (error: unknown) {
          // the move stands: a checkout paid anyway does not start a trial (`trial_claim_missing`)
          logger.warn("billing_trial_checkout_discard_failed", {
            ...describeError(error),
            organizationId: opaqueId(abandoned.organizationId),
            provider: abandoned.provider,
          });
        }
      }
      return started;
    },
    async sweepDue(now = new Date(), limit = 50) {
      const due = await pool.query<{ organization_id: string }>(
        `SELECT organization_id FROM public.organization_billing
          WHERE state IN ('trialing', 'active', 'grace') AND access_ends_at <= $1
          ORDER BY access_ends_at, organization_id
          LIMIT $2`,
        [now, limit]
      );
      const report: BillingSweepReport = {
        failed: 0,
        scanned: due.rows.length,
        transitioned: 0,
      };
      for (const { organization_id: organizationId } of due.rows) {
        try {
          // biome-ignore lint/performance/noAwaitInLoops: One organization at a time keeps the load on the billing role bounded.
          if (await sweepOne(pool, organizationId, now)) {
            report.transitioned += 1;
          }
        } catch (error: unknown) {
          report.failed += 1;
          logger.error("billing_sweep_failed", {
            ...describeError(error),
            organizationId: opaqueId(organizationId),
          });
        }
      }
      // and what the end of a temporary grant causes (ADR 0067)
      try {
        const grants = await sweepExpiredGrants(pool, now, limit);
        report.failed += grants.failed;
        report.scanned += grants.scanned;
        report.transitioned += grants.transitioned;
      } catch (error: unknown) {
        report.failed += 1;
        logger.error("billing_grant_sweep_failed", describeError(error));
      }
      // and the trial setups whose checkout can no longer be finished (ADR 0101)
      try {
        const setups = await sweepAbandonedTrialSetups(pool, now, limit);
        report.failed += setups.failed;
        report.scanned += setups.scanned;
        report.transitioned += setups.transitioned;
      } catch (error: unknown) {
        report.failed += 1;
        logger.error("billing_trial_setup_sweep_failed", describeError(error));
      }
      return report;
    },
  };
  return store;
}
