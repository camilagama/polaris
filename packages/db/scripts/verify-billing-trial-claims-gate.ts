import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import type { BillingFact } from "@polaris/domain/billing/facts";
import { Client } from "pg";
import {
  type AbandonedTrialCheckout,
  createBillingStore,
} from "../src/billing-store";
import { createDatabase } from "../src/client";
import { eachRound, lockRow, raceBehindLock } from "./concurrency-support";
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
  temporaryRuntimeUrl,
  withRuntimeSqlContext,
} from "./sales-gate-support";

/**
 * The trial per person (ADR 0101, migration 0084) on a real PostgreSQL 18: the
 * claim that `startTrial` reserves for an organization, moves from an abandoned
 * checkout and refuses when used or in progress, its consumption in the same
 * statement as `trial_started_at`, two organizations of one person racing behind
 * a barrier, the row lock that orders a decision after a consumption, the
 * backfill of the trials already used (with its edges), the cascade with the
 * account, the privileges of the billing and tenant roles, the provider's
 * subscription ID stored from the first matched fact, the amount of the money
 * facts, the semiannual price turned off, and a checkout paid after its
 * person took the reservation elsewhere (given up at the provider, and kept as
 * `unresolved` instead of starting a second trial).
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const DAY = 86_400_000;
const base = new Date();
const at = (days: number) => new Date(base.getTime() + days * DAY);
const TRIAL_IN_PROGRESS = /trial_in_progress/;
const TRIAL_ALREADY_USED = /trial_already_used/;
const PROVIDER_UNAVAILABLE = /provider_unavailable/;
const BACKFILL_STATEMENT =
  /INSERT INTO public\.billing_trial_claims \(user_id, organization_id, reserved_at, consumed_at\)[\s\S]*?ON CONFLICT \(user_id\) DO NOTHING;/;
const TRIAL_MIGRATION = /^\d{4}_trial_por_pessoa\.sql$/;
/** The advisory lock key of the barrier (any constant the other gates do not use). */
const BARRIER_KEY = 840_101;

/** Provider references of this run: the gate can run again on the same database. */
const run = randomUUID().slice(0, 8);

const methodReady = (occurredAt: Date): BillingFact => ({
  cycleMonths: 1,
  occurredAt,
  type: "trial_method_ready",
});

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one linear gate script, section by section
async function main() {
  const branch = requiredEnvironment("POLARIS_SALES_GATE_BRANCH");
  assert.match(branch, gateBranchPattern);
  const adminUrl = requiredEnvironment("POLARIS_SALES_GATE_DATABASE_URL");
  const parsedAdminUrl = new URL(adminUrl);
  assert.match(parsedAdminUrl.hostname, disposableHostPattern);
  assert.doesNotMatch(parsedAdminUrl.hostname, poolerPattern);

  const admin = createDatabase(adminUrl, { maxConnections: 4 });
  let loginRole: string | undefined;
  let billingLoginRole: string | undefined;
  let store: ReturnType<typeof createBillingStore> | undefined;
  let barrierInstalled = false;
  const tests: string[] = [];

  try {
    const server = await admin.pool.query<{
      database_name: string;
      server_version_num: string;
    }>(
      "SELECT current_database() AS database_name, current_setting('server_version_num') AS server_version_num"
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
      "PostgreSQL 18 with every migration replayed from scratch, the trial claims included"
    );

    loginRole = `polaris_trial_gate_rt_${randomUUID().replaceAll("-", "")}`;
    billingLoginRole = `polaris_trial_gate_${randomUUID().replaceAll("-", "")}`;
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
    const billing = createBillingStore(billingUrl);
    store = billing;

    const newTenant = (label: string) =>
      createTenantFixture(
        admin.pool,
        `trial ${label}`,
        "America/Sao_Paulo",
        "free"
      );
    const newUser = async (): Promise<string> => {
      const id = randomUUID();
      await admin.pool.query(
        'INSERT INTO public."user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)',
        [id, "Trial gate", `trial-${id}@example.invalid`]
      );
      return id;
    };
    const addOwner = async (
      organizationId: string,
      userId: string,
      createdAt: Date
    ) => {
      await admin.pool.query(
        "INSERT INTO public.memberships (organization_id, user_id, role, status, created_at) VALUES ($1, $2, 'owner', 'active', $3)",
        [organizationId, userId, createdAt]
      );
    };
    const claimOf = async (userId: string) =>
      (
        await admin.pool.query<{
          consumed_at: Date | null;
          organization_id: string;
          reserved_at: Date;
        }>(
          "SELECT organization_id, reserved_at, consumed_at FROM public.billing_trial_claims WHERE user_id = $1",
          [userId]
        )
      ).rows[0] ?? null;
    const billingRow = async (organizationId: string) =>
      (
        await admin.pool.query<{
          provider_subscription_id: string | null;
          state: string;
          trial_started_at: Date | null;
        }>(
          "SELECT state, trial_started_at, provider_subscription_id FROM public.organization_billing WHERE organization_id = $1",
          [organizationId]
        )
      ).rows[0] ?? null;
    /** The checkout of the organization was abandoned: it is no longer setting up its trial. */
    const abandon = async (organizationId: string) => {
      await admin.pool.query(
        "UPDATE public.organization_billing SET state = 'free', over_limit_since = NULL WHERE organization_id = $1 AND state = 'trial_setup'",
        [organizationId]
      );
    };
    const deliver = async (
      providerRef: string,
      fact: BillingFact,
      providerSubscriptionId: string | null = null
    ) => {
      const stored = await billing.recordEvent({
        fact,
        provider: "fake",
        providerEventId: `trial-gate-${randomUUID()}`,
        providerRef,
        providerSubscriptionId,
      });
      return await billing.processEvent(stored.id, fact.occurredAt);
    };

    // ------------------------------------- 1. the table, its keys and its privileges
    const table = await admin.pool.query<{
      forced: boolean;
      rls: boolean;
    }>(
      "SELECT relrowsecurity AS rls, relforcerowsecurity AS forced FROM pg_catalog.pg_class WHERE oid = 'public.billing_trial_claims'::regclass"
    );
    assert.deepEqual(table.rows[0], { forced: true, rls: true });
    const policies = await admin.pool.query<{ policy: string; roles: string }>(
      `SELECT policyname AS policy, array_to_string(roles, ',') AS roles
         FROM pg_catalog.pg_policies WHERE schemaname = 'public' AND tablename = 'billing_trial_claims' ORDER BY 1`
    );
    assert.deepEqual(
      policies.rows,
      ["insert", "select", "update"].map((action) => ({
        policy: `billing_trial_claims_billing_runtime_${action}`,
        roles: "polaris_billing_runtime",
      }))
    );
    const keys = await admin.pool.query<{ action: string; target: string }>(
      `SELECT confrelid::regclass::text AS target, confdeltype::text AS action
         FROM pg_catalog.pg_constraint WHERE conrelid = 'public.billing_trial_claims'::regclass AND contype = 'f' ORDER BY confrelid::regclass::text COLLATE "C"`
    );
    assert.deepEqual(keys.rows, [
      { action: "c", target: '"user"' },
      { action: "r", target: "organizations" },
    ]);
    const privileges = await admin.pool.query<{
      role: string;
      sel: boolean;
      ins: boolean;
      upd: boolean;
      del: boolean;
      upd_user: boolean;
    }>(
      `SELECT r AS role,
              has_table_privilege(r, 'public.billing_trial_claims', 'SELECT') AS sel,
              has_table_privilege(r, 'public.billing_trial_claims', 'INSERT') AS ins,
              has_any_column_privilege(r, 'public.billing_trial_claims', 'UPDATE') AS upd,
              has_table_privilege(r, 'public.billing_trial_claims', 'DELETE') AS del,
              has_column_privilege(r, 'public.billing_trial_claims', 'user_id', 'UPDATE') AS upd_user
         FROM unnest(ARRAY['polaris_billing_runtime', 'polaris_pr11_runtime', 'polaris_purge_owner', 'polaris_privacy_runtime', 'polaris_admin_runtime', 'polaris_auth_runtime']) AS r
        ORDER BY 1`
    );
    for (const row of privileges.rows) {
      const billingRole = row.role === "polaris_billing_runtime";
      assert.deepEqual(
        [row.sel, row.ins, row.upd, row.del, row.upd_user],
        [billingRole, billingRole, billingRole, false, false],
        row.role
      );
    }
    tests.push(
      "billing_trial_claims has RLS forced with policies only for the billing role, a cascading key to the user and a restrictive one to the organization; only the billing role reads, inserts and updates (never deletes, never changes the user), and the tenant, purge, privacy, admin and auth roles have nothing"
    );

    // ----------------------------- 2. reserve, refuse, move, consume (one person)
    const person = await newTenant("person A");
    const second = await newTenant("person B");
    const third = await newTenant("person C");
    await addOwner(second.organizationId, person.userId, at(0));
    await addOwner(third.organizationId, person.userId, at(0));

    const started = await billing.startTrial(
      person.organizationId,
      person.userId,
      at(0)
    );
    assert.equal(started.state, "trial_setup");
    assert.deepEqual(await claimOf(person.userId), {
      consumed_at: null,
      organization_id: person.organizationId,
      reserved_at: at(0),
    });
    // the same organization again (the person closed the checkout and came back)
    await billing.startTrial(person.organizationId, person.userId, at(0.1));
    assert.equal(
      (await claimOf(person.userId))?.organization_id,
      person.organizationId
    );
    // another organization of the same person while the first is still setting up
    await assert.rejects(
      () => billing.startTrial(second.organizationId, person.userId, at(0.2)),
      TRIAL_IN_PROGRESS
    );
    assert.equal(
      (await billingRow(second.organizationId))?.state ?? "free",
      "free"
    );
    // the first checkout is abandoned: the reservation moves, nothing consumed
    await abandon(person.organizationId);
    await billing.startTrial(second.organizationId, person.userId, at(0.3));
    assert.deepEqual(await claimOf(person.userId), {
      consumed_at: null,
      organization_id: second.organizationId,
      reserved_at: at(0.3),
    });
    tests.push(
      "startTrial reserves the person's trial, accepts the same organization again, refuses another organization of the person with trial_in_progress while the first is setting up its trial, and moves the reservation once that checkout was abandoned, without consuming it"
    );

    await billing.attachProvider(
      second.organizationId,
      "fake",
      `chk_trial_B_${run}`
    );
    const ready = await deliver(
      `chk_trial_B_${run}`,
      methodReady(at(0.4)),
      `sub_trial_B_${run}`
    );
    assert.equal(ready.status, "applied");
    const consumed = await billingRow(second.organizationId);
    assert.equal(consumed?.state, "trialing");
    const claim = await claimOf(person.userId);
    assert.ok(consumed?.trial_started_at && claim?.consumed_at);
    assert.equal(
      claim.consumed_at.getTime(),
      consumed.trial_started_at.getTime(),
      "the claim is consumed by the statement that records trial_started_at"
    );
    assert.equal(claim.organization_id, second.organizationId);
    await assert.rejects(
      () => billing.startTrial(third.organizationId, person.userId, at(1)),
      TRIAL_ALREADY_USED
    );
    assert.equal(
      (await billingRow(third.organizationId))?.state ?? "free",
      "free"
    );
    tests.push(
      "trial_method_ready consumes the claim of the organization in the same statement that records trial_started_at (same instant), and a third organization of the same person is refused with trial_already_used and stays Free"
    );

    // the statement that consumes is the one that records the start: if it fails, neither is written
    const atomic = await newTenant("atomic");
    await billing.startTrial(atomic.organizationId, atomic.userId, at(0));
    await billing.attachProvider(
      atomic.organizationId,
      "fake",
      `chk_atomic_${run}`
    );
    await admin.pool.query(
      `CREATE FUNCTION public.trial_gate_refuse_start() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN RAISE EXCEPTION 'trial gate refuses the start' USING ERRCODE = '23514'; END $$`
    );
    await admin.pool.query(
      `CREATE TRIGGER trial_gate_refuse_start BEFORE UPDATE OF trial_started_at ON public.organization_billing
         FOR EACH ROW WHEN (OLD.trial_started_at IS NULL AND NEW.trial_started_at IS NOT NULL AND NEW.organization_id = '${atomic.organizationId}')
         EXECUTE FUNCTION public.trial_gate_refuse_start()`
    );
    try {
      const refused = await deliver(`chk_atomic_${run}`, methodReady(at(0.5)));
      assert.equal(refused.status, "failed");
    } catch {
      // processEvent records the failure and throws: either way nothing applied
    } finally {
      await admin.pool.query(
        "DROP TRIGGER trial_gate_refuse_start ON public.organization_billing"
      );
      await admin.pool.query("DROP FUNCTION public.trial_gate_refuse_start()");
    }
    assert.equal(
      (await billingRow(atomic.organizationId))?.state,
      "trial_setup"
    );
    assert.equal((await claimOf(atomic.userId))?.consumed_at, null);
    tests.push(
      "when the statement that records trial_started_at fails, the claim is not consumed either (one statement, one transaction)"
    );

    // subscribing without a trial, and abandoning, never consume a reservation
    const waiver = await newTenant("waiver");
    await billing.startTrial(waiver.organizationId, waiver.userId, at(0));
    await billing.attachProvider(
      waiver.organizationId,
      "fake",
      `chk_waiver_${run}`
    );
    await deliver(`chk_waiver_${run}`, {
      amount: { currency: "BRL", value: "24.90" },
      cycleMonths: 1,
      occurredAt: at(0.5),
      periodEndsAt: at(30.5),
      type: "charge_succeeded",
    });
    assert.equal((await billingRow(waiver.organizationId))?.state, "active");
    assert.equal((await claimOf(waiver.userId))?.consumed_at, null);
    const abandoned = await newTenant("abandoned");
    await billing.startTrial(abandoned.organizationId, abandoned.userId, at(0));
    await abandon(abandoned.organizationId);
    assert.equal((await claimOf(abandoned.userId))?.consumed_at, null);
    tests.push(
      "a subscription without a trial and an abandoned checkout leave the reservation unconsumed"
    );

    // two owners of one organization: the trial being set up is one person's, and only that one is spent
    const shared = await newTenant("shared");
    const coOwner = await newUser();
    await addOwner(shared.organizationId, coOwner, at(0));
    await billing.startTrial(shared.organizationId, shared.userId, at(0));
    await assert.rejects(
      () => billing.startTrial(shared.organizationId, coOwner, at(0.1)),
      TRIAL_IN_PROGRESS
    );
    assert.equal(await claimOf(coOwner), null);
    // the first owner abandons; the co-owner opts in and finishes the checkout
    await abandon(shared.organizationId);
    await billing.startTrial(shared.organizationId, coOwner, at(0.2));
    await billing.attachProvider(
      shared.organizationId,
      "fake",
      `chk_shared_${run}`
    );
    await deliver(`chk_shared_${run}`, methodReady(at(0.3)));
    assert.equal((await billingRow(shared.organizationId))?.state, "trialing");
    assert.ok((await claimOf(coOwner))?.consumed_at);
    assert.equal(
      (await claimOf(shared.userId))?.consumed_at,
      null,
      "the first owner, whose checkout was abandoned, keeps an unused trial"
    );
    // that unused reservation moves on: the organization is no longer setting up its trial
    const sharedNext = await newTenant("shared next");
    await addOwner(sharedNext.organizationId, shared.userId, at(0));
    await billing.startTrial(sharedNext.organizationId, shared.userId, at(1));
    assert.equal(
      (await claimOf(shared.userId))?.organization_id,
      sharedNext.organizationId
    );
    tests.push(
      "with two owners, a second person cannot start a trial on an organization already setting up the first one's (trial_in_progress); after the first abandons, the trial started is the last person's to reserve and only that reservation is consumed, while the other one stays unused and can move to another organization"
    );

    // ------------------------------------------- 3. the race, behind a barrier
    // Each round repeats the race with fresh organizations; the barrier below holds both
    // commands inside their transaction and the gate proves both are waiting at it.
    const startRounds = await eachRound(async (round) => {
      const racer = await newTenant(`race A ${round}`);
      const raceOther = await newTenant(`race B ${round}`);
      await addOwner(raceOther.organizationId, racer.userId, at(0));
      await admin.pool.query(
        `CREATE FUNCTION public.trial_gate_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN
           IF NEW.user_id = '${racer.userId}' THEN
             PERFORM pg_catalog.pg_advisory_lock_shared(${BARRIER_KEY});
             PERFORM pg_catalog.pg_advisory_unlock_shared(${BARRIER_KEY});
           END IF;
           RETURN NEW;
         END $$`
      );
      await admin.pool.query(
        "CREATE TRIGGER trial_gate_barrier BEFORE INSERT ON public.billing_trial_claims FOR EACH ROW EXECUTE FUNCTION public.trial_gate_barrier()"
      );
      barrierInstalled = true;
      const gate = new Client({ connectionString: adminUrl });
      await gate.connect();
      let outcomes: PromiseSettledResult<unknown>[];
      try {
        await gate.query("SELECT pg_advisory_lock($1)", [BARRIER_KEY]);
        const both = Promise.allSettled([
          billing.startTrial(racer.organizationId, racer.userId, at(0)),
          billing.startTrial(raceOther.organizationId, racer.userId, at(0)),
        ]);
        // both transactions reached the claim (each holding its own organization's row) and wait at the barrier
        for (let tries = 0; ; tries += 1) {
          // biome-ignore lint/performance/noAwaitInLoops: Polls until both racers wait.
          const waiting = await admin.pool.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM pg_catalog.pg_locks WHERE locktype = 'advisory' AND objid = $1 AND NOT granted",
            [BARRIER_KEY]
          );
          if (Number(waiting.rows[0]?.count) === 2) {
            break;
          }
          assert.ok(tries < 200, "both racers reach the barrier");
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        await gate.query("SELECT pg_advisory_unlock($1)", [BARRIER_KEY]);
        outcomes = await both;
      } finally {
        await gate.end();
        await admin.pool.query(
          "DROP TRIGGER trial_gate_barrier ON public.billing_trial_claims"
        );
        await admin.pool.query("DROP FUNCTION public.trial_gate_barrier()");
        barrierInstalled = false;
      }
      const fulfilled = outcomes.filter(
        (outcome) => outcome.status === "fulfilled"
      );
      const rejected = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === "rejected"
      );
      assert.equal(
        fulfilled.length,
        1,
        "exactly one organization gets the trial"
      );
      assert.equal(rejected.length, 1);
      assert.match(String(rejected[0]?.reason), TRIAL_IN_PROGRESS);
      const raced = await claimOf(racer.userId);
      assert.ok(raced);
      const winner =
        outcomes[0]?.status === "fulfilled"
          ? racer.organizationId
          : raceOther.organizationId;
      const loser =
        winner === racer.organizationId
          ? raceOther.organizationId
          : racer.organizationId;
      assert.equal(raced.organization_id, winner);
      assert.equal((await billingRow(winner))?.state, "trial_setup");
      assert.equal((await billingRow(loser))?.state ?? "free", "free");
    });
    tests.push(
      `two organizations of one person starting a trial at the same instant (released together from a barrier, both seen waiting at it) end with one reservation: one trial_setup, the other refused with trial_in_progress and left Free (${startRounds} round(s))`
    );

    // ------------------- 4. the claim row is the lock: a decision waits for a consumption
    const locked = await newTenant("lock A");
    const lockedOther = await newTenant("lock B");
    await addOwner(lockedOther.organizationId, locked.userId, at(0));
    await billing.startTrial(locked.organizationId, locked.userId, at(0));
    await abandon(locked.organizationId);
    const holder = new Client({ connectionString: adminUrl });
    await holder.connect();
    let lockOutcome: unknown;
    try {
      const holderPid = (
        await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0]?.pid;
      assert.ok(holderPid);
      await holder.query("BEGIN");
      await holder.query(
        "SELECT 1 FROM public.billing_trial_claims WHERE user_id = $1 FOR UPDATE",
        [locked.userId]
      );
      const waiter = billing
        .startTrial(lockedOther.organizationId, locked.userId, at(0.2))
        .then(
          () => "started",
          (error: unknown) => error
        );
      for (let tries = 0; ; tries += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: Polls until the command waits on the row.
        const blocked = await admin.pool.query<{ count: string }>(
          `SELECT count(DISTINCT waiting.pid)::text AS count FROM pg_catalog.pg_locks AS waiting
            WHERE NOT waiting.granted AND $1 = ANY (pg_catalog.pg_blocking_pids(waiting.pid))`,
          [holderPid]
        );
        if (Number(blocked.rows[0]?.count) === 1) {
          break;
        }
        assert.ok(tries < 200, "the command waits on the claim's row");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      // meanwhile the trial of that claim started elsewhere: the waiting command must see it
      await holder.query(
        "UPDATE public.billing_trial_claims SET consumed_at = $2 WHERE user_id = $1",
        [locked.userId, at(0.1)]
      );
      await holder.query("COMMIT");
      lockOutcome = await waiter;
    } finally {
      await holder.end();
    }
    assert.match(String(lockOutcome), TRIAL_ALREADY_USED);
    assert.equal(
      (await billingRow(lockedOther.organizationId))?.state ?? "free",
      "free"
    );
    tests.push(
      "startTrial decides on the claim's row under FOR UPDATE: a command waiting behind a consumption committed meanwhile sees it and refuses with trial_already_used"
    );

    // --------------------------------------------------- 5. the backfill and its edges
    // found by its name, so a renumbering at the merge does not break the gate
    const drizzleDirectory = new URL("../drizzle/", import.meta.url);
    const migrationFile = readdirSync(drizzleDirectory).find((name) =>
      TRIAL_MIGRATION.test(name)
    );
    assert.ok(migrationFile, "the migration of the trial per person exists");
    const migration = readFileSync(
      new URL(migrationFile, drizzleDirectory),
      "utf8"
    );
    const backfill = BACKFILL_STATEMENT.exec(migration)?.[0];
    assert.ok(backfill, "the backfill statement is in the migration");
    const fill = new Client({ connectionString: adminUrl });
    await fill.connect();
    try {
      await fill.query("BEGIN");
      const make = async (label: string, trialStartedAt: Date | null) => {
        const organizationId = randomUUID();
        await fill.query(
          "INSERT INTO public.organizations (id, name, timezone) VALUES ($1, $2, 'America/Sao_Paulo')",
          [organizationId, `Trial backfill ${label}`]
        );
        await fill.query(
          `INSERT INTO public.organization_billing (organization_id, state, access_ends_at, trial_started_at, over_limit_since)
           VALUES ($1, 'free', NULL, $2, NULL)`,
          [organizationId, trialStartedAt]
        );
        return organizationId;
      };
      const owner = async () => {
        const id = randomUUID();
        await fill.query(
          'INSERT INTO public."user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)',
          [id, "Trial backfill", `backfill-${id}@example.invalid`]
        );
        return id;
      };
      const member = (
        organizationId: string,
        userId: string,
        createdAt: Date
      ) =>
        fill.query(
          "INSERT INTO public.memberships (organization_id, user_id, role, status, created_at) VALUES ($1, $2, 'owner', 'active', $3)",
          [organizationId, userId, createdAt]
        );
      // several owners: only the oldest one gets the claim
      const several = await make("several", at(-40));
      const oldest = await owner();
      const newer = await owner();
      await member(several, newer, at(-60));
      await member(several, oldest, at(-90));
      // no owner left (a purged organization): no claim
      const ownerless = await make("ownerless", at(-30));
      // the trial never started: no claim, even with an owner
      const neverStarted = await make("never", null);
      const idle = await owner();
      await member(neverStarted, idle, at(-50));
      // oldest owner of two organizations whose trial started: the earliest one
      const twice = await owner();
      const later = await make("later", at(-10));
      const earlier = await make("earlier", at(-20));
      await member(later, twice, at(-80));
      await member(earlier, twice, at(-70));
      // a person who already has a claim keeps it (ON CONFLICT DO NOTHING)
      const kept = await owner();
      const keptOrganization = await make("kept", at(-5));
      await member(keptOrganization, kept, at(-6));
      await fill.query(
        "INSERT INTO public.billing_trial_claims (user_id, organization_id, reserved_at) VALUES ($1, $2, $3)",
        [kept, several, at(-1)]
      );

      // two owners since the same instant: the smaller user ID, so the result never depends on the plan
      const tied = await make("tied", at(-15));
      const tiedOwners = [await owner(), await owner()].sort();
      for (const tiedOwner of tiedOwners) {
        // biome-ignore lint/performance/noAwaitInLoops: Two memberships, in order.
        await member(tied, tiedOwner, at(-100));
      }

      await fill.query(backfill);
      // the statement can run again: nothing changes
      await fill.query(backfill);
      const claims = await fill.query<{
        consumed_at: Date | null;
        organization_id: string;
        reserved_at: Date;
        user_id: string;
      }>(
        "SELECT user_id, organization_id, reserved_at, consumed_at FROM public.billing_trial_claims WHERE user_id = ANY($1) ORDER BY user_id",
        [[oldest, newer, idle, twice, kept, ...tiedOwners]]
      );
      const byUser = new Map(claims.rows.map((row) => [row.user_id, row]));
      assert.deepEqual(byUser.get(oldest), {
        consumed_at: at(-40),
        organization_id: several,
        reserved_at: at(-40),
        user_id: oldest,
      });
      assert.equal(byUser.has(newer), false, "a newer owner gets no claim");
      assert.equal(byUser.has(idle), false, "a trial never started gives none");
      assert.deepEqual(byUser.get(twice), {
        consumed_at: at(-20),
        organization_id: earlier,
        reserved_at: at(-20),
        user_id: twice,
      });
      assert.deepEqual(byUser.get(kept), {
        consumed_at: null,
        organization_id: several,
        reserved_at: at(-1),
        user_id: kept,
      });
      assert.equal(byUser.get(tiedOwners[0] ?? "")?.organization_id, tied);
      assert.equal(byUser.has(tiedOwners[1] ?? ""), false);
      const ownerlessClaims = await fill.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM public.billing_trial_claims WHERE organization_id = $1",
        [ownerless]
      );
      assert.equal(Number(ownerlessClaims.rows[0]?.count), 0);
    } finally {
      await fill.query("ROLLBACK").catch(() => undefined);
      await fill.end();
    }
    tests.push(
      "the migration's backfill gives the oldest owner of each organization whose trial started a consumed claim dated by that start: a newer owner, an organization with no owner and one whose trial never started give none, the oldest owner of two gets the earliest, two owners since the same instant give it to the smaller user ID, an existing claim is kept and running it twice changes nothing"
    );

    // ----------------------------------------- 6. the account and the organization
    const leaving = await newUser();
    const leavingOrganization = await newTenant("leaving");
    await billing.startTrial(
      leavingOrganization.organizationId,
      leaving,
      at(0)
    );
    assert.ok(await claimOf(leaving));
    await admin.pool.query('DELETE FROM public."user" WHERE id = $1', [
      leaving,
    ]);
    assert.equal(await claimOf(leaving), null);
    // an organization with nothing else that restricts its deletion: only the claim
    const claimed = await newTenant("claimed");
    await admin.pool.query(
      "INSERT INTO public.billing_trial_claims (user_id, organization_id, reserved_at, consumed_at) VALUES ($1, $2, $3, $3)",
      [claimed.userId, claimed.organizationId, at(0)]
    );
    await expectSqlState(
      () =>
        admin.pool.query("DELETE FROM public.organizations WHERE id = $1", [
          claimed.organizationId,
        ]),
      "23001",
      "an organization with a claim is not deleted (the claim outlives it)",
      "billing_trial_claims_organization_id_organizations_id_fk"
    );
    tests.push(
      "deleting the account removes its claim (cascade), and an organization with a claim cannot be deleted under it (the claim outlives the purge, which never deletes the organization)"
    );

    // -------------------------------------------------------- 7. the roles at work
    await withRuntimeSqlContext(runtimeUrl, second, async (client) => {
      await expectSqlState(
        () => client.query("SELECT user_id FROM public.billing_trial_claims"),
        "42501",
        "the tenant does not read the trial claims"
      );
    });
    await withRuntimeSqlContext(runtimeUrl, second, async (client) => {
      await expectSqlState(
        () =>
          client.query(
            "INSERT INTO public.billing_trial_claims (user_id, organization_id, reserved_at) VALUES ($1, $2, now())",
            [second.userId, second.organizationId]
          ),
        "42501",
        "the tenant does not write a trial claim"
      );
    });
    const billingClient = new Client({ connectionString: billingUrl });
    await billingClient.connect();
    try {
      await expectSqlState(
        () =>
          billingClient.query(
            "DELETE FROM public.billing_trial_claims WHERE user_id = $1",
            [person.userId]
          ),
        "42501",
        "the billing role does not delete a claim"
      );
      await expectSqlState(
        () =>
          billingClient.query(
            "UPDATE public.billing_trial_claims SET user_id = $2 WHERE user_id = $1",
            [person.userId, randomUUID()]
          ),
        "42501",
        "the billing role does not hand a claim to another person"
      );
    } finally {
      await billingClient.end();
    }
    tests.push(
      "the tenant role neither reads nor writes a claim (42501), and the billing role cannot delete one or change its user"
    );

    // ------------------------------ 8. the provider's subscription ID and the amount
    const linked = await billing.readProviderLink(second.organizationId);
    assert.deepEqual(linked, {
      provider: "fake",
      providerRef: `chk_trial_B_${run}`,
      providerSubscriptionId: `sub_trial_B_${run}`,
    });
    // a later fact of the same checkout with another ID does not replace the first one
    await deliver(
      `chk_trial_B_${run}`,
      {
        amount: { currency: "BRL", value: "24.90" },
        cycleMonths: 1,
        occurredAt: at(7),
        periodEndsAt: at(37),
        type: "charge_succeeded",
      },
      `sub_trial_other_${run}`
    );
    assert.equal(
      (await billing.readProviderLink(second.organizationId))
        ?.providerSubscriptionId,
      `sub_trial_B_${run}`
    );
    const ledger = await admin.pool.query<{
      fact: Record<string, unknown>;
      provider_subscription_id: string | null;
    }>(
      `SELECT fact, provider_subscription_id FROM public.billing_events
        WHERE organization_id = $1 AND fact_type = 'charge_succeeded'`,
      [second.organizationId]
    );
    assert.equal(ledger.rows.length, 1);
    assert.equal(
      ledger.rows[0]?.provider_subscription_id,
      `sub_trial_other_${run}`
    );
    assert.equal(ledger.rows[0]?.fact.amount, "24.90");
    assert.equal(ledger.rows[0]?.fact.currency, "BRL");
    // a fact of another checkout (a reference mismatch) stores nothing on the record
    const mismatched = await newTenant("mismatch");
    await billing.attachProvider(
      mismatched.organizationId,
      "fake",
      `chk_mine_${run}`
    );
    const mismatch = await billing.recordEvent({
      fact: { occurredAt: at(1), type: "charge_failed" },
      organizationId: mismatched.organizationId,
      provider: "fake",
      providerEventId: `trial-gate-${randomUUID()}`,
      providerRef: `chk_someone_else_${run}`,
      providerSubscriptionId: `sub_someone_else_${run}`,
    });
    const mismatchResult = await billing.processEvent(mismatch.id, at(1));
    assert.equal(mismatchResult.outcomeCode, "reference_mismatch");
    assert.equal(
      (await billingRow(mismatched.organizationId))?.provider_subscription_id,
      null
    );
    // a new checkout attached (the old one abandoned) forgets the old subscription's ID
    const relinked = await newTenant("relink");
    await billing.startTrial(relinked.organizationId, relinked.userId, at(0));
    await billing.attachProvider(
      relinked.organizationId,
      "fake",
      `chk_old_${run}`
    );
    await deliver(
      `chk_old_${run}`,
      { occurredAt: at(0.5), type: "subscription_cancelled" },
      `sub_old_${run}`
    );
    assert.equal(
      (await billingRow(relinked.organizationId))?.provider_subscription_id,
      `sub_old_${run}`
    );
    await billing.attachProvider(
      relinked.organizationId,
      "fake",
      `chk_new_${run}`
    );
    assert.deepEqual(await billing.readProviderLink(relinked.organizationId), {
      provider: "fake",
      providerRef: `chk_new_${run}`,
      providerSubscriptionId: null,
    });
    await expectSqlState(
      () =>
        admin.pool.query(
          "UPDATE public.organization_billing SET provider = NULL, provider_ref = NULL WHERE organization_id = $1",
          [second.organizationId]
        ),
      "23514",
      "a subscription ID without a reference",
      "organization_billing_provider_subscription_coherent"
    );
    await withRuntimeSqlContext(runtimeUrl, second, async (client) => {
      await expectSqlState(
        () =>
          client.query(
            "SELECT provider_subscription_id FROM public.billing_events"
          ),
        "42501",
        "the tenant does not read the provider's subscription ID of the ledger"
      );
    });
    await withRuntimeSqlContext(runtimeUrl, second, async (client) => {
      await expectSqlState(
        () =>
          client.query(
            "SELECT provider_subscription_id FROM public.organization_billing"
          ),
        "42501",
        "the tenant does not read the provider's subscription ID of the record"
      );
    });
    const tenantLedger = await withRuntimeSqlContext(
      runtimeUrl,
      second,
      (client) =>
        client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM (SELECT id, fact, fact_type, status, provider_ref FROM public.billing_events) AS ledger"
        )
    );
    assert.ok(Number(tenantLedger.rows[0]?.count) >= 2);
    tests.push(
      "the first fact that matched the reference stores the provider's subscription ID on the record (a later one does not replace it, a mismatched one stores nothing, a new checkout clears it), the inbox keeps the ID of each event and the money fact keeps its amount and currency; the tenant still reads its ledger but neither ID column"
    );

    // one subscription ID belongs to one organization: another record never takes it
    const elsewhere = await newTenant("elsewhere");
    await billing.attachProvider(
      elsewhere.organizationId,
      "fake",
      `chk_elsewhere_${run}`
    );
    await deliver(
      `chk_elsewhere_${run}`,
      { occurredAt: at(1), type: "charge_failed" },
      `sub_trial_B_${run}`
    );
    assert.equal(
      (await billingRow(elsewhere.organizationId))?.provider_subscription_id,
      null
    );
    await expectSqlState(
      () =>
        admin.pool.query(
          "UPDATE public.organization_billing SET provider_subscription_id = $2 WHERE organization_id = $1",
          [elsewhere.organizationId, `sub_trial_B_${run}`]
        ),
      "23505",
      "a subscription ID held by another organization",
      "organization_billing_provider_subscription_unique"
    );
    tests.push(
      "a subscription ID already held by another organization is never stored on a second record (the store skips it and a unique index refuses it)"
    );

    // ----------------------------------------------------- 9. the semiannual cycle
    const prices = await admin.pool.query<{
      active: boolean;
      id: string;
    }>(
      "SELECT id, active FROM public.billing_prices WHERE plan_id = 'pro' ORDER BY interval_months"
    );
    assert.deepEqual(prices.rows, [
      { active: true, id: "pro_monthly" },
      { active: false, id: "pro_semiannual" },
      { active: true, id: "pro_annual" },
    ]);
    tests.push(
      "the semiannual Pro price is kept but no longer active (Q12): only the monthly and annual cycles are offered"
    );

    // ------------------- 10. a checkout paid after the reservation moved elsewhere
    const discarded: AbandonedTrialCheckout[] = [];
    const discarding = createBillingStore(billingUrl, {
      discardCheckout: (checkout) => {
        discarded.push(checkout);
        return Promise.resolve();
      },
    });
    const failing = createBillingStore(billingUrl, {
      discardCheckout: () => Promise.reject(new Error("provider_unavailable")),
    });
    try {
      const eventOf = async (eventId: string) =>
        (
          await admin.pool.query<{
            attempts: number;
            outcome_code: string | null;
            state_after: string | null;
            state_before: string | null;
            status: string;
          }>(
            "SELECT status, outcome_code, attempts, state_before, state_after FROM public.billing_events WHERE id = $1",
            [eventId]
          )
        ).rows[0];
      const deliverStored = async (
        providerRef: string,
        fact: BillingFact,
        providerSubscriptionId: string | null = null
      ) => {
        const stored = await billing.recordEvent({
          fact,
          provider: "fake",
          providerEventId: `trial-gate-${randomUUID()}`,
          providerRef,
          providerSubscriptionId,
        });
        return {
          id: stored.id,
          result: await billing.processEvent(stored.id, fact.occurredAt),
        };
      };
      const trialsOf = async (organizationIds: string[]) =>
        Number(
          (
            await admin.pool.query<{ count: string }>(
              "SELECT count(*)::text AS count FROM public.organization_billing WHERE organization_id = ANY($1::text[]) AND trial_started_at IS NOT NULL",
              [organizationIds]
            )
          ).rows[0]?.count
        );

      // 1. U opts into the trial on A (reservation in A, checkout linked)
      const shopA = await newTenant("paid late A");
      const shopB = await newTenant("paid late B");
      const owner = shopA.userId;
      await addOwner(shopB.organizationId, owner, at(0));
      await discarding.startTrial(shopA.organizationId, owner, at(0));
      await discarding.attachProvider(
        shopA.organizationId,
        "fake",
        `chk_late_A_${run}`
      );
      assert.deepEqual(discarded, [], "a first reservation gives nothing up");
      // 2. the checkout of A is abandoned: A is Free again
      await abandon(shopA.organizationId);
      // 3. U opts in on B: the reservation moves, and A's checkout is given up once the move is committed
      await discarding.startTrial(shopB.organizationId, owner, at(0.2));
      assert.equal(
        (await claimOf(owner))?.organization_id,
        shopB.organizationId
      );
      assert.deepEqual(discarded, [
        {
          organizationId: shopA.organizationId,
          provider: "fake",
          providerRef: `chk_late_A_${run}`,
        },
      ]);
      // 4. U pays A's old checkout anyway (the provider did not cancel it in time)
      const lateA = await deliverStored(
        `chk_late_A_${run}`,
        methodReady(at(0.3)),
        `sub_late_A_${run}`
      );
      assert.deepEqual(lateA.result, {
        eventId: lateA.id,
        organizationId: shopA.organizationId,
        outcomeCode: "trial_claim_missing",
        status: "unresolved",
      });
      assert.deepEqual(await eventOf(lateA.id), {
        attempts: 1,
        outcome_code: "trial_claim_missing",
        state_after: "free",
        state_before: "free",
        status: "unresolved",
      });
      const recordA = await billingRow(shopA.organizationId);
      assert.equal(recordA?.state, "free");
      assert.equal(recordA?.trial_started_at, null);
      // the subscription is still found by its ID, for the reconciliation to cancel or charge it
      assert.equal(recordA?.provider_subscription_id, `sub_late_A_${run}`);
      assert.deepEqual(await claimOf(owner), {
        consumed_at: null,
        organization_id: shopB.organizationId,
        reserved_at: at(0.2),
      });
      // 5. U pays B's checkout: B's trial starts, and it is the only one
      await discarding.attachProvider(
        shopB.organizationId,
        "fake",
        `chk_late_B_${run}`
      );
      const readyB = await deliver(`chk_late_B_${run}`, methodReady(at(0.4)));
      assert.equal(readyB.status, "applied");
      assert.equal((await billingRow(shopB.organizationId))?.state, "trialing");
      assert.equal(
        (await claimOf(owner))?.organization_id,
        shopB.organizationId
      );
      assert.ok((await claimOf(owner))?.consumed_at);
      assert.equal(
        await trialsOf([shopA.organizationId, shopB.organizationId]),
        1,
        "one person, one trial"
      );
      // the retry pass reads the unresolved fact again: still nothing to pay for it
      const retried = await billing.retryPending(at(5), 1000);
      assert.ok(retried.unresolved >= 1);
      assert.equal((await eventOf(lateA.id))?.status, "unresolved");
      assert.equal((await eventOf(lateA.id))?.attempts, 2);
      assert.equal((await billingRow(shopA.organizationId))?.state, "free");
      assert.equal(
        await trialsOf([shopA.organizationId, shopB.organizationId]),
        1
      );
      // an unresolved event whose reading throws is a failure that counts an attempt (never retried forever)
      await admin.pool.query(
        `CREATE FUNCTION public.trial_gate_refuse_unresolved() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN RAISE EXCEPTION 'trial gate refuses the reading' USING ERRCODE = '23514'; END $$`
      );
      await admin.pool.query(
        `CREATE TRIGGER trial_gate_refuse_unresolved BEFORE UPDATE ON public.billing_events
           FOR EACH ROW WHEN (OLD.status = 'unresolved' AND NEW.status = 'unresolved' AND NEW.id = '${lateA.id}')
           EXECUTE FUNCTION public.trial_gate_refuse_unresolved()`
      );
      try {
        await assert.rejects(() => billing.processEvent(lateA.id, at(6)));
      } finally {
        await admin.pool.query(
          "DROP TRIGGER trial_gate_refuse_unresolved ON public.billing_events"
        );
        await admin.pool.query(
          "DROP FUNCTION public.trial_gate_refuse_unresolved()"
        );
      }
      assert.deepEqual(await eventOf(lateA.id), {
        attempts: 3,
        outcome_code: "error",
        state_after: "free",
        state_before: "free",
        status: "failed",
      });
      tests.push(
        "a checkout paid after its person took the trial reservation to another organization starts no trial: A's checkout is given up when the reservation moves, the late trial_method_ready of A is kept as unresolved (trial_claim_missing, only IDs, A stays Free), B's own checkout starts the one trial, the retry pass reads the unresolved fact again without starting a second, and a reading that throws counts an attempt like any failure"
      );

      // the move of the reservation racing the payment of the checkout it gives up:
      // exactly one of them wins, never both (concurrency-support.ts holds the claim's row first)
      const discardRounds = await eachRound(async (round) => {
        const discardA = await newTenant(`discard race A ${round}`);
        const discardB = await newTenant(`discard race B ${round}`);
        const traveler = discardA.userId;
        const checkoutA = `chk_discard_A_${run}_${round}`;
        await addOwner(discardB.organizationId, traveler, at(0));
        await discarding.startTrial(discardA.organizationId, traveler, at(0));
        await discarding.attachProvider(
          discardA.organizationId,
          "fake",
          checkoutA
        );
        await abandon(discardA.organizationId);
        let paidEventId = "";
        const { results } = await raceBehindLock<unknown>({
          adminUrl,
          hold: [lockRow("billing_trial_claims", "user_id", traveler)],
          label:
            "the move of the trial reservation racing the payment of the discarded checkout",
          racers: [
            () =>
              discarding.startTrial(discardB.organizationId, traveler, at(0.2)),
            async () => {
              const delivered = await deliverStored(
                checkoutA,
                methodReady(at(0.3)),
                `sub_discard_A_${run}_${round}`
              );
              paidEventId = delivered.id;
              return delivered;
            },
          ],
        });
        const [moved, paid] = results;
        assert.ok(moved && paid);
        assert.equal(paid.status, "fulfilled", "the payment is always stored");
        const reservation = await claimOf(traveler);
        assert.ok(reservation);
        if (moved.status === "fulfilled") {
          // the reservation moved first: A's late payment starts no trial
          assert.equal(reservation.organization_id, discardB.organizationId);
          assert.equal(reservation.consumed_at, null);
          assert.equal(
            (await billingRow(discardB.organizationId))?.state,
            "trial_setup"
          );
          assert.equal(
            (await billingRow(discardA.organizationId))?.state,
            "free"
          );
          assert.equal(
            (await eventOf(paidEventId))?.outcome_code,
            "trial_claim_missing"
          );
        } else {
          // the payment came first: A holds the one trial and the move is refused
          assert.match(String(moved.reason), TRIAL_ALREADY_USED);
          assert.equal(reservation.organization_id, discardA.organizationId);
          assert.ok(reservation.consumed_at);
          assert.equal(
            (await billingRow(discardA.organizationId))?.state,
            "trialing"
          );
          assert.equal(
            (await billingRow(discardB.organizationId))?.state ?? "free",
            "free"
          );
        }
        assert.equal(
          await trialsOf([discardA.organizationId, discardB.organizationId]),
          moved.status === "fulfilled" ? 0 : 1,
          "one traveler, one trial, whoever wins the race"
        );
      });
      tests.push(
        `the move of a trial reservation racing the payment of the checkout it gives up ends in exactly one of two states, never both: the reservation moved and the late payment is trial_claim_missing, or the payment consumed it and the move is trial_already_used (${discardRounds} round(s), released from a barrier with the racers seen blocked on the claim's row)`
      );

      // a fact that was unresolved applies once its organization holds the reservation again, and only once
      const shopC = await newTenant("paid late C");
      const shopD = await newTenant("paid late D");
      const back = shopC.userId;
      await addOwner(shopD.organizationId, back, at(0));
      await discarding.startTrial(shopC.organizationId, back, at(0));
      await discarding.attachProvider(
        shopC.organizationId,
        "fake",
        `chk_late_C_${run}`
      );
      await abandon(shopC.organizationId);
      await discarding.startTrial(shopD.organizationId, back, at(0.1));
      const lateC = await deliverStored(
        `chk_late_C_${run}`,
        methodReady(at(0.2))
      );
      assert.equal(lateC.result.status, "unresolved");
      // D is abandoned too (it never linked a checkout: nothing to give up) and the person returns to C
      await abandon(shopD.organizationId);
      const before = discarded.length;
      await discarding.startTrial(shopC.organizationId, back, at(0.3));
      assert.equal(discarded.length, before, "D had no checkout to give up");
      assert.equal(
        (await claimOf(back))?.organization_id,
        shopC.organizationId
      );
      await billing.retryPending(at(5), 1000);
      assert.equal((await eventOf(lateC.id))?.status, "applied");
      assert.equal((await billingRow(shopC.organizationId))?.state, "trialing");
      assert.ok((await claimOf(back))?.consumed_at);
      const again = await billing.processEvent(lateC.id, at(6));
      assert.equal(again.status, "applied");
      await billing.retryPending(at(10), 1000);
      const ledgerC = await admin.pool.query<{ status: string }>(
        "SELECT status FROM public.billing_events WHERE organization_id = $1 AND fact_type = 'trial_method_ready'",
        [shopC.organizationId]
      );
      assert.deepEqual(
        ledgerC.rows.map((row) => row.status),
        ["applied"]
      );
      assert.equal(
        await trialsOf([shopC.organizationId, shopD.organizationId]),
        1
      );
      tests.push(
        "an unresolved fact is reprocessable: once its organization holds the person's reservation again, the retry pass applies it once (one ledger row, one consumed reservation, one trial), and processing it again changes nothing"
      );

      // the race: the fact waits on the reservation's row while the person moves it; it then finds none
      const racedP = await newTenant("raced P");
      const racedQ = await newTenant("raced Q");
      const mover = racedP.userId;
      await addOwner(racedQ.organizationId, mover, at(0));
      await billing.startTrial(racedP.organizationId, mover, at(0));
      await billing.attachProvider(
        racedP.organizationId,
        "fake",
        `chk_raced_P_${run}`
      );
      const claimHolder = new Client({ connectionString: adminUrl });
      await claimHolder.connect();
      let racedOutcome: Awaited<ReturnType<typeof deliverStored>> | undefined;
      try {
        const holderPid = (
          await claimHolder.query<{ pid: number }>(
            "SELECT pg_backend_pid() AS pid"
          )
        ).rows[0]?.pid;
        assert.ok(holderPid);
        await claimHolder.query("BEGIN");
        await claimHolder.query(
          "SELECT 1 FROM public.billing_trial_claims WHERE user_id = $1 FOR UPDATE",
          [mover]
        );
        const waiting = deliverStored(
          `chk_raced_P_${run}`,
          methodReady(at(0.2))
        );
        for (let tries = 0; ; tries += 1) {
          // biome-ignore lint/performance/noAwaitInLoops: Polls until the fact waits on the row.
          const blocked = await admin.pool.query<{ count: string }>(
            `SELECT count(DISTINCT waiting.pid)::text AS count FROM pg_catalog.pg_locks AS waiting
              WHERE NOT waiting.granted AND $1 = ANY (pg_catalog.pg_blocking_pids(waiting.pid))`,
            [holderPid]
          );
          if (Number(blocked.rows[0]?.count) === 1) {
            break;
          }
          assert.ok(tries < 200, "the fact waits on the reservation's row");
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        // meanwhile the reservation moved to Q (as reserveTrial moves it)
        await claimHolder.query(
          "UPDATE public.billing_trial_claims SET organization_id = $2, reserved_at = $3 WHERE user_id = $1",
          [mover, racedQ.organizationId, at(0.1)]
        );
        await claimHolder.query("COMMIT");
        racedOutcome = await waiting;
      } finally {
        await claimHolder.end();
      }
      assert.equal(racedOutcome?.result.status, "unresolved");
      assert.equal(racedOutcome?.result.outcomeCode, "trial_claim_missing");
      const racedRecord = await billingRow(racedP.organizationId);
      assert.equal(racedRecord?.state, "trial_setup");
      assert.equal(racedRecord?.trial_started_at, null);
      assert.deepEqual(await claimOf(mover), {
        consumed_at: null,
        organization_id: racedQ.organizationId,
        reserved_at: at(0.1),
      });
      tests.push(
        "the fact that would start the trial locks the organization's reservation before it writes: one waiting while the reservation moves away finds none after the wait, stays unresolved and consumes nothing"
      );

      // the provider fails to give the checkout up: the move stands, and a late payment still starts nothing
      const shopE = await newTenant("discard fails E");
      const shopF = await newTenant("discard fails F");
      const unlucky = shopE.userId;
      await addOwner(shopF.organizationId, unlucky, at(0));
      await failing.startTrial(shopE.organizationId, unlucky, at(0));
      await failing.attachProvider(
        shopE.organizationId,
        "fake",
        `chk_fail_E_${run}`
      );
      await abandon(shopE.organizationId);
      const moved = await failing.startTrial(
        shopF.organizationId,
        unlucky,
        at(0.1)
      );
      assert.equal(moved.state, "trial_setup");
      assert.equal(
        (await claimOf(unlucky))?.organization_id,
        shopF.organizationId
      );
      const lateE = await deliverStored(
        `chk_fail_E_${run}`,
        methodReady(at(0.2))
      );
      assert.equal(lateE.result.status, "unresolved");
      assert.equal((await billingRow(shopE.organizationId))?.state, "free");
      tests.push(
        "a provider that fails to give the abandoned checkout up does not undo the move (startTrial succeeds, the failure is only logged), and the late payment of that checkout is still unresolved"
      );

      // a refused move gives nothing up, and a live subscription is not a pending checkout
      const live = await newTenant("live G");
      const other = await newTenant("live H");
      await addOwner(other.organizationId, live.userId, at(0));
      await discarding.startTrial(live.organizationId, live.userId, at(0));
      await discarding.attachProvider(
        live.organizationId,
        "fake",
        `chk_live_G_${run}`
      );
      const countBefore = discarded.length;
      await assert.rejects(
        () => discarding.startTrial(other.organizationId, live.userId, at(0.1)),
        TRIAL_IN_PROGRESS
      );
      await deliver(`chk_live_G_${run}`, {
        amount: { currency: "BRL", value: "24.90" },
        cycleMonths: 1,
        occurredAt: at(0.2),
        periodEndsAt: at(30.2),
        type: "charge_succeeded",
      });
      assert.equal((await billingRow(live.organizationId))?.state, "active");
      await discarding.startTrial(other.organizationId, live.userId, at(0.3));
      assert.equal(
        (await claimOf(live.userId))?.organization_id,
        other.organizationId
      );
      assert.equal(
        discarded.length,
        countBefore,
        "neither a refused move nor a subscription that is live gives a checkout up"
      );
      tests.push(
        "a move refused with trial_in_progress gives nothing up, and a reservation that leaves an organization with a live subscription (subscribed without a trial) leaves its checkout alone"
      );
    } finally {
      await discarding.close();
      await failing.close();
    }

    // -------- 11. a trial no reservation paid for is settled; an idle setup ends (PR 3)
    {
      /** A checkout paid after its person took the reservation elsewhere: an unresolved fact. */
      const unclaimed = async (label: string) => {
        const owner = await newTenant(label);
        const moved = await newTenant(`${label} elsewhere`);
        await addOwner(moved.organizationId, owner.userId, at(0));
        await billing.startTrial(owner.organizationId, owner.userId, at(0));
        const ref = `chk_${label.replaceAll(" ", "_")}_${run}`;
        const sub = `sub_${label.replaceAll(" ", "_")}_${run}`;
        await billing.attachProvider(owner.organizationId, "fake", ref);
        await abandon(owner.organizationId);
        await billing.startTrial(moved.organizationId, owner.userId, at(0.1));
        const late = await deliver(ref, methodReady(at(0.2)), sub);
        assert.equal(late.status, "unresolved");
        assert.equal(late.outcomeCode, "trial_claim_missing");
        return { eventId: late.eventId, moved, owner, ref, sub };
      };
      const listedUnclaimed = async (eventId: string) =>
        (await billing.listUnclaimedTrials(1000)).filter(
          (entry) => entry.eventId === eventId
        );
      const eventRow = async (eventId: string) =>
        (
          await admin.pool.query<{
            outcome_code: string | null;
            status: string;
          }>(
            "SELECT status, outcome_code FROM public.billing_events WHERE id = $1",
            [eventId]
          )
        ).rows[0];
      const settlement = async (eventId: string) =>
        (
          await admin.pool.query<{ fact: { type: string }; fact_type: string }>(
            "SELECT fact, fact_type FROM public.billing_events WHERE provider = 'polaris' AND provider_event_id = $1",
            [`command:settle_unclaimed_trial:${eventId}`]
          )
        ).rows;
      const exhaust = async (eventId: string) => {
        await admin.pool.query(
          "UPDATE public.billing_events SET attempts = 5 WHERE id = $1",
          [eventId]
        );
      };

      const cancelledCase = await unclaimed("unclaimed cancel");
      // still within its retries: the reprocess may yet find the reservation
      assert.deepEqual(await listedUnclaimed(cancelledCase.eventId), []);
      assert.equal(
        await billing.settleUnclaimedTrial(
          cancelledCase.eventId,
          () => Promise.reject(new Error("must_not_be_called")),
          at(0.3)
        ),
        "not_pending"
      );
      await exhaust(cancelledCase.eventId);
      assert.deepEqual(await listedUnclaimed(cancelledCase.eventId), [
        {
          eventId: cancelledCase.eventId,
          organizationId: cancelledCase.owner.organizationId,
          provider: "fake",
          providerRef: cancelledCase.ref,
          providerSubscriptionId: cancelledCase.sub,
        },
      ]);
      // the provider fails: nothing changes, the next pass tries again
      await assert.rejects(
        () =>
          billing.settleUnclaimedTrial(
            cancelledCase.eventId,
            () => Promise.reject(new Error("provider_unavailable")),
            at(0.3)
          ),
        PROVIDER_UNAVAILABLE
      );
      assert.equal((await listedUnclaimed(cancelledCase.eventId)).length, 1);
      assert.deepEqual(await settlement(cancelledCase.eventId), []);
      const cancelCalls: unknown[] = [];
      assert.equal(
        await billing.settleUnclaimedTrial(
          cancelledCase.eventId,
          (event) => {
            cancelCalls.push(event);
            return Promise.resolve("cancelled" as const);
          },
          at(0.3)
        ),
        "cancelled"
      );
      assert.deepEqual(cancelCalls, [
        {
          eventId: cancelledCase.eventId,
          organizationId: cancelledCase.owner.organizationId,
          provider: "fake",
          providerRef: cancelledCase.ref,
          providerSubscriptionId: cancelledCase.sub,
        },
      ]);
      assert.deepEqual(await eventRow(cancelledCase.eventId), {
        outcome_code: "trial_claim_missing",
        status: "ignored",
      });
      assert.deepEqual(await settlement(cancelledCase.eventId), [
        { fact: { type: "unclaimed_trial_cancelled" }, fact_type: "command" },
      ]);
      // settled once: a repeat neither calls the provider nor writes again
      assert.equal(
        await billing.settleUnclaimedTrial(
          cancelledCase.eventId,
          () => Promise.reject(new Error("must_not_be_called")),
          at(0.4)
        ),
        "not_pending"
      );
      assert.equal((await settlement(cancelledCase.eventId)).length, 1);
      assert.deepEqual(await listedUnclaimed(cancelledCase.eventId), []);
      // nothing else moved: no trial on either organization, the reservation unspent
      assert.equal(
        (await billingRow(cancelledCase.owner.organizationId))
          ?.trial_started_at,
        null
      );
      assert.deepEqual(await claimOf(cancelledCase.owner.userId), {
        consumed_at: null,
        organization_id: cancelledCase.moved.organizationId,
        reserved_at: at(0.1),
      });

      // the same subscription was paid since and gives Pro: it is left alone
      const paidCase = await unclaimed("unclaimed paid");
      await deliver(paidCase.ref, {
        amount: { currency: "BRL", value: "24.90" },
        cycleMonths: 1,
        occurredAt: at(0.3),
        periodEndsAt: at(30.3),
        type: "charge_succeeded",
      });
      assert.equal(
        (await billingRow(paidCase.owner.organizationId))?.state,
        "active"
      );
      await exhaust(paidCase.eventId);
      assert.equal(
        await billing.settleUnclaimedTrial(
          paidCase.eventId,
          () => Promise.reject(new Error("must_not_be_called")),
          at(0.4)
        ),
        "left_paid"
      );
      assert.deepEqual(await settlement(paidCase.eventId), [
        { fact: { type: "unclaimed_trial_left_paid" }, fact_type: "command" },
      ]);
      assert.equal(
        (await billingRow(paidCase.owner.organizationId))?.state,
        "active"
      );
      // the provider shows a charge of it already paid, before the record knows: left alone too
      const providerPaid = await unclaimed("unclaimed provider paid");
      await exhaust(providerPaid.eventId);
      assert.equal(
        await billing.settleUnclaimedTrial(
          providerPaid.eventId,
          () => Promise.resolve("paid" as const),
          at(0.4)
        ),
        "left_paid"
      );
      assert.deepEqual(await settlement(providerPaid.eventId), [
        { fact: { type: "unclaimed_trial_left_paid" }, fact_type: "command" },
      ]);
      tests.push(
        "a trial no reservation paid for is settled only after its retries: the event's own subscription (reference and sub_) is handed to the provider's cancel under the event's lock, and only when it succeeds is the event closed as ignored (trial_claim_missing kept) with unclaimed_trial_cancelled in the ledger, once; a failure changes nothing, and a subscription paid since (Pro on the record, or a paid charge at the provider) is left alone (unclaimed_trial_left_paid)"
      );

      // a setup with no checkout finished for more than two hours ends, without spending the trial
      const idle = await newTenant("idle setup");
      await billing.startTrial(idle.organizationId, idle.userId, at(0));
      await billing.sweepDue(new Date(at(0).getTime() + 3_600_000));
      assert.equal(
        (await billingRow(idle.organizationId))?.state,
        "trial_setup"
      );
      const swept = await billing.sweepDue(at(0.2));
      assert.equal(swept.failed, 0);
      assert.equal((await billingRow(idle.organizationId))?.state, "free");
      assert.deepEqual(await claimOf(idle.userId), {
        consumed_at: null,
        organization_id: idle.organizationId,
        reserved_at: at(0),
      });
      await billing.sweepDue(at(0.3));
      const abandonedRows = await admin.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM public.billing_events WHERE organization_id = $1 AND fact_type = 'time_elapsed' AND fact->>'transition' = 'abandon_trial_setup'",
        [idle.organizationId]
      );
      assert.equal(Number(abandonedRows.rows[0]?.count), 1);
      // the reservation is free to go: the person starts the trial in another organization
      const next = await newTenant("idle setup next");
      await addOwner(next.organizationId, idle.userId, at(0));
      await billing.startTrial(next.organizationId, idle.userId, at(0.3));
      assert.equal(
        (await claimOf(idle.userId))?.organization_id,
        next.organizationId
      );
      // a second checkout replaces the first: attachProvider names the one replaced, once
      const twice = await newTenant("checkout twice");
      assert.equal(
        await billing.attachProvider(
          twice.organizationId,
          "fake",
          `chk_first_${run}`
        ),
        null
      );
      assert.deepEqual(
        await billing.attachProvider(
          twice.organizationId,
          "fake",
          `chk_second_${run}`
        ),
        { provider: "fake", providerRef: `chk_first_${run}` }
      );
      // a checkout a subscription came from was finished: it is not named as one to give up
      await admin.pool.query(
        "UPDATE public.organization_billing SET provider_subscription_id = $2 WHERE organization_id = $1",
        [twice.organizationId, `sub_second_${run}`]
      );
      assert.equal(
        await billing.attachProvider(
          twice.organizationId,
          "fake",
          `chk_third_${run}`
        ),
        null
      );
      // attaching the reference already on the record is a repeat: nothing replaced
      assert.equal(
        await billing.attachProvider(
          twice.organizationId,
          "fake",
          `chk_third_${run}`
        ),
        null
      );
      // the third checkout is open (attaching it cleared the subscription): going back to
      // another reference names it, so the caller gives it up and no open checkout is left behind
      assert.deepEqual(
        await billing.attachProvider(
          twice.organizationId,
          "fake",
          `chk_second_${run}`
        ),
        { provider: "fake", providerRef: `chk_third_${run}` }
      );
      tests.push(
        "a trial setup idle for more than two hours goes back to Free in the time sweep (not before), once, without consuming the reservation, which can then move to another organization of the person; and a new checkout's attachProvider names the reference it replaced (null for the first, for a repeat of the current reference and for a finished checkout; the open checkout it replaced otherwise, including when going back to an earlier reference)"
      );
    }

    // ------------- 13. Pix checkout (cobrança PR 6): the payer's lock, the hourly list
    {
      const pix = randomUUID().slice(0, 8);
      const pixHolder = await newTenant("pix holder");
      const asker = await newTenant("pix asker");
      const linkedRef = `pix_ref_${pix}`;
      const storedSubscription = `pix_sub_${pix}`;
      await billing.attachProvider(
        pixHolder.organizationId,
        "woovi",
        linkedRef
      );
      await admin.pool.query(
        "UPDATE public.organization_billing SET provider_subscription_id = $2 WHERE organization_id = $1",
        [pixHolder.organizationId, storedSubscription]
      );

      // the hourly list: a link that may still change access, or one written in the last 8 days
      const listed = async (when: Date) =>
        new Set(
          await billing.listReconcilableOrganizations("woovi", 1000, when)
        );
      const checkedAt = new Date();
      assert.ok(
        (await listed(checkedAt)).has(pixHolder.organizationId),
        "a fresh link on Free is read (a Pix without trial waits for its first charge)"
      );
      assert.ok(!(await listed(checkedAt)).has(asker.organizationId));
      await admin.pool.query(
        "UPDATE public.organization_billing SET updated_at = $2 WHERE organization_id = $1",
        [
          pixHolder.organizationId,
          new Date(checkedAt.getTime() - 9 * 86_400_000),
        ]
      );
      assert.ok(
        !(await listed(checkedAt)).has(pixHolder.organizationId),
        "an old link on Free is not read any more"
      );
      await admin.pool.query(
        "UPDATE public.organization_billing SET state = 'active', access_ends_at = $2, cycle_months = 1 WHERE organization_id = $1",
        [
          pixHolder.organizationId,
          new Date(checkedAt.getTime() + 20 * 86_400_000),
        ]
      );
      assert.ok(
        (await listed(checkedAt)).has(pixHolder.organizationId),
        "a live subscription is read whatever its age"
      );
      assert.ok(
        !new Set(
          await billing.listReconcilableOrganizations("asaas", 1000, checkedAt)
        ).has(pixHolder.organizationId),
        "only the provider asked for"
      );
      assert.equal(
        (await billing.listReconcilableOrganizations("woovi", 1, checkedAt))
          .length,
        1,
        "never more than the limit"
      );
      await Promise.all(
        [0, 1001, 1.5].map((limit) =>
          assert.rejects(() =>
            billing.listReconcilableOrganizations("woovi", limit, checkedAt)
          )
        )
      );

      // the payer's lock: the same key waits, another key does not
      const order: string[] = [];
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered: () => void = () => undefined;
      const inside = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const first = billing.withPayerLock("0a1b2c3d", async () => {
        order.push("first in");
        entered();
        await held;
        order.push("first out");
      });
      await inside;
      const waiting = billing.withPayerLock("0a1b2c3d", () => {
        order.push("second in");
        return Promise.resolve();
      });
      await billing.withPayerLock("ffffffff", () => {
        order.push("other key");
        return Promise.resolve();
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.deepEqual(
        order,
        ["first in", "other key"],
        "the same key waits for the lock; another key goes on"
      );
      release();
      await Promise.all([first, waiting]);
      assert.deepEqual(order, [
        "first in",
        "other key",
        "first out",
        "second in",
      ]);
      // an operation that throws releases the lock (the transaction rolls back)
      await assert.rejects(() =>
        billing.withPayerLock("0a1b2c3d", () =>
          Promise.reject(new Error("pix gate operation"))
        )
      );
      assert.equal(
        await billing.withPayerLock("0a1b2c3d", () => Promise.resolve("again")),
        "again"
      );
      await Promise.all(
        ["", "0A1B2C3D", "0a1b", "0a1b2c3d4", "zzzzzzzz"].map((bucket) =>
          assert.rejects(
            () => billing.withPayerLock(bucket, () => Promise.resolve()),
            TypeError
          )
        )
      );
      tests.push(
        "Pix checkout (cobrança PR 6): the hourly reconciliation lists a link that may still change access whatever its age and one on Free only for 8 days, of that provider and within its limit; the payer's lock serializes the same key, leaves another key alone, is released by an operation that throws and refuses a key that is not 8 hex digits"
      );
    }

    console.log(
      JSON.stringify(
        {
          branch,
          database: expectedDatabase,
          gate: "billing-trial-claims",
          status: "passed",
          tests,
        },
        null,
        2
      )
    );
  } finally {
    if (barrierInstalled) {
      await admin.pool
        .query(
          "DROP TRIGGER IF EXISTS trial_gate_barrier ON public.billing_trial_claims; DROP FUNCTION IF EXISTS public.trial_gate_barrier()"
        )
        .catch(() => undefined);
    }
    if (store) {
      await store.close();
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

main().catch((error: unknown) => {
  console.error(
    `Billing trial claims PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
