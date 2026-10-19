import { randomUUID } from "node:crypto";
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
import { episodeStartAfter } from "@polaris/domain/billing/operational-selection";
import { applyBillingEvent } from "@polaris/domain/billing/subscription-state";
import { logger, opaqueId } from "@polaris/observability/logger";
import { describeError } from "@polaris/observability/wide-event";
import { type PoolClient, Pool } from "pg";

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
}

type BillingEventStatus = "applied" | "failed" | "ignored" | "received";

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

export interface BillingRetryReport {
  failed: number;
  processed: number;
  scanned: number;
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
  /** Links the organization's subscription at a provider (the reference webhooks name). */
  attachProvider: (
    organizationId: string,
    provider: string,
    providerRef: string
  ) => Promise<void>;
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
  readRecord: (organizationId: string) => Promise<BillingRecord | null>;
  /** Stores an event once; a redelivery returns the same ID with `duplicate: true`. */
  recordEvent: (
    input: RecordBillingEventInput
  ) => Promise<{ duplicate: boolean; id: string }>;
  /** Processes events that were received but not applied, and retries failed ones. */
  retryPending: (now?: Date, limit?: number) => Promise<BillingRetryReport>;
  /** Ends a grant now (or, if it has not started, as soon as it could); ending one twice is one ending. */
  revokeEntitlementGrant: (
    /** `organizationId`, when given, must be the grant's own: a grant of another organization is left as it is. */
    input: { actor: string; id: string; organizationId?: string },
    now?: Date
  ) => Promise<{ revoked: boolean }>;
  /** The organization opts into the trial (the renewal method comes next). */
  startTrial: (organizationId: string, now?: Date) => Promise<BillingRecord>;
  /** Applies what time itself causes to records whose access has run out. */
  sweepDue: (now?: Date, limit?: number) => Promise<BillingSweepReport>;
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
  revoked_cancel_at_period_end: boolean;
  revoked_cycle_months: number | null;
  revoked_reason: string | null;
  revoked_through: Date | null;
  state: string;
  trial_started_at: Date | null;
}

const BILLING_COLUMNS =
  "organization_id, state, access_ends_at, cancel_at_period_end, cycle_months, pending_cycle_months, last_fact_at, provider, provider_ref, trial_started_at, revoked_through, revoked_reason, revoked_cycle_months, revoked_cancel_at_period_end, over_limit_since";

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

async function saveRecord(
  client: PoolClient,
  organizationId: string,
  before: BillingRecord,
  next: BillingRecord,
  now: Date
): Promise<void> {
  // when the organization left Pro (the start of the Free Over Limit adaptation window, ADR 0064)
  const episode = episodeStartAfter({
    before,
    nextState: next.state,
    now,
  });
  await client.query(
    `UPDATE public.organization_billing SET
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
     WHERE organization_id = $1`,
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
    ]
  );
}

interface EventRow {
  attempts: number;
  fact: unknown;
  id: string;
  organization_id: string | null;
  provider: string;
  provider_ref: string | null;
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
    status: "applied" | "failed" | "ignored";
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
    "SELECT id, provider, provider_ref, organization_id, fact, status, attempts FROM public.billing_events WHERE id = $1 FOR UPDATE",
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
  await saveRecord(client, organizationId, before, result.record, now);
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
    stateAfter: BillingState;
    stateBefore: BillingState;
  },
  now: Date
): Promise<void> {
  await client.query(
    `INSERT INTO public.billing_events
       (provider, provider_event_id, organization_id, fact, fact_type, occurred_at, status, state_before, state_after, attempts, processed_at)
     VALUES ('polaris', $1, $2, $3::jsonb, $4, $5, 'applied', $6, $7, 1, $5)
     ON CONFLICT (provider, provider_event_id) DO NOTHING`,
    [
      entry.providerEventId,
      entry.organizationId,
      JSON.stringify(entry.fact),
      entry.factType,
      now,
      entry.stateBefore,
      entry.stateAfter,
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

export function createBillingStore(connectionString: string): BillingStore {
  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 5000,
    max: 3,
  });

  const store: BillingStore = {
    async attachProvider(organizationId, provider, providerRef) {
      await inTransaction(pool, async (client) => {
        const row = await lockRecord(client, organizationId);
        const sameSubscription =
          row.provider === provider && row.provider_ref === providerRef;
        if (sameSubscription) {
          return;
        }
        // a subscription that is live (a trial running, a paid period, grace) is not
        // replaced; one that is not (a checkout that was abandoned, a person who left
        // and came back) is: the new reference is the one webhooks will name
        if (row.provider !== null && grantsPro(row.state as BillingState)) {
          throw new Error("billing_provider_already_attached");
        }
        await client.query(
          // a new subscription reference is a new checkout: a payment taken back on the old one does not follow it
          `UPDATE public.organization_billing SET provider = $2, provider_ref = $3,
             revoked_through = NULL, revoked_reason = NULL, revoked_cycle_months = NULL, revoked_cancel_at_period_end = false,
             updated_at = now(), version = version + 1 WHERE organization_id = $1`,
          [organizationId, provider, providerRef]
        );
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
            "UPDATE public.billing_events SET status = 'failed', outcome_code = 'error', attempts = attempts + 1, processed_at = $2 WHERE id = $1 AND status IN ('received', 'failed')",
            [eventId, now]
          );
        }).catch(() => undefined);
        throw error;
      }
    },
    async readRecord(organizationId) {
      const result = await pool.query<BillingRow>(
        `SELECT ${BILLING_COLUMNS} FROM public.organization_billing WHERE organization_id = $1`,
        [organizationId]
      );
      const [row] = result.rows;
      return row ? toRecord(row) : null;
    },
    async recordEvent(input) {
      const fact = serializeBillingFact(input.fact);
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO public.billing_events
           (provider, provider_event_id, organization_id, provider_ref, fact, fact_type, occurred_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
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
               status = 'failed'
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
      };
      for (const { id } of pending.rows) {
        try {
          // biome-ignore lint/performance/noAwaitInLoops: One event at a time keeps the load on the billing role bounded.
          const result = await store.processEvent(id, now);
          if (result.status === "failed") {
            report.failed += 1;
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
    async startTrial(organizationId, now = new Date()) {
      return await inTransaction(pool, async (client) => {
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
        return record;
      });
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
      return report;
    },
  };
  return store;
}
