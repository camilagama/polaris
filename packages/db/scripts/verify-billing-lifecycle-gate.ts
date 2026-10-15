import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { BillingFact } from "@polaris/domain/billing/facts";
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
        "SELECT 1 FROM public.entitlement_grants",
        "SELECT 1 FROM public.plan_entitlements",
        "SELECT 1 FROM public.product_variants",
        "SELECT 1 FROM public.product_media",
        "SELECT 1 FROM public.organizations",
        "SELECT 1 FROM public.memberships",
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
    const trial = await billing.startTrial(tenantA.organizationId, at(0));
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
      () => billing.startTrial(tenantA.organizationId, at(1)),
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
    await billing.startTrial(restarting.organizationId, at(0));
    await billing.attachProvider(restarting.organizationId, "fake", "sub_old");
    await billing.attachProvider(restarting.organizationId, "fake", "sub_new");
    const secondStart = await billing.startTrial(
      restarting.organizationId,
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
