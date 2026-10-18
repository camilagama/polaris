import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { InvalidEntitlementGrantError } from "@polaris/domain/billing/grants";
import { Client } from "pg";
import { getEffectiveEntitlements } from "../src/billing-repository";
import { createBillingStore } from "../src/billing-store";
import { createDatabase } from "../src/client";
import { readOperationalSelection } from "../src/operational-selection-repository";
import { createProduct } from "../src/product-repository";
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
  withTenantAs,
} from "./sales-gate-support";

/**
 * Temporary entitlement grants on a real PostgreSQL 18 (plan PR85, ADR 0067):
 * only the billing role writes them (an organization never grants itself
 * anything), each says who, why, from when and until when and always ends, it
 * raises the entitlements without becoming a subscription, it counts only
 * between its start and its end, it can be ended early, and the end of a limit
 * grant puts an organization that holds more than Free allows into the same
 * adaptation window as one that left Pro.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const DAY_MS = 86_400_000;
const ID_CONFLICT = /entitlement_grant_id_conflict/;

/** Runs the steps one after the other (a transaction cannot interleave them). */
function inSequence(count: number, step: (index: number) => Promise<unknown>) {
  return Array.from({ length: count }).reduce<Promise<unknown>>(
    (previous, _, index) => previous.then(() => step(index)),
    Promise.resolve()
  );
}

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

    loginRole = `polaris_grants_gate_rt_${randomUUID().replaceAll("-", "")}`;
    billingLoginRole = `polaris_grants_gate_${randomUUID().replaceAll("-", "")}`;
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
    const { db } = runtime;
    const as = <T>(
      tenant: TenantFixture,
      capability: string,
      operation: Parameters<typeof withTenantAs<T>>[3]
    ) => withTenantAs(db, tenant, capability, operation);
    const free = (label: string) =>
      createTenantFixture(admin.pool, label, "America/Sao_Paulo", "free");
    const effective = (tenant: TenantFixture) =>
      as(tenant, "product:update", (tx) =>
        getEffectiveEntitlements(tx, tenant)
      );
    const grantRows = async (tenant: TenantFixture) =>
      (
        await admin.pool.query<{
          expires_at: Date;
          granted_by: string;
          id: string;
          key: string;
          reason: string;
          revoked_at: Date | null;
          revoked_by: string | null;
          starts_at: Date;
        }>(
          "SELECT id, key, reason, granted_by, starts_at, expires_at, revoked_at, revoked_by FROM public.entitlement_grants WHERE organization_id = $1 ORDER BY created_at, id",
          [tenant.organizationId]
        )
      ).rows;
    const inDays = (days: number) => new Date(Date.now() + days * DAY_MS);
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

    // ------------------------------------------------ 1. who can write
    const plain = await free("grants tenant");
    for (const statement of [
      `INSERT INTO public.entitlement_grants (organization_id, key, limit_value, reason, granted_by, expires_at) VALUES ('${plain.organizationId}', 'variants.active.max', 1000, 'self-grant', 'tenant', now() + interval '1 day')`,
      "UPDATE public.entitlement_grants SET expires_at = expires_at + interval '1 day'",
      "DELETE FROM public.entitlement_grants",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: Three statements, in order.
      await expectSqlState(
        () =>
          withRuntimeSqlContext(runtimeUrl, plain, (client) =>
            client.query(statement)
          ),
        "42501",
        `the tenant cannot: ${statement.slice(0, 40)}`
      );
    }
    for (const statement of [
      "DELETE FROM public.entitlement_grants",
      "UPDATE public.entitlement_grants SET reason = 'x'",
      "UPDATE public.entitlement_grants SET limit_value = 9",
      "UPDATE public.entitlement_grants SET granted_by = 'someone'",
      "UPDATE public.entitlement_grants SET starts_at = now()",
      "UPDATE public.entitlement_grants SET organization_id = 'x'",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: Six statements, in order.
      await expectSqlState(
        () => asBillingClient((client) => client.query(statement)),
        "42501",
        `the billing role cannot: ${statement}`
      );
    }
    // what the tenant may read of its billing record and its grants: what the product shows, no more
    for (const statement of [
      "SELECT revoked_through FROM public.organization_billing",
      "SELECT revoked_reason FROM public.organization_billing",
      "SELECT revoked_cycle_months, revoked_cancel_at_period_end FROM public.organization_billing",
      "SELECT provider_ref FROM public.organization_billing",
      "SELECT last_fact_at FROM public.organization_billing",
      "SELECT * FROM public.organization_billing",
      "SELECT reason FROM public.entitlement_grants",
      "SELECT granted_by FROM public.entitlement_grants",
      "SELECT revoked_by FROM public.entitlement_grants",
      "SELECT * FROM public.entitlement_grants",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: Ten statements, in order.
      await expectSqlState(
        () =>
          withRuntimeSqlContext(runtimeUrl, plain, (client) =>
            client.query(statement)
          ),
        "42501",
        `the tenant cannot read: ${statement}`
      );
    }
    await withRuntimeSqlContext(runtimeUrl, plain, async (client) => {
      // what it needs to know where it stands is still readable
      await client.query(
        "SELECT organization_id, state, access_ends_at, cancel_at_period_end, cycle_months, pending_cycle_months, trial_started_at, over_limit_since, provider, version FROM public.organization_billing"
      );
      await client.query(
        "SELECT id, key, limit_value, flag_value, starts_at, expires_at, revoked_at FROM public.entitlement_grants"
      );
    });
    tests.push(
      "an organization cannot write, change or delete a grant, cannot read what the billing lifecycle keeps for itself (the provider reference, the clock of facts, the payments taken back, a grant's reason and who gave it) while it still reads what the product shows, and even the billing role can only give a grant and end it early: nothing else about a grant is editable and none is deleted"
    );

    // ------------------------------------------------ 2. what a grant must say
    const target = await free("grants target");
    const base = {
      actor: "admin:gate",
      expiresAt: inDays(30),
      key: "variants.active.max",
      organizationId: target.organizationId,
      reason: "Parceria de teste",
      value: 120,
    };
    for (const [label, change] of [
      ["no reason", { reason: "   " }],
      ["no actor", { actor: "" }],
      ["an actor that is not an identifier", { actor: "João da Silva" }],
      ["an end in the past", { expiresAt: inDays(-1) }],
      ["a grant that never ends (too long)", { expiresAt: inDays(400) }],
      ["a capability turned off", { key: "offline.write", value: false }],
      ["an unknown entitlement", { key: "everything", value: 1 }],
      ["a limit of zero", { value: 0 }],
      [
        "a grant shorter than a minute",
        { expiresAt: new Date(Date.now() + 20_000) },
      ],
      ["an actor that is an e-mail address", { actor: "ana@exemplo.com" }],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: Eight refusals, in order.
      await assert.rejects(
        () => billing.grantEntitlement({ ...base, ...change }),
        InvalidEntitlementGrantError,
        label
      );
    }
    assert.equal((await grantRows(target)).length, 0, "refusals leave nothing");
    // the database refuses what the command would never send
    await expectSqlState(
      () =>
        admin.pool.query(
          "INSERT INTO public.entitlement_grants (organization_id, key, limit_value, reason, granted_by, starts_at, expires_at) VALUES ($1, 'variants.active.max', 5, 'x', 'gate', now(), now() + interval '400 days')",
          [target.organizationId]
        ),
      "23514",
      "a grant longer than the longest",
      "entitlement_grants_period_allowed"
    );
    await expectSqlState(
      () =>
        admin.pool.query(
          "INSERT INTO public.entitlement_grants (organization_id, key, limit_value, reason, granted_by, starts_at, expires_at) VALUES ($1, 'variants.active.max', 5, 'x', '', now(), now() + interval '1 day')",
          [target.organizationId]
        ),
      "23514",
      "a grant without an actor",
      "entitlement_grants_actor_allowed"
    );
    tests.push(
      "a grant without a reason, an actor, a future end or a proper value is refused (and so is one that never ends), in the command and again in the database"
    );

    // ------------------------------------------------ 3. giving one
    const given = await billing.grantEntitlement(base);
    assert.equal(given.created, true);
    const [row] = await grantRows(target);
    assert.equal(row?.granted_by, "admin:gate");
    assert.equal(row?.reason, "Parceria de teste");
    assert.equal(row?.key, "variants.active.max");
    assert.ok(row && row.expires_at.getTime() > row.starts_at.getTime());
    const raised = await effective(target);
    assert.equal(raised.values["variants.active.max"], 120);
    assert.equal(raised.plan, "free", "a grant is not a subscription");
    assert.equal(raised.state, "free");
    assert.equal(raised.accessEndsAt, null);
    assert.deepEqual(raised.raisedByGrant, ["variants.active.max"]);
    const record = await billing.readRecord(target.organizationId);
    assert.equal(record?.state, "free", "billing state is untouched");
    // the same ID is the same grant; another organization cannot reuse it
    const again = await billing.grantEntitlement({ ...base, id: given.id });
    assert.deepEqual(again, { created: false, id: given.id });
    // a different grant under the same ID is refused, never silently dropped
    await assert.rejects(
      () => billing.grantEntitlement({ ...base, id: given.id, value: 130 }),
      ID_CONFLICT
    );
    await assert.rejects(
      () =>
        billing.grantEntitlement({
          ...base,
          id: given.id,
          reason: "outro motivo",
        }),
      ID_CONFLICT
    );
    const other = await free("grants other");
    await assert.rejects(
      () =>
        billing.grantEntitlement({
          ...base,
          id: given.id,
          organizationId: other.organizationId,
        }),
      ID_CONFLICT
    );
    assert.equal((await grantRows(target)).length, 1);
    // the ledger says that it happened and by whom, and keeps the reason out of it
    const ledger = await admin.pool.query<{
      fact: Record<string, string>;
      fact_type: string;
      state_after: string;
      state_before: string;
    }>(
      "SELECT fact, fact_type, state_before, state_after FROM public.billing_events WHERE organization_id = $1 ORDER BY received_at, id",
      [target.organizationId]
    );
    assert.equal(ledger.rows.length, 1);
    assert.equal(ledger.rows[0]?.fact_type, "command");
    assert.equal(ledger.rows[0]?.fact.type, "grant_entitlement");
    assert.equal(ledger.rows[0]?.fact.actor, "admin:gate");
    assert.equal(ledger.rows[0]?.fact.grantId, given.id);
    assert.ok(
      !JSON.stringify(ledger.rows[0]?.fact).includes("Parceria"),
      "the reason stays with the grant"
    );
    assert.equal(ledger.rows[0]?.state_before, ledger.rows[0]?.state_after);
    tests.push(
      "a grant raises the entitlements of a Free organization without becoming a subscription or touching its billing state, giving the same ID twice is one grant (another organization cannot take it), and the ledger records it with who and for how long but without the reason"
    );

    // ------------------------------------------------ 4. when it counts
    const future = await free("grants future");
    await billing.grantEntitlement({
      ...base,
      expiresAt: inDays(30),
      organizationId: future.organizationId,
      startsAt: inDays(2),
    });
    assert.equal(
      (await effective(future)).values["variants.active.max"],
      50,
      "not started: nothing changes"
    );
    await admin.pool.query(
      "UPDATE public.entitlement_grants SET starts_at = now() - interval '1 day' WHERE organization_id = $1",
      [future.organizationId]
    );
    assert.equal((await effective(future)).values["variants.active.max"], 120);
    await admin.pool.query(
      "UPDATE public.entitlement_grants SET starts_at = now() - interval '5 days', expires_at = now() - interval '1 minute' WHERE organization_id = $1",
      [future.organizationId]
    );
    assert.equal(
      (await effective(future)).values["variants.active.max"],
      50,
      "expired: back to the plan"
    );
    const flag = await free("grants flag");
    await billing.grantEntitlement({
      ...base,
      key: "offline.write",
      organizationId: flag.organizationId,
      value: true,
    });
    assert.equal((await effective(flag)).values["offline.write"], true);
    tests.push(
      "a grant counts only between its start and its end (a capability grant too)"
    );

    // ------------------------------------------------ 5. ending one early
    const revoked = await billing.revokeEntitlementGrant({
      actor: "admin:other",
      id: given.id,
    });
    assert.deepEqual(revoked, { revoked: true });
    assert.equal((await effective(target)).values["variants.active.max"], 50);
    const [ended] = await grantRows(target);
    assert.equal(ended?.revoked_by, "admin:other");
    assert.ok(ended?.revoked_at);
    assert.ok(
      ended.expires_at.getTime() <= Date.now() + 2000,
      "it ends when it was revoked"
    );
    assert.deepEqual(
      await billing.revokeEntitlementGrant({
        actor: "admin:other",
        id: given.id,
      }),
      { revoked: false },
      "ending one twice is one ending"
    );
    await assert.rejects(
      () => billing.revokeEntitlementGrant({ actor: "", id: given.id }),
      InvalidEntitlementGrantError
    );
    // the database never lets a grant be extended or un-revoked, by anyone
    await expectSqlState(
      () =>
        asBillingClient((client) =>
          client.query(
            "UPDATE public.entitlement_grants SET expires_at = expires_at + interval '1 day' WHERE id = $1",
            [given.id]
          )
        ),
      "23514",
      "a grant cannot be extended"
    );
    await expectSqlState(
      () =>
        asBillingClient((client) =>
          client.query(
            "UPDATE public.entitlement_grants SET revoked_at = NULL, revoked_by = NULL WHERE id = $1",
            [given.id]
          )
        ),
      "23514",
      "a revoked grant stays revoked"
    );
    await expectSqlState(
      () =>
        admin.pool.query(
          "UPDATE public.entitlement_grants SET expires_at = expires_at + interval '1 day' WHERE id = $1",
          [given.id]
        ),
      "23514",
      "not even the owner extends a grant"
    );
    // a grant that has not started ends as soon as the table allows
    const notStarted = await billing.grantEntitlement({
      ...base,
      organizationId: flag.organizationId,
      startsAt: inDays(5),
    });
    assert.equal(
      (
        await billing.revokeEntitlementGrant({
          actor: "admin:other",
          id: notStarted.id,
        })
      ).revoked,
      true
    );
    assert.equal((await effective(flag)).values["variants.active.max"], 50);
    tests.push(
      "ending a grant early records who and when, it stops counting, ending it twice is one ending, and a grant that had not started ends as soon as it could"
    );

    // ------------------------------------------------ 6. what its end causes
    const overLimit = async (label: string) => {
      const org = await createTenantFixture(admin.pool, label);
      await as(org, "product:create", (tx, identity) =>
        inSequence(51, () =>
          createProduct(tx, identity, { name: `G ${randomUUID()}` })
        )
      );
      // a plain Free record (the plan ended) that holds more than Free allows
      await admin.pool.query(
        "UPDATE public.organization_billing SET state = 'free', access_ends_at = NULL, cancel_at_period_end = false, cycle_months = NULL, pending_cycle_months = NULL WHERE organization_id = $1",
        [org.organizationId]
      );
      return org;
    };
    const endGrant = async (org: TenantFixture, hoursAgo: number) => {
      const made = await billing.grantEntitlement({
        ...base,
        organizationId: org.organizationId,
        value: 100,
      });
      await admin.pool.query(
        "UPDATE public.entitlement_grants SET starts_at = now() - interval '10 days', expires_at = now() - make_interval(secs => $2) WHERE id = $1",
        [made.id, hoursAgo * 3600]
      );
      return made;
    };
    const stateOf = async (org: TenantFixture) =>
      (
        await admin.pool.query<{ since: Date | null; state: string }>(
          "SELECT state, over_limit_since AS since FROM public.organization_billing WHERE organization_id = $1",
          [org.organizationId]
        )
      ).rows[0] as { since: Date | null; state: string };

    const lapsed = await overLimit("grants lapsed");
    await endGrant(lapsed, 1);
    const stillGranted = await overLimit("grants still granted");
    await billing.grantEntitlement({
      ...base,
      organizationId: stillGranted.organizationId,
      value: 100,
    });
    const within = await free("grants within");
    await endGrant(within, 1);
    const paying = await createTenantFixture(admin.pool, "grants paying");
    await endGrant(paying, 1);

    const swept = await billing.sweepDue(new Date());
    assert.ok(swept.transitioned >= 1);
    const lapsedState = await stateOf(lapsed);
    assert.equal(
      lapsedState.state,
      "free_over_limit",
      "holding more than Free allows after the grant ended"
    );
    const [lapsedGrant] = await grantRows(lapsed);
    assert.ok(
      lapsedState.since &&
        lapsedGrant &&
        Math.abs(
          lapsedState.since.getTime() - lapsedGrant.expires_at.getTime()
        ) < 1000,
      "the window starts when the grant ended"
    );
    const window = await as(lapsed, "product:update", (tx, identity) =>
      readOperationalSelection(tx, identity)
    );
    assert.equal(window.phase, "adapting");
    assert.equal(window.liveVariants, 51);
    assert.equal((await stateOf(stillGranted)).state, "free");
    assert.equal((await stateOf(within)).state, "free");
    assert.equal((await stateOf(paying)).state, "active");
    // again changes nothing, and the ledger shows one transition
    const sweptAgain = await billing.sweepDue(new Date());
    assert.equal(sweptAgain.failed, 0);
    assert.deepEqual(await stateOf(lapsed), lapsedState);
    const transitions = await admin.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM public.billing_events WHERE organization_id = $1 AND fact->>'transition' = 'grant_expired'",
      [lapsed.organizationId]
    );
    assert.equal(Number(transitions.rows[0]?.count), 1);

    // an organization already over the limits gets a new window when the grant that lifted it ends
    const renewed = await overLimit("grants renewed window");
    await admin.pool.query(
      "UPDATE public.organization_billing SET state = 'free_over_limit', over_limit_since = now() - interval '20 days' WHERE organization_id = $1",
      [renewed.organizationId]
    );
    await endGrant(renewed, 2);
    await billing.sweepDue(new Date());
    const renewedState = await stateOf(renewed);
    const [renewedGrant] = await grantRows(renewed);
    assert.equal(renewedState.state, "free_over_limit");
    assert.ok(
      renewedState.since &&
        renewedGrant &&
        Math.abs(
          renewedState.since.getTime() - renewedGrant.expires_at.getTime()
        ) < 1000,
      "a fresh window from the end of the grant"
    );
    // a `free_over_limit` record without a start is still a candidate (NULL must not drop it); one already dated after the end is not
    const undated = await overLimit("grants undated window");
    await admin.pool.query(
      "UPDATE public.organization_billing SET state = 'free_over_limit', over_limit_since = NULL WHERE organization_id = $1",
      [undated.organizationId]
    );
    await endGrant(undated, 3);
    const dated = await overLimit("grants dated after the end");
    await admin.pool.query(
      "UPDATE public.organization_billing SET state = 'free_over_limit', over_limit_since = now() - interval '1 hour' WHERE organization_id = $1",
      [dated.organizationId]
    );
    await endGrant(dated, 5);
    const versionOf = async (org: TenantFixture) =>
      (
        await admin.pool.query<{ version: string }>(
          "SELECT version::text AS version FROM public.organization_billing WHERE organization_id = $1",
          [org.organizationId]
        )
      ).rows[0]?.version;
    const datedBefore = await stateOf(dated);
    const datedVersion = await versionOf(dated);
    await billing.sweepDue(new Date());
    const undatedState = await stateOf(undated);
    const [undatedGrant] = await grantRows(undated);
    assert.equal(undatedState.state, "free_over_limit");
    assert.ok(
      undatedState.since &&
        undatedGrant &&
        Math.abs(
          undatedState.since.getTime() - undatedGrant.expires_at.getTime()
        ) < 1000,
      "a record over the limits without a start is dated by the end of the grant"
    );
    assert.deepEqual(
      await stateOf(dated),
      datedBefore,
      "a window that began after the end of the grant is left as it is"
    );
    assert.equal(
      await versionOf(dated),
      datedVersion,
      "and it is not written again"
    );
    tests.push(
      "a free_over_limit record without a start is still picked by the sweep and dated by the end of the grant, while one whose window began after that end is left alone"
    );
    // limit by limit: a grant for another limit that still runs does not hide the one that ended
    const mixed = await overLimit("grants mixed keys");
    await endGrant(mixed, 2);
    await billing.grantEntitlement({
      ...base,
      key: "goals.active.max",
      organizationId: mixed.organizationId,
      value: 5,
    });
    await billing.sweepDue(new Date());
    const mixedState = await stateOf(mixed);
    const [mixedGrant] = (await grantRows(mixed)).filter(
      (entry) => entry.key === "variants.active.max"
    );
    assert.equal(mixedState.state, "free_over_limit");
    assert.ok(
      mixedState.since &&
        mixedGrant &&
        Math.abs(mixedState.since.getTime() - mixedGrant.expires_at.getTime()) <
          1000,
      "dated by the end of the grant for the limit that is exceeded"
    );

    // newest first: a run that cannot look at everyone still examines the freshest end
    for (const index of [1, 2, 3]) {
      // biome-ignore lint/performance/noAwaitInLoops: Three organizations, in order.
      const old = await free(`grants old ${index}`);
      await endGrant(old, 72);
    }
    const freshest = await overLimit("grants freshest");
    await endGrant(freshest, 0.5);
    // more candidates than the run can look at: three old ones and the recent ends of the sections above
    const limited = await billing.sweepDue(new Date(), 5);
    assert.equal(limited.failed, 0);
    assert.equal(
      (await stateOf(freshest)).state,
      "free_over_limit",
      "the newest end is examined first, behind older ones that need nothing"
    );

    tests.push(
      "the end of a limit grant puts a Free organization that holds more than Free allows into the adaptation window (dated by the end of the grant, once), and gives one already over the limits a fresh window, while one still inside a grant, one within the limits and a paying one are left alone"
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
    `Entitlement grants PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
