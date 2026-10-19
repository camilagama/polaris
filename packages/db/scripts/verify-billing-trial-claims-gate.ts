import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { BillingFact } from "@polaris/domain/billing/facts";
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
 * facts and the semiannual price turned off.
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
const BACKFILL_STATEMENT =
  /INSERT INTO public\.billing_trial_claims \(user_id, organization_id, reserved_at, consumed_at\)[\s\S]*?ON CONFLICT \(user_id\) DO NOTHING;/;
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
         FROM pg_catalog.pg_constraint WHERE conrelid = 'public.billing_trial_claims'::regclass AND contype = 'f' ORDER BY 1`
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

    // ------------------------------------------- 3. the race, behind a barrier
    const racer = await newTenant("race A");
    const raceOther = await newTenant("race B");
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
    tests.push(
      "two organizations of one person starting a trial at the same instant (released together from a barrier) end with one reservation: one trial_setup, the other refused with trial_in_progress and left Free"
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
    const migration = readFileSync(
      new URL("../drizzle/0084_trial_por_pessoa.sql", import.meta.url),
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
        [[oldest, newer, idle, twice, kept]]
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
      "the migration's backfill gives the oldest owner of each organization whose trial started a consumed claim dated by that start: a newer owner, an organization with no owner and one whose trial never started give none, the oldest owner of two gets the earliest, an existing claim is kept and running it twice changes nothing"
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
