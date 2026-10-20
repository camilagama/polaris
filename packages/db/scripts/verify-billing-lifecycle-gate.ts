import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  BILLING_FACT_TYPES,
  type BillingFact,
} from "@polaris/domain/billing/facts";
import {
  InvalidBillingTransitionError,
  RejectedBillingEventError,
} from "@polaris/domain/billing/subscription-state";
import { Client } from "pg";
import { createBillingStore } from "../src/billing-store";
import { createDatabase } from "../src/client";
import {
  createTenantFixture,
  disposableHostPattern,
  expectSqlState,
  gateBranchPattern,
  journalMigrationCount,
  poolerPattern,
  redactedFailure,
  requiredEnvironment,
  runtimeRole,
  type TenantFixture,
  temporaryRuntimeUrl,
  withRuntimeSqlContext,
} from "./sales-gate-support";

/**
 * The billing lifecycle (plan PR79 and PR81) on a real PostgreSQL 18: a webhook
 * inbox that stores an event once, facts reconciled into the billing record
 * through the state machine (stale, repeated and out-of-order ones included),
 * cancellation and cycle changes, the sweep of expired access, the over-limit
 * check, concurrency, and the privileges of the billing role and of the tenant
 * role around all of it.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const PROVIDER_ATTACHED = /billing_provider_already_attached/;
const DAY = 86_400_000;
const base = new Date();
const at = (days: number) => new Date(base.getTime() + days * DAY);

const succeeded = (
  occurredAt: Date,
  periodEndsAt: Date,
  cycleMonths: 1 | 6 | 12 = 1
): BillingFact => ({
  cycleMonths,
  occurredAt,
  periodEndsAt,
  type: "charge_succeeded",
});

async function run() {
  const branch = requiredEnvironment("POLARIS_SALES_GATE_BRANCH");
  assert.match(branch, gateBranchPattern);
  const adminUrl = requiredEnvironment("POLARIS_SALES_GATE_DATABASE_URL");
  const parsedAdminUrl = new URL(adminUrl);
  assert.match(parsedAdminUrl.hostname, disposableHostPattern);
  assert.doesNotMatch(parsedAdminUrl.hostname, poolerPattern);

  const admin = createDatabase(adminUrl, { maxConnections: 2 });
  let runtime: ReturnType<typeof createDatabase> | undefined;
  let loginRole: string | undefined;
  let billingLoginRole: string | undefined;
  let store: ReturnType<typeof createBillingStore> | undefined;
  const tests: string[] = [];

  try {
    const server = await admin.pool.query<{
      database_name: string;
      server_version: string;
      server_version_num: string;
    }>(
      "SELECT current_database() AS database_name, current_setting('server_version') AS server_version, current_setting('server_version_num') AS server_version_num"
    );
    const [serverRow] = server.rows;
    assert.ok(serverRow);
    assert.equal(serverRow.database_name, expectedDatabase);
    assert.ok(Number(serverRow.server_version_num) >= 180_000);
    const migrations = await admin.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations"
    );
    assert.equal(Number(migrations.rows[0]?.count), journalMigrationCount());
    tests.push(
      "disposable direct Neon connection is PostgreSQL 18 with every migration replayed from scratch"
    );

    loginRole = `polaris_billing_gate_rt_${randomUUID().replaceAll("-", "")}`;
    billingLoginRole = `polaris_billing_gate_${randomUUID().replaceAll("-", "")}`;
    const loginPassword = randomBytes(24).toString("hex");
    const billingPassword = randomBytes(24).toString("hex");
    await admin.pool.query(
      `CREATE ROLE "${loginRole}" WITH LOGIN INHERIT PASSWORD '${loginPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
    );
    await admin.pool.query(`GRANT "${runtimeRole}" TO "${loginRole}"`);
    await admin.pool.query(
      `CREATE ROLE "${billingLoginRole}" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${billingPassword}'`
    );
    await admin.pool.query(
      `GRANT polaris_billing_runtime TO "${billingLoginRole}"`
    );
    const runtimeUrl = temporaryRuntimeUrl(adminUrl, loginRole, loginPassword);
    const billingUrl = temporaryRuntimeUrl(
      adminUrl,
      billingLoginRole,
      billingPassword
    );
    runtime = createDatabase(runtimeUrl, { maxConnections: 4 });
    const billing = createBillingStore(billingUrl);
    store = billing;

    const newTenant = (label: string, plan: "free" | "pro" = "free") =>
      createTenantFixture(admin.pool, label, "America/Sao_Paulo", plan);
    const event = async (
      provider: string,
      id: string,
      fact: BillingFact,
      reference: { organizationId?: string; providerRef?: string }
    ) =>
      billing.recordEvent({
        fact,
        provider,
        providerEventId: id,
        ...reference,
      });
    const apply = async (
      provider: string,
      id: string,
      fact: BillingFact,
      reference: { organizationId?: string; providerRef?: string },
      now: Date
    ) => {
      const recorded = await event(provider, id, fact, reference);
      return await billing.processEvent(recorded.id, now);
    };
    const eventRows = async (tenant: TenantFixture) =>
      (
        await admin.pool.query<{
          fact_type: string;
          outcome_code: string | null;
          state_after: string | null;
          state_before: string | null;
          status: string;
        }>(
          "SELECT fact_type, status, outcome_code, state_before, state_after FROM public.billing_events WHERE organization_id = $1 ORDER BY received_at, id",
          [tenant.organizationId]
        )
      ).rows;

    // ------------------------------------------------ 1. privileges
    const tenantA = await newTenant("lifecycle trial");
    const asBillingClient = async <T>(
      operation: (client: Client) => Promise<T>
    ): Promise<T> => {
      const client = new Client({
        connectionString: billingUrl,
        connectionTimeoutMillis: 5000,
      });
      await client.connect();
      try {
        return await operation(client);
      } finally {
        await client.end();
      }
    };
    await Promise.all([
      ...[
        "SELECT 1 FROM public.products",
        "SELECT 1 FROM public.sales",
        "SELECT 1 FROM public.goals",
        "DELETE FROM public.billing_events",
        "DELETE FROM public.organization_billing",
        "UPDATE public.organization_billing SET created_at = now()",
        "UPDATE public.billing_events SET fact = '{}'::jsonb",
        "SELECT 1 FROM public.plan_entitlements",
        "SELECT 1 FROM public.product_variants",
        "SELECT 1 FROM public.product_media",
        "SELECT 1 FROM public.organizations",
        "SELECT 1 FROM public.memberships",
        "SELECT 1 FROM public.operational_incidents",
        "INSERT INTO public.operational_incidents (kind, cause, subject) VALUES ('billing_reference_mismatch', 'reference_mismatch', 'billing.charge_failed')",
        "UPDATE public.operational_incidents SET occurrence_count = 1",
        "DELETE FROM public.operational_incidents",
      ].map((statement) =>
        expectSqlState(
          () => asBillingClient((client) => client.query(statement)),
          "42501",
          `the billing role cannot: ${statement}`
        )
      ),
      ...[
        "INSERT INTO public.billing_events (provider, provider_event_id, fact, fact_type, occurred_at) VALUES ('x', 'y', '{}'::jsonb, 'charge_failed', now())",
        "UPDATE public.billing_events SET status = 'applied'",
        "DELETE FROM public.billing_events",
        `INSERT INTO public.organization_billing (organization_id, state, access_ends_at) VALUES ('${tenantA.organizationId}', 'active', now() + interval '30 days')`,
        "UPDATE public.organization_billing SET state = 'active'",
        "SELECT public.organization_exceeds_free_limits('x')",
        "SELECT public.record_billing_reference_incident('reference_mismatch', 'charge_failed', gen_random_uuid())",
        "SELECT 1 FROM public.operational_incidents",
      ].map((statement) =>
        expectSqlState(
          () =>
            withRuntimeSqlContext(runtimeUrl, tenantA, (client) =>
              client.query(statement)
            ),
          "42501",
          `the tenant role cannot: ${statement.slice(0, 60)}`
        )
      ),
    ]);
    tests.push(
      "the billing role cannot read tenant tables, delete anything, or change columns outside the lifecycle; the tenant role cannot write billing or its inbox, nor run the over-limit check"
    );

    // ------------------------------------------ 2. one row per event
    const racing = await newTenant("lifecycle dedupe");
    const raced = await Promise.all(
      Array.from({ length: 8 }, () =>
        event(
          "fake",
          "evt-dedupe",
          { occurredAt: at(0), type: "charge_failed" },
          { organizationId: racing.organizationId }
        )
      )
    );
    assert.equal(new Set(raced.map((r) => r.id)).size, 1);
    assert.equal(raced.filter((r) => !r.duplicate).length, 1);
    const stored = await admin.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM public.billing_events WHERE provider = 'fake' AND provider_event_id = 'evt-dedupe'"
    );
    assert.equal(Number(stored.rows[0]?.count), 1);
    const [first] = raced;
    assert.ok(first);
    const processedTwice = await Promise.all([
      billing.processEvent(first.id, at(0)),
      billing.processEvent(first.id, at(0)),
    ]);
    assert.deepEqual(
      processedTwice.map((r) => r.status),
      [processedTwice[0]?.status, processedTwice[0]?.status],
      "processing the same event twice gives one outcome"
    );
    tests.push(
      "eight concurrent deliveries of one provider event store exactly one row, and processing it twice is one outcome"
    );

    // ---------------------------------- 3. the trial, end to end
    const trial = await billing.startTrial(
      tenantA.organizationId,
      tenantA.userId,
      at(0)
    );
    assert.equal(trial.state, "trial_setup");
    await billing.attachProvider(tenantA.organizationId, "fake", "sub_A");
    // while the trial is only being set up the reference can still change
    await billing.attachProvider(tenantA.organizationId, "fake", "sub_other");
    await billing.attachProvider(tenantA.organizationId, "fake", "sub_A");
    const ready = await apply(
      "fake",
      "evt-A-ready",
      { cycleMonths: 1, occurredAt: at(0), type: "trial_method_ready" },
      { providerRef: "sub_A" },
      at(0)
    );
    assert.equal(ready.status, "applied");
    assert.equal(ready.organizationId, tenantA.organizationId);
    let recordA = await billing.readRecord(tenantA.organizationId);
    assert.equal(recordA?.state, "trialing");
    assert.equal(recordA?.trialConsumed, true);
    assert.equal(recordA?.cycleMonths, 1);
    const repeated = await apply(
      "fake",
      "evt-A-ready-again",
      { cycleMonths: 1, occurredAt: at(0), type: "trial_method_ready" },
      { providerRef: "sub_A" },
      at(0)
    );
    assert.equal(repeated.status, "ignored");
    assert.equal(repeated.outcomeCode, "not_applicable");
    await assert.rejects(
      () => billing.startTrial(tenantA.organizationId, tenantA.userId, at(1)),
      (error: unknown) =>
        error instanceof InvalidBillingTransitionError ||
        error instanceof RejectedBillingEventError
    );
    const converted = await apply(
      "fake",
      "evt-A-first-charge",
      succeeded(at(7), at(37)),
      { providerRef: "sub_A" },
      at(7)
    );
    assert.equal(converted.status, "applied");
    recordA = await billing.readRecord(tenantA.organizationId);
    assert.equal(recordA?.state, "active");
    assert.equal(recordA?.accessEndsAt?.getTime(), at(37).getTime());
    const ledgerA = await eventRows(tenantA);
    assert.deepEqual(
      ledgerA.map((row) => [row.fact_type, row.status, row.state_after]),
      [
        ["command", "applied", "trial_setup"],
        ["trial_method_ready", "applied", "trialing"],
        ["trial_method_ready", "ignored", "trialing"],
        ["charge_succeeded", "applied", "active"],
      ]
    );
    tests.push(
      "a trial from opt-in to the first charge: the webhook names only the provider reference, the organization is resolved from it, a repeat is ignored, a second trial is refused, and the ledger tells each step with the state before and after"
    );

    // --------------- 4. renewal failure, grace, recovery and expiry
    const subscriber = await newTenant("lifecycle grace");
    await billing.attachProvider(subscriber.organizationId, "fake", "sub_B");
    await apply(
      "fake",
      "evt-B-1",
      succeeded(at(0), at(30)),
      { providerRef: "sub_B" },
      at(0)
    );
    const failedRenewal = await apply(
      "fake",
      "evt-B-fail",
      { occurredAt: at(30), type: "charge_failed" },
      { providerRef: "sub_B" },
      at(30)
    );
    assert.equal(failedRenewal.status, "applied");
    let recordB = await billing.readRecord(subscriber.organizationId);
    assert.equal(recordB?.state, "grace");
    assert.equal(recordB?.accessEndsAt?.getTime(), at(37).getTime());
    await apply(
      "fake",
      "evt-B-recover",
      succeeded(at(32), at(62)),
      { providerRef: "sub_B" },
      at(32)
    );
    recordB = await billing.readRecord(subscriber.organizationId);
    assert.equal(recordB?.state, "active");
    // the paid period runs out with nobody renewing or cancelling: grace, then free
    const sweepGrace = await billing.sweepDue(at(62));
    assert.ok(sweepGrace.transitioned >= 1);
    assert.equal(
      (await billing.readRecord(subscriber.organizationId))?.state,
      "grace"
    );
    const sweepFree = await billing.sweepDue(at(70));
    assert.ok(sweepFree.transitioned >= 1);
    recordB = await billing.readRecord(subscriber.organizationId);
    assert.equal(recordB?.state, "free");
    assert.equal(recordB?.accessEndsAt, null);
    assert.equal(recordB?.cycleMonths, null);
    const ledgerBefore = (await eventRows(subscriber)).length;
    await billing.sweepDue(at(70));
    assert.equal(
      (await eventRows(subscriber)).length,
      ledgerBefore,
      "running the sweep again adds nothing"
    );
    // a late confirmation after expiry revives the subscription
    const late = await apply(
      "fake",
      "evt-B-late",
      succeeded(at(71), at(101)),
      { providerRef: "sub_B" },
      at(71)
    );
    assert.equal(late.status, "applied");
    assert.equal(
      (await billing.readRecord(subscriber.organizationId))?.state,
      "active"
    );
    tests.push(
      "a failed renewal gives seven days of grace after the paid period, a payment in grace recovers, silence at the end of a period leads to grace and then free through the sweep (idempotent), and a late payment confirmation revives the record"
    );

    // ----------------------- 5. order, staleness and cancellation
    const ordered = await newTenant("lifecycle order");
    await billing.attachProvider(ordered.organizationId, "fake", "sub_C");
    await apply(
      "fake",
      "evt-C-1",
      succeeded(at(10), at(40)),
      { providerRef: "sub_C" },
      at(10)
    );
    const stale = await apply(
      "fake",
      "evt-C-stale",
      { occurredAt: at(5), type: "charge_failed" },
      { providerRef: "sub_C" },
      at(11)
    );
    assert.equal(stale.status, "ignored");
    assert.equal(stale.outcomeCode, "stale");
    assert.equal(
      (await billing.readRecord(ordered.organizationId))?.state,
      "active",
      "an older failure never rewinds a newer payment"
    );
    await apply(
      "fake",
      "evt-C-cancel",
      { occurredAt: at(12), type: "subscription_cancelled" },
      { providerRef: "sub_C" },
      at(12)
    );
    const cancelled = await billing.readRecord(ordered.organizationId);
    assert.equal(cancelled?.cancelAtPeriodEnd, true);
    assert.equal(
      cancelled?.state,
      "active",
      "access goes on to the period end"
    );
    await apply(
      "fake",
      "evt-C-cycle",
      { cycleMonths: 12, occurredAt: at(13), type: "cycle_change_scheduled" },
      { providerRef: "sub_C" },
      at(13)
    );
    assert.equal(
      (await billing.readRecord(ordered.organizationId))?.pendingCycleMonths,
      12
    );
    await billing.sweepDue(at(40));
    const ended = await billing.readRecord(ordered.organizationId);
    assert.equal(ended?.state, "free");
    assert.equal(ended?.cancelAtPeriodEnd, false);
    assert.equal(ended?.pendingCycleMonths, null);
    tests.push(
      "an older failure never rewinds a newer payment, a cancellation keeps access to the period end and ends it there, a scheduled cycle change is cleared when the subscription ends"
    );

    // ------------------------------- 6. cycle change at the renewal
    const cycling = await newTenant("lifecycle cycle");
    await billing.attachProvider(cycling.organizationId, "fake", "sub_D");
    await apply(
      "fake",
      "evt-D-1",
      succeeded(at(0), at(30)),
      { providerRef: "sub_D" },
      at(0)
    );
    await apply(
      "fake",
      "evt-D-sched",
      { cycleMonths: 6, occurredAt: at(1), type: "cycle_change_scheduled" },
      { providerRef: "sub_D" },
      at(1)
    );
    await apply(
      "fake",
      "evt-D-renew",
      succeeded(at(29), at(210), 6),
      { providerRef: "sub_D" },
      at(29)
    );
    const cycled = await billing.readRecord(cycling.organizationId);
    assert.equal(cycled?.cycleMonths, 6);
    assert.equal(cycled?.pendingCycleMonths, null);
    tests.push(
      "a scheduled cycle change takes effect with the renewal that carries it out"
    );

    // ------------------------- 7. leaving Pro over the free limits
    const heavy = await newTenant("lifecycle over limit", "pro");
    // one statement: a product is born with its default variant, in one transaction
    await admin.pool.query(
      `WITH created AS (
         INSERT INTO public.products (organization_id, name)
         SELECT $1, 'P' || g FROM generate_series(1, 51) AS g
         RETURNING id, organization_id
       )
       INSERT INTO public.product_variants (organization_id, product_id, is_default)
       SELECT organization_id, id, true FROM created`,
      [heavy.organizationId]
    );
    const light = await newTenant("lifecycle within limit", "pro");
    const exceeds = async (tenant: TenantFixture) =>
      asBillingClient(async (client) => {
        const result = await client.query<{ exceeds: boolean }>(
          "SELECT public.organization_exceeds_free_limits($1) AS exceeds",
          [tenant.organizationId]
        );
        return result.rows[0]?.exceeds;
      });
    assert.equal(
      await exceeds(heavy),
      true,
      "51 variants are over the Free 50"
    );
    assert.equal(await exceeds(light), false);
    // the Pro period of both ends and the grace after it too
    await Promise.all(
      [heavy, light].map((tenant) =>
        admin.pool.query(
          "UPDATE public.organization_billing SET access_ends_at = now() - interval '1 day' WHERE organization_id = $1",
          [tenant.organizationId]
        )
      )
    );
    await billing.sweepDue(new Date());
    await Promise.all(
      [heavy, light].map((tenant) =>
        admin.pool.query(
          "UPDATE public.organization_billing SET access_ends_at = now() - interval '1 hour' WHERE organization_id = $1 AND state = 'grace'",
          [tenant.organizationId]
        )
      )
    );
    await billing.sweepDue(new Date());
    assert.equal(
      (await billing.readRecord(heavy.organizationId))?.state,
      "free_over_limit",
      "an organization holding more than Free allows lands on free_over_limit"
    );
    assert.equal(
      (await billing.readRecord(light.organizationId))?.state,
      "free"
    );
    tests.push(
      "leaving Pro lands on free_over_limit for an organization holding more than the Free limits and on free for one within them, by the same counts the writes enforce"
    );

    // ----------------------------------------------- 8. concurrency
    const concurrent = await newTenant("lifecycle concurrent");
    await billing.attachProvider(concurrent.organizationId, "fake", "sub_E");
    await apply(
      "fake",
      "evt-E-1",
      succeeded(at(0), at(30)),
      { providerRef: "sub_E" },
      at(0)
    );
    const versionBefore = (
      await admin.pool.query<{ version: number }>(
        "SELECT version FROM public.organization_billing WHERE organization_id = $1",
        [concurrent.organizationId]
      )
    ).rows[0]?.version as number;
    await Promise.all([
      apply(
        "fake",
        "evt-E-cancel",
        { occurredAt: at(5), type: "subscription_cancelled" },
        { providerRef: "sub_E" },
        at(5)
      ),
      apply(
        "fake",
        "evt-E-cycle",
        { cycleMonths: 12, occurredAt: at(5), type: "cycle_change_scheduled" },
        { providerRef: "sub_E" },
        at(5)
      ),
    ]);
    const merged = await billing.readRecord(concurrent.organizationId);
    assert.equal(merged?.cancelAtPeriodEnd, true);
    assert.equal(merged?.pendingCycleMonths, 12);
    const versionAfter = (
      await admin.pool.query<{ version: number }>(
        "SELECT version FROM public.organization_billing WHERE organization_id = $1",
        [concurrent.organizationId]
      )
    ).rows[0]?.version as number;
    assert.equal(versionAfter, versionBefore + 2, "no update was lost");
    tests.push(
      "two facts for one organization processed at the same time both take effect: the row lock serializes them and no update is lost"
    );

    // ------------------------ 9. failures are recorded and retried
    const unknown = await billing.recordEvent({
      fact: { occurredAt: at(0), type: "charge_failed" },
      provider: "fake",
      providerEventId: "evt-unknown-org",
      providerRef: "sub_not_yet",
    });
    const unresolved = await billing.processEvent(unknown.id, at(0));
    assert.equal(unresolved.status, "failed");
    assert.equal(unresolved.outcomeCode, "unknown_organization");
    // the subscription reference arrives later: the retry pass resolves and applies it
    const late2 = await newTenant("lifecycle late mapping");
    await billing.attachProvider(late2.organizationId, "fake", "sub_not_yet");
    const retried = await billing.retryPending(at(1));
    assert.ok(retried.scanned >= 1);
    const afterRetry = await admin.pool.query<{
      organization_id: string | null;
      status: string;
    }>(
      "SELECT status, organization_id FROM public.billing_events WHERE id = $1",
      [unknown.id]
    );
    assert.equal(afterRetry.rows[0]?.organization_id, late2.organizationId);
    assert.equal(
      afterRetry.rows[0]?.status,
      "ignored",
      "a failure on a free organization is not applicable, and is recorded as such"
    );
    // a malformed stored fact fails with an error code and stops being retried after the attempts
    const malformed = await admin.pool.query<{ id: string }>(
      `INSERT INTO public.billing_events (provider, provider_event_id, organization_id, fact, fact_type, occurred_at)
       VALUES ('fake', 'evt-malformed', $1, '{"type":"payment_received"}'::jsonb, 'charge_failed', now())
       RETURNING id`,
      [late2.organizationId]
    );
    const malformedId = malformed.rows[0]?.id as string;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: The attempts are sequential on purpose.
      await billing.retryPending(at(1 + attempt));
    }
    const exhausted = await admin.pool.query<{
      attempts: number;
      outcome_code: string;
      status: string;
    }>(
      "SELECT status, outcome_code, attempts FROM public.billing_events WHERE id = $1",
      [malformedId]
    );
    assert.deepEqual(
      [
        exhausted.rows[0]?.status,
        exhausted.rows[0]?.outcome_code,
        exhausted.rows[0]?.attempts,
      ],
      ["failed", "error", 5],
      "a malformed event fails with an error code and is retried at most five times"
    );
    tests.push(
      "an event whose organization is unknown yet fails and is resolved and applied by the retry pass once the reference is attached; a malformed event is recorded as an error and retried at most five times"
    );

    // -------------------------------- 10. what the review found
    // a payment delayed behind a later cancellation still extends the access
    const reordered = await newTenant("lifecycle reorder");
    await billing.attachProvider(reordered.organizationId, "fake", "sub_H");
    await apply(
      "fake",
      "evt-H-1",
      succeeded(at(0), at(30)),
      { providerRef: "sub_H" },
      at(0)
    );
    await apply(
      "fake",
      "evt-H-cancel",
      { occurredAt: at(20), type: "subscription_cancelled" },
      { providerRef: "sub_H" },
      at(20)
    );
    const delayed = await apply(
      "fake",
      "evt-H-delayed-payment",
      succeeded(at(19), at(60)),
      { providerRef: "sub_H" },
      at(21)
    );
    assert.equal(
      delayed.status,
      "applied",
      "a paid charge is never dropped as stale"
    );
    const afterDelayed = await billing.readRecord(reordered.organizationId);
    assert.equal(afterDelayed?.accessEndsAt?.getTime(), at(60).getTime());
    assert.equal(
      afterDelayed?.cancelAtPeriodEnd,
      true,
      "and the cancellation that came after it is not undone"
    );

    // a subscription at the provider can be replaced when none is live, never while one is
    const restarting = await newTenant("lifecycle restart");
    await billing.startTrial(
      restarting.organizationId,
      restarting.userId,
      at(0)
    );
    await billing.attachProvider(restarting.organizationId, "fake", "sub_old");
    await billing.attachProvider(restarting.organizationId, "fake", "sub_new");
    const secondStart = await billing.startTrial(
      restarting.organizationId,
      restarting.userId,
      at(1)
    );
    assert.equal(
      secondStart.state,
      "trial_setup",
      "a trial being set up can be started again"
    );
    await assert.rejects(
      () =>
        billing.attachProvider(reordered.organizationId, "fake", "sub_other"),
      PROVIDER_ATTACHED
    );
    // a fact from another subscription than the attached one changes nothing
    const wrongReference = await apply(
      "fake",
      "evt-H-wrong-ref",
      { occurredAt: at(22), type: "charge_failed" },
      { organizationId: reordered.organizationId, providerRef: "sub_wrong" },
      at(22)
    );
    assert.equal(wrongReference.status, "ignored");
    assert.equal(wrongReference.outcomeCode, "reference_mismatch");
    assert.equal(
      (await billing.readRecord(reordered.organizationId))?.state,
      "active"
    );
    // the old subscription's events no longer find an organization
    const oldReference = await apply(
      "fake",
      "evt-old-sub",
      { occurredAt: at(2), type: "charge_failed" },
      { providerRef: "sub_old" },
      at(2)
    );
    assert.equal(oldReference.outcomeCode, "unknown_organization");

    // a fact dated in the future never makes later facts stale
    const skew = await newTenant("lifecycle skew");
    await billing.attachProvider(skew.organizationId, "fake", "sub_S");
    await apply(
      "fake",
      "evt-S-1",
      succeeded(at(0), at(30)),
      { providerRef: "sub_S" },
      at(0)
    );
    await apply(
      "fake",
      "evt-S-future",
      { occurredAt: at(50), type: "subscription_cancelled" },
      { providerRef: "sub_S" },
      at(1)
    );
    const clock = (
      await admin.pool.query<{ last_fact_at: Date }>(
        "SELECT last_fact_at FROM public.organization_billing WHERE organization_id = $1",
        [skew.organizationId]
      )
    ).rows[0]?.last_fact_at as Date;
    assert.ok(
      clock.getTime() <= at(1).getTime(),
      "the clock of facts stops at the present"
    );
    const afterSkew = await apply(
      "fake",
      "evt-S-after",
      { cycleMonths: 6, occurredAt: at(2), type: "cycle_change_scheduled" },
      { providerRef: "sub_S" },
      at(2)
    );
    assert.equal(afterSkew.status, "applied");

    // a late sweep gives the same grace as an on-time one, counted from the end of the period
    const lateSweep = await newTenant("lifecycle late sweep");
    await billing.attachProvider(lateSweep.organizationId, "fake", "sub_L");
    await apply(
      "fake",
      "evt-L-1",
      succeeded(at(0), at(30)),
      { providerRef: "sub_L" },
      at(0)
    );
    await billing.sweepDue(at(33));
    const lateGrace = await billing.readRecord(lateSweep.organizationId);
    assert.equal(lateGrace?.state, "grace");
    assert.equal(lateGrace?.accessEndsAt?.getTime(), at(37).getTime());

    // retries wait longer after each failure
    const waiting = await billing.recordEvent({
      fact: { occurredAt: at(0), type: "charge_failed" },
      provider: "fake",
      providerEventId: "evt-backoff",
      providerRef: "sub_never_attached",
    });
    await billing.processEvent(waiting.id, at(0));
    const attemptsOf = async () =>
      (
        await admin.pool.query<{ attempts: number }>(
          "SELECT attempts FROM public.billing_events WHERE id = $1",
          [waiting.id]
        )
      ).rows[0]?.attempts;
    assert.equal(await attemptsOf(), 1);
    await billing.retryPending(new Date(at(0).getTime() + 10 * 60_000));
    assert.equal(
      await attemptsOf(),
      1,
      "ten minutes later it is not tried again"
    );
    await billing.retryPending(new Date(at(0).getTime() + 20 * 60_000));
    assert.equal(await attemptsOf(), 2, "after the wait it is");

    // the reference a provider reports has a bounded size
    await expectSqlState(
      () =>
        admin.pool.query(
          `INSERT INTO public.billing_events (provider, provider_event_id, provider_ref, fact, fact_type, occurred_at)
           VALUES ('fake', 'evt-long-ref', $1, '{}'::jsonb, 'charge_failed', now())`,
          ["x".repeat(129)]
        ),
      "23514",
      "a provider reference longer than 128 characters",
      "billing_events_provider_ref_length"
    );
    tests.push(
      "a payment delayed behind a later cancellation extends the access without undoing it, a new subscription replaces one that is not live (never a live one), a fact from another subscription changes nothing, a future-dated fact does not make later ones stale, a late sweep gives the same grace, and retries wait longer after each failure"
    );

    // ------------------------- 12. refunds and chargebacks (PR84)
    const taken = (
      type: "charge_disputed" | "charge_refunded" | "dispute_reversed",
      occurredAt: Date,
      periodEndsAt: Date
    ): BillingFact => ({ occurredAt, periodEndsAt, type });
    const subscribed = async (
      label: string,
      ref: string,
      charge: BillingFact
    ) => {
      const tenant = await newTenant(label);
      await billing.attachProvider(tenant.organizationId, "fake", ref);
      await apply("fake", `evt-${ref}-1`, charge, { providerRef: ref }, at(0));
      return tenant;
    };

    // a full refund of the current period takes the access back at once
    const refundTenant = await subscribed(
      "lifecycle refund",
      "sub_R1",
      succeeded(at(0), at(30), 6)
    );
    const refund = await apply(
      "fake",
      "evt-R1-refund",
      taken("charge_refunded", at(2), at(30)),
      { providerRef: "sub_R1" },
      at(2)
    );
    assert.equal(refund.status, "applied");
    let refundRecord = await billing.readRecord(refundTenant.organizationId);
    assert.equal(refundRecord?.state, "free");
    assert.equal(refundRecord?.accessEndsAt, null);
    assert.equal(refundRecord?.revoked?.reason, "refund");
    assert.equal(refundRecord?.revoked?.cycleMonths, 6);
    assert.equal(
      refundRecord?.revoked?.periodEndsAt.getTime(),
      at(30).getTime()
    );
    assert.deepEqual(
      (await eventRows(refundTenant)).map((row) => [
        row.fact_type,
        row.status,
        row.state_after,
      ]),
      [
        ["charge_succeeded", "applied", "active"],
        ["charge_refunded", "applied", "free"],
      ]
    );
    // a redelivery is one row and one effect
    const refundAgain = await event(
      "fake",
      "evt-R1-refund",
      taken("charge_refunded", at(2), at(30)),
      { providerRef: "sub_R1" }
    );
    assert.equal(refundAgain.duplicate, true);
    // a second refund event for a record that has no paid period is not applicable
    const refundRepeat = await apply(
      "fake",
      "evt-R1-refund-2",
      taken("charge_refunded", at(3), at(30)),
      { providerRef: "sub_R1" },
      at(3)
    );
    assert.equal(refundRepeat.outcomeCode, "not_applicable");
    // the refunded payment's own late confirmation never brings the access back
    const lateConfirmation = await apply(
      "fake",
      "evt-R1-late",
      succeeded(at(0), at(30), 6),
      { providerRef: "sub_R1" },
      at(4)
    );
    assert.equal(lateConfirmation.status, "ignored");
    assert.equal(
      (await billing.readRecord(refundTenant.organizationId))?.state,
      "free"
    );
    // a later payment is a new period: access returns and what was taken back is forgotten
    const payAgain = await apply(
      "fake",
      "evt-R1-again",
      succeeded(at(5), at(35)),
      { providerRef: "sub_R1" },
      at(5)
    );
    assert.equal(payAgain.status, "applied");
    refundRecord = await billing.readRecord(refundTenant.organizationId);
    assert.equal(refundRecord?.state, "active");
    assert.equal(refundRecord?.revoked, null);
    tests.push(
      "a full refund of the current period ends the paid access at once and is remembered, a redelivery is one effect, a repeat is not applicable, the refunded payment's own late confirmation never revives the access, and a later payment does and forgets it"
    );

    // a refund, a chargeback or a reversal must name the attached subscription
    const referenced = await subscribed(
      "lifecycle reference",
      "sub_REF1",
      succeeded(at(0), at(30), 6)
    );
    const other = await subscribed(
      "lifecycle reference other",
      "sub_REF2",
      succeeded(at(0), at(30), 6)
    );
    const unattached = await newTenant("lifecycle reference unattached");
    for (const type of [
      "charge_refunded",
      "charge_disputed",
      "dispute_reversed",
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: Facts, in order, on one record.
      const withoutReference = await apply(
        "fake",
        `evt-REF1-${type}-none`,
        taken(type, at(2), at(30)),
        { organizationId: referenced.organizationId },
        at(2)
      );
      assert.equal(withoutReference.status, "ignored", type);
      assert.equal(withoutReference.outcomeCode, "reference_mismatch", type);
      const otherReference = await apply(
        "fake",
        `evt-REF1-${type}-other`,
        taken(type, at(2), at(30)),
        { organizationId: referenced.organizationId, providerRef: "sub_REF2" },
        at(2)
      );
      assert.equal(otherReference.status, "ignored", type);
      assert.equal(otherReference.outcomeCode, "reference_mismatch", type);
      const noSubscription = await apply(
        "fake",
        `evt-REF1-${type}-unattached`,
        taken(type, at(2), at(30)),
        { organizationId: unattached.organizationId, providerRef: "sub_REF1" },
        at(2)
      );
      assert.equal(noSubscription.status, "ignored", type);
      assert.equal(noSubscription.outcomeCode, "reference_mismatch", type);
    }
    for (const tenant of [referenced, other]) {
      // biome-ignore lint/performance/noAwaitInLoops: Two reads, in order.
      const untouched = await billing.readRecord(tenant.organizationId);
      assert.equal(untouched?.state, "active");
      assert.equal(untouched?.revoked, null);
    }
    const unattachedRecord = await billing.readRecord(
      unattached.organizationId
    );
    assert.equal(unattachedRecord?.revoked ?? null, null);
    assert.equal(unattachedRecord?.state ?? "free", "free");
    // the matching reference still takes the access back
    const matching = await apply(
      "fake",
      "evt-REF1-refund-ok",
      taken("charge_refunded", at(3), at(30)),
      { organizationId: referenced.organizationId, providerRef: "sub_REF1" },
      at(3)
    );
    assert.equal(matching.status, "applied");
    assert.equal(
      (await billing.readRecord(referenced.organizationId))?.state,
      "free"
    );
    assert.equal(
      (await billing.readRecord(other.organizationId))?.state,
      "active"
    );
    tests.push(
      "a refund, a chargeback or a reversal without a subscription reference, with another subscription's reference, or for a record with no subscription attached (the reference being another organization's) changes nothing, and the matching reference still applies"
    );

    // an earlier period's refund changes nothing; money facts are never stale
    const renewal = await subscribed(
      "lifecycle refund old",
      "sub_R2",
      succeeded(at(0), at(30))
    );
    await apply(
      "fake",
      "evt-R2-renew",
      succeeded(at(30), at(60)),
      { providerRef: "sub_R2" },
      at(30)
    );
    const oldRefund = await apply(
      "fake",
      "evt-R2-old",
      taken("charge_refunded", at(31), at(30)),
      { providerRef: "sub_R2" },
      at(31)
    );
    assert.equal(oldRefund.outcomeCode, "not_applicable");
    assert.equal(
      (await billing.readRecord(renewal.organizationId))?.state,
      "active"
    );
    const behind = await subscribed(
      "lifecycle refund stale",
      "sub_R3",
      succeeded(at(0), at(30))
    );
    await apply(
      "fake",
      "evt-R3-cancel",
      { occurredAt: at(10), type: "subscription_cancelled" },
      { providerRef: "sub_R3" },
      at(10)
    );
    const delayedRefund = await apply(
      "fake",
      "evt-R3-refund",
      taken("charge_refunded", at(5), at(30)),
      { providerRef: "sub_R3" },
      at(12)
    );
    assert.equal(
      delayedRefund.status,
      "applied",
      "a refund that arrives late still counts"
    );
    assert.equal(
      (await billing.readRecord(behind.organizationId))?.state,
      "free"
    );
    tests.push(
      "a refund of an earlier period than the one in force changes nothing, and a refund delivered behind a newer fact still takes the access back"
    );

    // a chargeback is immediate (in grace too) and a reversal restores it
    const chargeback = await subscribed(
      "lifecycle chargeback",
      "sub_C1",
      succeeded(at(0), at(30), 6)
    );
    await apply(
      "fake",
      "evt-C1-dispute",
      taken("charge_disputed", at(2), at(30)),
      { providerRef: "sub_C1" },
      at(2)
    );
    let chargebackRecord = await billing.readRecord(chargeback.organizationId);
    assert.equal(chargebackRecord?.state, "free");
    assert.equal(chargebackRecord?.revoked?.reason, "chargeback");
    const reversal = await apply(
      "fake",
      "evt-C1-won",
      taken("dispute_reversed", at(4), at(30)),
      { providerRef: "sub_C1" },
      at(4)
    );
    assert.equal(reversal.status, "applied");
    chargebackRecord = await billing.readRecord(chargeback.organizationId);
    assert.equal(chargebackRecord?.state, "active");
    assert.equal(chargebackRecord?.accessEndsAt?.getTime(), at(30).getTime());
    assert.equal(chargebackRecord?.cycleMonths, 6, "the cycle it had");
    assert.equal(chargebackRecord?.revoked, null);
    assert.deepEqual(
      (await eventRows(chargeback)).map((row) => [
        row.fact_type,
        row.state_after,
      ]),
      [
        ["charge_succeeded", "active"],
        ["charge_disputed", "free"],
        ["dispute_reversed", "active"],
      ]
    );
    // time then runs as it does for any subscription: unpaid at the end, it goes into grace
    const sweptAgain = await billing.sweepDue(at(31));
    assert.ok(sweptAgain.transitioned >= 1);
    assert.equal(
      (await billing.readRecord(chargeback.organizationId))?.state,
      "grace"
    );

    const graceDispute = await subscribed(
      "lifecycle chargeback grace",
      "sub_C2",
      succeeded(at(0), at(30))
    );
    await apply(
      "fake",
      "evt-C2-fail",
      { occurredAt: at(30), type: "charge_failed" },
      { providerRef: "sub_C2" },
      at(30)
    );
    assert.equal(
      (await billing.readRecord(graceDispute.organizationId))?.state,
      "grace"
    );
    await apply(
      "fake",
      "evt-C2-dispute",
      taken("charge_disputed", at(31), at(30)),
      { providerRef: "sub_C2" },
      at(31)
    );
    assert.equal(
      (await billing.readRecord(graceDispute.organizationId))?.state,
      "free",
      "no grace after a chargeback"
    );
    // won after the period is over: nothing to restore, the chargeback is only forgotten
    const lateWin = await apply(
      "fake",
      "evt-C2-won",
      taken("dispute_reversed", at(40), at(30)),
      { providerRef: "sub_C2" },
      at(40)
    );
    assert.equal(lateWin.status, "applied");
    const lateWinRecord = await billing.readRecord(graceDispute.organizationId);
    assert.equal(lateWinRecord?.state, "free");
    assert.equal(lateWinRecord?.revoked, null);
    // a reversal that has no chargeback on record is not applicable
    const orphan = await apply(
      "fake",
      "evt-C2-orphan",
      taken("dispute_reversed", at(41), at(30)),
      { providerRef: "sub_C2" },
      at(41)
    );
    assert.equal(orphan.outcomeCode, "not_applicable");
    tests.push(
      "a chargeback ends the access at once, in grace too, a reversal restores it with its end and cycle (and time then runs as usual), one decided after the period is over only forgets it, and a reversal with no chargeback on record is not applicable"
    );

    // out of order and awkward deliveries
    const attachedFree = async (label: string, ref: string) => {
      const tenant = await newTenant(label);
      await billing.attachProvider(tenant.organizationId, "fake", ref);
      return tenant;
    };
    // a refund that arrives before its charge is confirmed is remembered
    const early = await attachedFree("lifecycle early refund", "sub_E1");
    const earlyRefund = await apply(
      "fake",
      "evt-E1-refund",
      taken("charge_refunded", at(1), at(30)),
      { providerRef: "sub_E1" },
      at(1)
    );
    assert.equal(earlyRefund.status, "applied");
    const earlyRecord = await billing.readRecord(early.organizationId);
    assert.equal(earlyRecord?.state, "free");
    assert.equal(earlyRecord?.revoked?.reason, "refund");
    const earlyCharge = await apply(
      "fake",
      "evt-E1-charge",
      succeeded(at(0), at(30)),
      { providerRef: "sub_E1" },
      at(2)
    );
    assert.equal(earlyCharge.status, "ignored");
    assert.equal(
      (await billing.readRecord(early.organizationId))?.state,
      "free"
    );

    // the same on a trial: the trial runs, and the first charge cannot convert it
    // (the person opts in first: a trial without a reservation does not start)
    const trialRefund = await newTenant("lifecycle trial refund");
    await billing.startTrial(
      trialRefund.organizationId,
      trialRefund.userId,
      at(0)
    );
    await billing.attachProvider(trialRefund.organizationId, "fake", "sub_E2");
    await apply(
      "fake",
      "evt-E2-ready",
      { cycleMonths: 1, occurredAt: at(0), type: "trial_method_ready" },
      { providerRef: "sub_E2" },
      at(0)
    );
    await apply(
      "fake",
      "evt-E2-refund",
      taken("charge_refunded", at(2), at(30)),
      { providerRef: "sub_E2" },
      at(2)
    );
    const trialRecord = await billing.readRecord(trialRefund.organizationId);
    assert.equal(trialRecord?.state, "trialing");
    assert.equal(trialRecord?.revoked?.reason, "refund");
    const trialCharge = await apply(
      "fake",
      "evt-E2-charge",
      succeeded(at(7), at(30)),
      { providerRef: "sub_E2" },
      at(7)
    );
    assert.equal(trialCharge.status, "ignored");
    assert.equal(
      (await billing.readRecord(trialRefund.organizationId))?.state,
      "trialing"
    );
    const converts = await apply(
      "fake",
      "evt-E2-charge-2",
      succeeded(at(8), at(60)),
      { providerRef: "sub_E2" },
      at(8)
    );
    assert.equal(converts.status, "applied");
    const converted2 = await billing.readRecord(trialRefund.organizationId);
    assert.equal(converted2?.state, "active");
    assert.equal(converted2?.revoked, null);

    // a reversal that overtakes its chargeback: the chargeback then changes nothing
    const won = await attachedFree("lifecycle won first", "sub_E3");
    await apply(
      "fake",
      "evt-E3-won",
      taken("dispute_reversed", at(1), at(30)),
      { providerRef: "sub_E3" },
      at(1)
    );
    assert.equal(
      (await billing.readRecord(won.organizationId))?.revoked?.reason,
      "won"
    );
    const lateDispute = await apply(
      "fake",
      "evt-E3-dispute",
      taken("charge_disputed", at(0), at(30)),
      { providerRef: "sub_E3" },
      at(2)
    );
    assert.equal(lateDispute.status, "ignored");
    // a payment for that period is still welcome
    await apply(
      "fake",
      "evt-E3-charge",
      succeeded(at(2), at(30)),
      { providerRef: "sub_E3" },
      at(2)
    );
    const wonRecord = await billing.readRecord(won.organizationId);
    assert.equal(wonRecord?.state, "active");
    // a win is kept: it only ever blocks a chargeback for that exact period
    assert.equal(wonRecord?.revoked?.reason, "won");

    // a refund after a chargeback: the reversal then restores nothing
    const both = await subscribed(
      "lifecycle both",
      "sub_E4",
      succeeded(at(0), at(30))
    );
    await apply(
      "fake",
      "evt-E4-dispute",
      taken("charge_disputed", at(1), at(30)),
      { providerRef: "sub_E4" },
      at(1)
    );
    await apply(
      "fake",
      "evt-E4-refund",
      taken("charge_refunded", at(2), at(30)),
      { providerRef: "sub_E4" },
      at(2)
    );
    assert.equal(
      (await billing.readRecord(both.organizationId))?.revoked?.reason,
      "refund"
    );
    const noRestore = await apply(
      "fake",
      "evt-E4-won",
      taken("dispute_reversed", at(5), at(30)),
      { providerRef: "sub_E4" },
      at(5)
    );
    assert.equal(noRestore.outcomeCode, "not_applicable");
    assert.equal(
      (await billing.readRecord(both.organizationId))?.state,
      "free"
    );

    // a new checkout does not inherit a payment taken back on the old subscription
    const recheckout = await subscribed(
      "lifecycle recheckout",
      "sub_E5",
      succeeded(at(0), at(300), 12)
    );
    await apply(
      "fake",
      "evt-E5-refund",
      taken("charge_refunded", at(1), at(300)),
      { providerRef: "sub_E5" },
      at(1)
    );
    assert.equal(
      (await billing.readRecord(recheckout.organizationId))?.revoked?.reason,
      "refund"
    );
    await billing.attachProvider(recheckout.organizationId, "fake", "sub_E5b");
    assert.equal(
      (await billing.readRecord(recheckout.organizationId))?.revoked,
      null,
      "a new subscription reference starts clean"
    );
    const monthly = await apply(
      "fake",
      "evt-E5b-charge",
      succeeded(at(2), at(32)),
      { providerRef: "sub_E5b" },
      at(2)
    );
    assert.equal(
      monthly.status,
      "applied",
      "the monthly payment grants access"
    );
    // a reversal that overtakes its chargeback on an ACTIVE subscription
    const activeWon = await subscribed(
      "lifecycle won on active",
      "sub_W1",
      succeeded(at(0), at(30), 6)
    );
    const wonFirst = await apply(
      "fake",
      "evt-W1-won",
      taken("dispute_reversed", at(1), at(30)),
      { providerRef: "sub_W1" },
      at(1)
    );
    assert.equal(wonFirst.status, "applied");
    const wonActive = await billing.readRecord(activeWon.organizationId);
    assert.equal(wonActive?.state, "active", "the access is untouched");
    assert.equal(wonActive?.revoked?.reason, "won");
    const disputeAfterWin = await apply(
      "fake",
      "evt-W1-dispute",
      taken("charge_disputed", at(0), at(30)),
      { providerRef: "sub_W1" },
      at(2)
    );
    assert.equal(disputeAfterWin.status, "ignored");
    assert.equal(
      (await billing.readRecord(activeWon.organizationId))?.state,
      "active",
      "the chargeback that arrives after its own reversal changes nothing"
    );

    // a chargeback before its charge was known: the cycle is learned from the refused confirmation
    const unknownCycle = await attachedFree(
      "lifecycle cycle learned",
      "sub_W2"
    );
    await apply(
      "fake",
      "evt-W2-dispute",
      taken("charge_disputed", at(1), at(30)),
      { providerRef: "sub_W2" },
      at(1)
    );
    assert.equal(
      (await billing.readRecord(unknownCycle.organizationId))?.revoked
        ?.cycleMonths,
      null
    );
    await apply(
      "fake",
      "evt-W2-charge",
      succeeded(at(0), at(30), 6),
      { providerRef: "sub_W2" },
      at(2)
    );
    const learned = await billing.readRecord(unknownCycle.organizationId);
    assert.equal(learned?.state, "free", "the confirmation does not grant it");
    assert.equal(learned?.revoked?.cycleMonths, 6, "but it tells the cycle");
    await apply(
      "fake",
      "evt-W2-won",
      taken("dispute_reversed", at(3), at(30)),
      { providerRef: "sub_W2" },
      at(3)
    );
    const restoredCycle = await billing.readRecord(unknownCycle.organizationId);
    assert.equal(restoredCycle?.state, "active");
    assert.equal(
      restoredCycle?.cycleMonths,
      6,
      "restored with the cycle it was paid for"
    );
    assert.equal(restoredCycle?.accessEndsAt?.getTime(), at(30).getTime());

    // the database refuses what the domain never produces: a refund or chargeback remembered on a paid period
    await expectSqlState(
      () =>
        admin.pool.query(
          "UPDATE public.organization_billing SET revoked_through = now() + interval '5 days', revoked_reason = 'refund' WHERE organization_id = $1",
          [activeWon.organizationId]
        ),
      "23514",
      "a refund cannot be remembered on an active subscription",
      "organization_billing_revoked_coherent"
    );
    await expectSqlState(
      () =>
        admin.pool.query(
          "UPDATE public.organization_billing SET revoked_reason = 'chargeback' WHERE organization_id = $1",
          [activeWon.organizationId]
        ),
      "23514",
      "a won chargeback cannot be turned into a chargeback while the subscription is active",
      "organization_billing_revoked_coherent"
    );
    // a won chargeback carries no cycle and no cancellation, whoever writes it
    for (const change of [
      "revoked_cycle_months = 6",
      "revoked_cancel_at_period_end = true",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: Two probes, in order.
      await expectSqlState(
        () =>
          admin.pool.query(
            `UPDATE public.organization_billing SET ${change} WHERE organization_id = $1`,
            [activeWon.organizationId]
          ),
        "23514",
        `a won chargeback cannot carry: ${change}`,
        "organization_billing_revoked_coherent"
      );
    }
    // but a won chargeback may live there (the state it was remembered in above)
    assert.equal(
      (await billing.readRecord(activeWon.organizationId))?.revoked?.reason,
      "won"
    );

    tests.push(
      "a refund that arrives before its charge is confirmed is remembered (on a free record and on a running trial), so the confirmation cannot grant it while a payment for a later period does; a reversal that overtakes its chargeback makes the chargeback change nothing; a refund after a chargeback means the reversal restores nothing; and a new checkout does not inherit a payment taken back on the old subscription"
    );

    // ------------- 13. every fact names the attached subscription (POL-21)
    const incidentCount = async (
      cause: "reference_mismatch" | "reference_unresolved",
      type: string
    ) =>
      Number(
        (
          await admin.pool.query<{ total: string }>(
            "SELECT coalesce(sum(occurrence_count), 0)::text AS total FROM public.operational_incidents WHERE kind = 'billing_reference_mismatch' AND cause = $1 AND subject = $2",
            [cause, `billing.${type}`]
          )
        ).rows[0]?.total
      );
    const mismatchCount = (type: string) =>
      incidentCount("reference_mismatch", type);
    const rowOf = async (tenant: TenantFixture) =>
      (
        await admin.pool.query<{
          provider: string | null;
          provider_ref: string | null;
          version: number;
        }>(
          "SELECT provider, provider_ref, version FROM public.organization_billing WHERE organization_id = $1",
          [tenant.organizationId]
        )
      ).rows[0];
    const paid = async (label: string, ref: string) => {
      const tenant = await newTenant(label);
      await billing.attachProvider(tenant.organizationId, "fake", ref);
      await apply(
        "fake",
        `evt-${ref}-seed`,
        succeeded(at(0), at(30)),
        { providerRef: ref },
        at(0)
      );
      return tenant;
    };
    const everyFact: {
      expected: (
        record: Awaited<ReturnType<typeof billing.readRecord>>
      ) => void;
      fact: BillingFact;
      prepare: (label: string, ref: string) => Promise<TenantFixture>;
    }[] = [
      {
        expected: (record) => assert.equal(record?.state, "trialing"),
        fact: { cycleMonths: 1, occurredAt: at(1), type: "trial_method_ready" },
        prepare: async (label, ref) => {
          const tenant = await newTenant(label);
          await billing.startTrial(tenant.organizationId, tenant.userId, at(0));
          await billing.attachProvider(tenant.organizationId, "fake", ref);
          return tenant;
        },
      },
      {
        expected: (record) => {
          assert.equal(record?.state, "active");
          assert.equal(record?.accessEndsAt?.getTime(), at(31).getTime());
        },
        fact: succeeded(at(1), at(31)),
        prepare: async (label, ref) => {
          const tenant = await newTenant(label);
          await billing.attachProvider(tenant.organizationId, "fake", ref);
          return tenant;
        },
      },
      {
        expected: (record) => assert.equal(record?.state, "grace"),
        fact: { occurredAt: at(2), type: "charge_failed" },
        prepare: paid,
      },
      {
        expected: (record) => assert.equal(record?.cancelAtPeriodEnd, true),
        fact: { occurredAt: at(2), type: "subscription_cancelled" },
        prepare: paid,
      },
      {
        expected: (record) => assert.equal(record?.pendingCycleMonths, 6),
        fact: {
          cycleMonths: 6,
          occurredAt: at(2),
          type: "cycle_change_scheduled",
        },
        prepare: paid,
      },
      {
        expected: (record) => assert.equal(record?.state, "free"),
        fact: taken("charge_refunded", at(2), at(30)),
        prepare: paid,
      },
      {
        expected: (record) => assert.equal(record?.state, "free"),
        fact: taken("charge_disputed", at(2), at(30)),
        prepare: paid,
      },
      {
        expected: (record) => assert.equal(record?.state, "active"),
        fact: taken("dispute_reversed", at(3), at(30)),
        prepare: async (label, ref) => {
          const tenant = await paid(label, ref);
          await apply(
            "fake",
            `evt-${ref}-dispute`,
            taken("charge_disputed", at(2), at(30)),
            { providerRef: ref },
            at(2)
          );
          return tenant;
        },
      },
    ];
    for (const [index, scenario] of everyFact.entries()) {
      const { type } = scenario.fact;
      const ref = `sub_FACT${index}`;
      // biome-ignore lint/performance/noAwaitInLoops: One fact type at a time, on its own record.
      const tenant = await scenario.prepare(`lifecycle fact ${type}`, ref);
      const untouched = await rowOf(tenant);
      const incidentsBefore = await mismatchCount(type);
      const stateBefore = await billing.readRecord(tenant.organizationId);
      let n = 0;
      for (const [label, reference, provider] of [
        ["no reference", {}, "fake"],
        ["another subscription", { providerRef: `${ref}_other` }, "fake"],
        ["another provider", { providerRef: ref }, "other_provider"],
      ] as const) {
        n += 1;
        // biome-ignore lint/performance/noAwaitInLoops: Three probes, in order, on one record.
        const outcome = await apply(
          provider,
          `evt-${ref}-bad-${n}`,
          scenario.fact,
          { organizationId: tenant.organizationId, ...reference },
          at(5)
        );
        assert.equal(outcome.status, "ignored", `${type}: ${label}`);
        assert.equal(
          outcome.outcomeCode,
          "reference_mismatch",
          `${type}: ${label}`
        );
      }
      assert.deepEqual(
        await rowOf(tenant),
        untouched,
        `${type}: the record is untouched by a fact of another subscription`
      );
      assert.deepEqual(
        await billing.readRecord(tenant.organizationId),
        stateBefore
      );
      assert.equal(
        await mismatchCount(type),
        incidentsBefore + 3,
        `${type}: each mismatch is counted as an operational incident`
      );
      // a record with no subscription attached yet is not a mismatch: the fact waits for the link
      const unlinked = await newTenant(`lifecycle fact early ${type}`);
      const beforeTheLink = await apply(
        "fake",
        `evt-${ref}-early`,
        scenario.fact,
        {
          organizationId: unlinked.organizationId,
          providerRef: `${ref}_not_linked`,
        },
        at(5)
      );
      assert.equal(beforeTheLink.status, "failed", `${type}: before the link`);
      assert.equal(beforeTheLink.outcomeCode, "unknown_organization", type);
      assert.equal((await rowOf(unlinked))?.provider, null);
      assert.equal(await mismatchCount(type), incidentsBefore + 3);
      // the matching reference applies
      const valid = await apply(
        "fake",
        `evt-${ref}-ok`,
        scenario.fact,
        { providerRef: ref },
        at(5)
      );
      assert.equal(valid.status, "applied", `${type}: the matching reference`);
      scenario.expected(await billing.readRecord(tenant.organizationId));
      assert.equal(await mismatchCount(type), incidentsBefore + 3);
    }
    tests.push(
      "every fact type (trial method ready, charge succeeded, charge failed, cancellation, cycle change, refund, chargeback and its reversal) without a subscription reference, with another subscription's, or with another provider's changes nothing and is counted as an operational incident (a code and a count, no reference of the provider); one for a record with no subscription attached yet fails and waits for the link; the matching reference applies"
    );

    // a fact that reaches us before the subscription is linked waits and is applied, in order, once it is
    const arrival = await newTenant("lifecycle before the link");
    const beforeLink = async (id: string, fact: BillingFact) => {
      const recorded = await billing.recordEvent({
        fact,
        provider: "fake",
        providerEventId: id,
        providerRef: "sub_EARLY",
      });
      return {
        ...(await billing.processEvent(recorded.id, at(2))),
        id: recorded.id,
      };
    };
    const chargeEvent = await beforeLink(
      "evt-EARLY-1",
      succeeded(at(0), at(30))
    );
    const refundEvent = await beforeLink(
      "evt-EARLY-2",
      taken("charge_refunded", at(1), at(30))
    );
    assert.equal(chargeEvent.outcomeCode, "unknown_organization");
    assert.equal(refundEvent.outcomeCode, "unknown_organization");
    await billing.attachProvider(arrival.organizationId, "fake", "sub_EARLY");
    await billing.retryPending(at(3));
    const arrived = await billing.readRecord(arrival.organizationId);
    assert.equal(arrived?.state, "free", "a refunded payment grants nothing");
    assert.equal(arrived?.accessEndsAt, null);
    assert.deepEqual(
      (
        await admin.pool.query<{
          state_after: string;
          state_before: string;
          status: string;
        }>(
          "SELECT status, state_before, state_after FROM public.billing_events WHERE id = ANY($1::uuid[]) ORDER BY received_at, id",
          [[chargeEvent.id, refundEvent.id]]
        )
      ).rows.map((row) => [row.status, row.state_before, row.state_after]),
      [
        ["applied", "free", "active"],
        ["applied", "active", "free"],
      ],
      "the retry pass applies both, in the order they arrived: the charge first, then the refund"
    );

    // the refund is applied right after the link, before the retry of the confirmation that came first
    const overtaken = await newTenant("lifecycle refund overtakes");
    const confirmation = await (async () => {
      const recorded = await billing.recordEvent({
        fact: succeeded(at(0), at(30)),
        provider: "fake",
        providerEventId: "evt-OVERTAKEN-1",
        providerRef: "sub_OVERTAKEN",
      });
      await billing.processEvent(recorded.id, at(2));
      return recorded.id;
    })();
    await billing.attachProvider(
      overtaken.organizationId,
      "fake",
      "sub_OVERTAKEN"
    );
    const overtaking = await apply(
      "fake",
      "evt-OVERTAKEN-2",
      taken("charge_refunded", at(1), at(30)),
      { providerRef: "sub_OVERTAKEN" },
      at(2)
    );
    assert.equal(overtaking.status, "applied");
    const waitedConfirmation = await billing.processEvent(confirmation, at(3));
    assert.equal(waitedConfirmation.outcomeCode, "not_applicable");
    const overtakenRecord = await billing.readRecord(overtaken.organizationId);
    assert.equal(
      overtakenRecord?.state,
      "free",
      "a confirmation that waited for the link does not give back a payment that was refunded"
    );
    assert.equal(overtakenRecord?.accessEndsAt, null);
    // a fact that never finds its subscription is an incident at its last attempt, not a silent loss
    const unresolvedBefore = await incidentCount(
      "reference_unresolved",
      "subscription_cancelled"
    );
    const unresolvedNoRefBefore = await incidentCount(
      "reference_unresolved",
      "cycle_change_scheduled"
    );
    const lost = await billing.recordEvent({
      fact: { occurredAt: at(0), type: "subscription_cancelled" },
      provider: "fake",
      providerEventId: "evt-LOST-1",
      providerRef: "sub_NEVER_LINKED",
    });
    const noReference = await billing.recordEvent({
      fact: {
        cycleMonths: 6,
        occurredAt: at(0),
        type: "cycle_change_scheduled",
      },
      provider: "fake",
      providerEventId: "evt-LOST-2",
    });
    for (const id of [lost.id, noReference.id]) {
      // biome-ignore lint/performance/noAwaitInLoops: One event at a time.
      await billing.processEvent(id, at(2));
    }
    for (const day of [3, 4, 5]) {
      // biome-ignore lint/performance/noAwaitInLoops: The attempts are sequential on purpose.
      await billing.retryPending(at(day));
      assert.equal(
        await incidentCount("reference_unresolved", "subscription_cancelled"),
        unresolvedBefore,
        "while it can still wait for the link it is not an incident"
      );
    }
    await billing.retryPending(at(6));
    assert.equal(
      await incidentCount("reference_unresolved", "subscription_cancelled"),
      unresolvedBefore + 1,
      "at its last attempt a fact no subscription claims is an operational incident"
    );
    assert.equal(
      await incidentCount("reference_unresolved", "cycle_change_scheduled"),
      unresolvedNoRefBefore + 1,
      "so is one that names no subscription at all"
    );
    await billing.retryPending(at(7));
    assert.equal(
      await incidentCount("reference_unresolved", "subscription_cancelled"),
      unresolvedBefore + 1,
      "and it is counted once"
    );
    assert.deepEqual(
      (
        await admin.pool.query<{ outcome_code: string; status: string }>(
          "SELECT status, outcome_code FROM public.billing_events WHERE id = $1",
          [lost.id]
        )
      ).rows[0],
      { outcome_code: "unknown_organization", status: "failed" }
    );

    // a reference linked to another organization is not a wait for the link
    const claimed = await subscribed(
      "lifecycle claimed",
      "sub_CLAIMED",
      succeeded(at(0), at(30))
    );
    const unclaimed = await newTenant("lifecycle not claimed");
    const crossed = await apply(
      "fake",
      "evt-CROSSED-1",
      { occurredAt: at(2), type: "subscription_cancelled" },
      { organizationId: unclaimed.organizationId, providerRef: "sub_CLAIMED" },
      at(2)
    );
    assert.equal(crossed.status, "ignored");
    assert.equal(crossed.outcomeCode, "reference_mismatch");
    assert.equal(
      (await billing.readRecord(claimed.organizationId))?.cancelAtPeriodEnd,
      false
    );

    // the incident function takes every fact type the domain has, and only those
    for (const type of BILLING_FACT_TYPES) {
      // biome-ignore lint/performance/noAwaitInLoops: One probe per type.
      await asBillingClient((client) =>
        client.query(
          "SELECT public.record_billing_reference_incident('reference_mismatch', $1, gen_random_uuid())",
          [type]
        )
      );
    }
    await expectSqlState(
      () =>
        asBillingClient((client) =>
          client.query(
            "SELECT public.record_billing_reference_incident('reference_mismatch', 'charge_made_up', gen_random_uuid())"
          )
        ),
      "22023",
      "the incident function refuses a fact type the domain does not have"
    );
    await expectSqlState(
      () =>
        asBillingClient((client) =>
          client.query(
            "SELECT public.record_billing_reference_incident('made_up', 'charge_failed', gen_random_uuid())"
          )
        ),
      "22023",
      "the incident function refuses a cause it does not know"
    );
    tests.push(
      "facts that arrive before the subscription is linked fail without effect and are applied, in the order they arrived, by the retry pass once it is; a refund applied right after the link is not undone by the confirmation that waited; a fact that no subscription claims by its last attempt (or that names none) is an operational incident, once; a reference linked to another organization is a mismatch, not a wait; the incident function takes every fact type of the domain and refuses any other"
    );

    // ------------------------------------- 11. what a tenant sees
    const visible = await withRuntimeSqlContext(
      runtimeUrl,
      tenantA,
      async (client) => {
        const own = await client.query(
          "SELECT 1 FROM public.billing_events WHERE organization_id = $1",
          [tenantA.organizationId]
        );
        const others = await client.query(
          "SELECT 1 FROM public.billing_events WHERE organization_id <> $1",
          [tenantA.organizationId]
        );
        return [(own.rowCount ?? 0) > 0, others.rowCount];
      }
    );
    assert.deepEqual(visible, [true, 0]);
    tests.push(
      "an organization reads its own billing history and none of anyone else's"
    );

    console.log(
      JSON.stringify(
        {
          branch,
          database: serverRow.database_name,
          serverVersion: serverRow.server_version,
          status: "passed",
          tests,
        },
        null,
        2
      )
    );
  } finally {
    if (store) {
      await store.close();
    }
    if (runtime) {
      await runtime.pool.end();
    }
    for (const [role, group] of [
      [loginRole, runtimeRole],
      [billingLoginRole, "polaris_billing_runtime"],
    ] as const) {
      if (role) {
        // biome-ignore lint/performance/noAwaitInLoops: Two cleanups, in order.
        await admin.pool.query(`REVOKE "${group}" FROM "${role}"`);
        await admin.pool.query(`DROP ROLE IF EXISTS "${role}"`);
      }
    }
    await admin.pool.end();
  }
}

run().catch((error: unknown) => {
  console.error(
    `Billing lifecycle PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
