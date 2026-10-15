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
import { episodeStartAfter } from "@polaris/domain/billing/operational-selection";
import { applyBillingEvent } from "@polaris/domain/billing/subscription-state";
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

export interface BillingStore {
  /** Links the organization's subscription at a provider (the reference webhooks name). */
  attachProvider: (
    organizationId: string,
    provider: string,
    providerRef: string
  ) => Promise<void>;
  close: () => Promise<void>;
  /** Applies one stored event to its organization; safe to call again for an event already processed. */
  processEvent: (eventId: string, now?: Date) => Promise<ProcessedBillingEvent>;
  readRecord: (organizationId: string) => Promise<BillingRecord | null>;
  /** Stores an event once; a redelivery returns the same ID with `duplicate: true`. */
  recordEvent: (
    input: RecordBillingEventInput
  ) => Promise<{ duplicate: boolean; id: string }>;
  /** Processes events that were received but not applied, and retries failed ones. */
  retryPending: (now?: Date, limit?: number) => Promise<BillingRetryReport>;
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
  pending_cycle_months: number | null;
  provider: string | null;
  provider_ref: string | null;
  state: string;
  trial_started_at: Date | null;
}

const BILLING_COLUMNS =
  "organization_id, state, access_ends_at, cancel_at_period_end, cycle_months, pending_cycle_months, last_fact_at, provider, provider_ref, trial_started_at";

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
  now: Date,
  provider: { provider: string; providerRef: string } | null
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
       provider = COALESCE(provider, $10),
       provider_ref = COALESCE(provider_ref, $11),
       over_limit_since = CASE WHEN $12::boolean THEN over_limit_since ELSE $13::timestamptz END,
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
      provider?.provider ?? null,
      provider?.providerRef ?? null,
      episode === "keep",
      // a kept episode keeps whatever the record says, including nothing (never a fresh window)
      episode === "keep" ? null : episode,
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
  const organizationId = await resolveOrganization(client, event);
  if (!organizationId) {
    return await fail("unknown_organization", null);
  }

  const row = await lockRecord(client, organizationId);
  const before = toRecord(row);
  // A fact from another subscription than the one attached (an old checkout, a
  // subscription since replaced) must not change this record.
  if (
    event.provider_ref &&
    row.provider !== null &&
    (row.provider !== event.provider || row.provider_ref !== event.provider_ref)
  ) {
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
  await saveRecord(
    client,
    organizationId,
    before,
    result.record,
    now,
    event.provider_ref
      ? { provider: event.provider, providerRef: event.provider_ref }
      : null
  );
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
    await saveRecord(client, organizationId, before, due.record, now, null);
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
          "UPDATE public.organization_billing SET provider = $2, provider_ref = $3, updated_at = now(), version = version + 1 WHERE organization_id = $1",
          [organizationId, provider, providerRef]
        );
      });
    },
    async close() {
      await pool.end();
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
          console.error("billing_event_retry_failed", {
            eventId: id,
            reason: error instanceof Error ? error.message : "unknown",
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
        await saveRecord(client, organizationId, before, record, now, null);
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
          console.error("billing_sweep_failed", {
            organizationId,
            reason: error instanceof Error ? error.message : "unknown",
          });
        }
      }
      return report;
    },
  };
  return store;
}
