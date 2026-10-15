import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  assertFlag,
  assertWithinLimit,
  EntitlementDeniedError,
  EntitlementLimitReachedError,
  INITIAL_PLAN_CATALOG,
} from "@polaris/domain/billing/entitlements";
import {
  getEffectiveEntitlements,
  listBillingPrices,
  listPlans,
  readPlanCatalog,
} from "../src/billing-repository";
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
  withTenantAs,
} from "./sales-gate-support";

/**
 * Plan catalog, billing state and effective entitlements (plan PR72, PR73 and
 * PR76) on a real PostgreSQL 18: the seeded catalog equals the domain's initial
 * catalog, the runtime can only read it, the billing record cannot say
 * something incoherent, and entitlements are derived per organization from the
 * database clock.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const globalTables = [
  "billing_plans",
  "billing_prices",
  "plan_entitlements",
] as const;
const tenantTables = ["organization_billing", "entitlement_grants"] as const;

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

    const tenantA: TenantFixture = await createTenantFixture(
      admin.pool,
      "billing A",
      "America/Sao_Paulo",
      "free"
    );
    const tenantB: TenantFixture = await createTenantFixture(
      admin.pool,
      "billing B",
      "America/Sao_Paulo",
      "free"
    );
    loginRole = `polaris_billing_gate_${randomUUID().replaceAll("-", "")}`;
    const loginPassword = randomBytes(24).toString("hex");
    await admin.pool.query(
      `CREATE ROLE "${loginRole}" WITH LOGIN INHERIT PASSWORD '${loginPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
    );
    await admin.pool.query(`GRANT "${runtimeRole}" TO "${loginRole}"`);
    const runtimeUrl = temporaryRuntimeUrl(adminUrl, loginRole, loginPassword);
    const runtimeDatabase = createDatabase(runtimeUrl, { maxConnections: 5 });
    runtime = runtimeDatabase;
    const { db } = runtimeDatabase;
    const asMember = <T>(
      tenant: TenantFixture,
      operation: Parameters<typeof withTenantAs<T>>[3]
    ) => withTenantAs(db, tenant, "goal:manage", operation);
    const entitlementsOf = (tenant: TenantFixture) =>
      asMember(tenant, (tx, identity) =>
        getEffectiveEntitlements(tx, identity)
      );

    // ------------------------------------------- 1. the seeded catalog
    const stored = await asMember(tenantA, (tx) => readPlanCatalog(tx));
    assert.deepEqual(
      stored,
      INITIAL_PLAN_CATALOG,
      "the database seed equals the domain's initial catalog"
    );
    const plans = await asMember(tenantA, (tx) => listPlans(tx));
    assert.deepEqual(
      plans.map((plan) => plan.id),
      ["free", "pro"]
    );
    const prices = await asMember(tenantA, (tx) => listBillingPrices(tx));
    assert.deepEqual(
      prices.map((price) => [price.id, price.intervalMonths, price.amount]),
      [
        ["pro_monthly", 1, "24.90"],
        ["pro_semiannual", 6, "124.50"],
        ["pro_annual", 12, "249.00"],
      ]
    );
    tests.push(
      "the seeded Free/Pro catalog and the three Pro prices equal the domain's initial catalog and PRODUCT.md"
    );

    // ----------------------------------- 2. the runtime only reads it
    const writes: [string, string][] = [
      [
        "billing_plans",
        "INSERT INTO public.billing_plans (id, name) VALUES ('free', 'x')",
      ],
      ["billing_plans", "UPDATE public.billing_plans SET name = 'x'"],
      ["billing_plans", "DELETE FROM public.billing_plans"],
      [
        "billing_prices",
        "UPDATE public.billing_prices SET amount = 1.00 WHERE id = 'pro_monthly'",
      ],
      ["billing_prices", "DELETE FROM public.billing_prices"],
      [
        "plan_entitlements",
        "UPDATE public.plan_entitlements SET limit_value = 1000000 WHERE key = 'variants.active.max'",
      ],
      ["plan_entitlements", "DELETE FROM public.plan_entitlements"],
      [
        "organization_billing",
        `INSERT INTO public.organization_billing (organization_id, state, access_ends_at) VALUES ('${tenantA.organizationId}', 'active', now() + interval '30 days')`,
      ],
      [
        "organization_billing",
        "UPDATE public.organization_billing SET state = 'active'",
      ],
      ["organization_billing", "DELETE FROM public.organization_billing"],
      [
        "entitlement_grants",
        `INSERT INTO public.entitlement_grants (organization_id, key, flag_value, reason, expires_at) VALUES ('${tenantA.organizationId}', 'public_catalog', true, 'self-grant', now() + interval '30 days')`,
      ],
      ["entitlement_grants", "DELETE FROM public.entitlement_grants"],
    ];
    await Promise.all(
      writes.map(([table, statement]) =>
        expectSqlState(
          () =>
            withRuntimeSqlContext(runtimeUrl, tenantA, (client) =>
              client.query(statement)
            ),
          "42501",
          `the runtime cannot write ${table}: ${statement.slice(0, 40)}`
        )
      )
    );
    const rls = await admin.pool.query<{
      forced: boolean;
      relname: string;
      rls: boolean;
    }>(
      `SELECT relname, relrowsecurity AS rls, relforcerowsecurity AS forced
         FROM pg_class
        WHERE relnamespace = 'public'::regnamespace
          AND relname = ANY($1)`,
      [[...globalTables, ...tenantTables]]
    );
    assert.equal(rls.rows.length, 5);
    for (const row of rls.rows) {
      assert.ok(row.rls && row.forced, `${row.relname} forces row security`);
    }
    tests.push(
      "the runtime role cannot insert, update or delete the catalog, a billing state or a grant (its own plan upgrade included), and every billing table forces row security"
    );

    // ------------------------- 3. the database refuses an incoherent record
    const insertBilling = (
      organizationId: string,
      state: string,
      accessEndsIn: string | null
    ) =>
      admin.pool.query(
        `INSERT INTO public.organization_billing (organization_id, state, access_ends_at, trial_started_at)
         VALUES ($1, $2, ${accessEndsIn === null ? "NULL" : `now() + interval '${accessEndsIn}'`}, CASE WHEN $2 = 'trialing' THEN now() END)`,
        [organizationId, state]
      );
    await expectSqlState(
      () => insertBilling(tenantA.organizationId, "trialing", null),
      "23514",
      "Pro access without an end date"
    );
    await expectSqlState(
      () =>
        admin.pool.query(
          "INSERT INTO public.organization_billing (organization_id, state, access_ends_at) VALUES ($1, 'trialing', now() + interval '7 days')",
          [tenantA.organizationId]
        ),
      "23514",
      "a trial that does not record when it started",
      "organization_billing_trial_recorded"
    );
    await expectSqlState(
      () =>
        admin.pool.query(
          "INSERT INTO public.billing_prices (id, plan_id, interval_months, amount) VALUES ('dup', 'pro', 1, 19.90)"
        ),
      "23505",
      "a second live price for the same plan and interval",
      "billing_prices_active_unique"
    );
    await expectSqlState(
      () => insertBilling(tenantA.organizationId, "free", "1 day"),
      "23514",
      "a free state with an end date",
      "organization_billing_access_coherent"
    );
    await expectSqlState(
      () => insertBilling(tenantA.organizationId, "platinum", null),
      "23514",
      "an unknown state"
    );
    await expectSqlState(
      () =>
        admin.pool.query(
          "INSERT INTO public.plan_entitlements (plan_id, key, limit_value) VALUES ('free', 'public_catalog', 1)"
        ),
      "23514",
      "a flag key holding a limit",
      "plan_entitlements_key_value_coherent"
    );
    await expectSqlState(
      () =>
        admin.pool.query(
          "INSERT INTO public.plan_entitlements (plan_id, key, limit_value) VALUES ('free', 'unknown.key', 1)"
        ),
      "23514",
      "an unknown entitlement key",
      "plan_entitlements_key_value_coherent"
    );
    await expectSqlState(
      () =>
        admin.pool.query(
          "INSERT INTO public.billing_prices (id, plan_id, interval_months, amount) VALUES ('x', 'pro', 3, 10.00)"
        ),
      "23514",
      "an interval outside month/semester/year",
      "billing_prices_interval_allowed"
    );
    await expectSqlState(
      () =>
        admin.pool.query(
          "INSERT INTO public.billing_prices (id, plan_id, interval_months, amount) VALUES ('x', 'pro', 1, 10.005)"
        ),
      "23514",
      "a price with three places",
      "billing_prices_amount_allowed"
    );
    await expectSqlState(
      () =>
        admin.pool.query(
          "INSERT INTO public.billing_prices (id, plan_id, interval_months, amount) VALUES ('x', 'free', 1, 10.00)"
        ),
      "23514",
      "the free plan has no price",
      "billing_prices_paid_plan"
    );
    await expectSqlState(
      () =>
        admin.pool.query(
          `INSERT INTO public.entitlement_grants (organization_id, key, limit_value, reason, expires_at)
           VALUES ($1, 'variants.active.max', 10, '  ', now() + interval '1 day')`,
          [tenantA.organizationId]
        ),
      "23514",
      "a grant without a reason",
      "entitlement_grants_reason_allowed"
    );
    tests.push(
      "the database refuses Pro without an end date, a trial that does not record its start, a second live price for an interval, a free state with one, unknown states and keys, mismatched value kinds, odd prices and a reasonless grant"
    );

    // ------------------------------------- 4. entitlements per organization
    const free = await entitlementsOf(tenantA);
    assert.equal(free.plan, "free");
    assert.equal(free.state, "free");
    assert.equal(free.values["variants.active.max"], 50);
    assert.equal(free.accessEndsAt, null);
    assert.throws(
      () => assertFlag(free, "offline.write"),
      EntitlementDeniedError
    );
    assert.throws(
      () => assertWithinLimit(free, "goals.active.max", 1),
      EntitlementLimitReachedError
    );
    tests.push("an organization with no billing record is on Free");

    await insertBilling(tenantA.organizationId, "trialing", "7 days");
    const pro = await entitlementsOf(tenantA);
    assert.equal(pro.plan, "pro");
    assert.equal(pro.state, "trialing");
    assert.equal(pro.values["variants.active.max"], 2000);
    assert.ok(pro.accessEndsAt instanceof Date);
    assertFlag(pro, "offline.write");
    const otherOrganization = await entitlementsOf(tenantB);
    assert.equal(
      otherOrganization.plan,
      "free",
      "another organization's trial does not leak"
    );
    tests.push(
      "a running trial gives Pro to its own organization only, and the end date comes from the record"
    );

    // a period that ran out counts as Free even if the record was not updated
    await admin.pool.query(
      "UPDATE public.organization_billing SET state = 'active', access_ends_at = now() - interval '1 minute' WHERE organization_id = $1",
      [tenantA.organizationId]
    );
    const lapsed = await entitlementsOf(tenantA);
    assert.equal(lapsed.plan, "free");
    assert.equal(lapsed.state, "active", "the record keeps what it says");
    assert.equal(lapsed.accessEndsAt, null);
    tests.push(
      "access past its end counts as Free at the database clock, with no sweep needed"
    );

    // the downgrade state restricts without deleting
    await admin.pool.query(
      "UPDATE public.organization_billing SET state = 'free_over_limit', access_ends_at = NULL WHERE organization_id = $1",
      [tenantA.organizationId]
    );
    const over = await entitlementsOf(tenantA);
    assert.equal(over.plan, "free");
    assert.equal(over.overLimit, true);
    tests.push("free_over_limit is Free with the over-limit mark");

    // temporary grants raise, expire and stay inside their organization
    await admin.pool.query(
      `INSERT INTO public.entitlement_grants (organization_id, key, limit_value, reason, expires_at)
       VALUES ($1, 'variants.active.max', 120, 'support', now() + interval '1 day'),
              ($1, 'images.active.max', 9999, 'expired promotion', now() - interval '1 minute'),
              ($1, 'goals.active.max', 0, 'lowering', now() + interval '1 day')`,
      [tenantA.organizationId]
    );
    await admin.pool.query(
      `INSERT INTO public.entitlement_grants (organization_id, key, flag_value, reason, expires_at)
       VALUES ($1, 'public_catalog', true, 'support', now() + interval '1 day')`,
      [tenantA.organizationId]
    );
    const granted = await entitlementsOf(tenantA);
    assert.equal(granted.values["variants.active.max"], 120);
    assert.equal(granted.values.public_catalog, true);
    assert.equal(granted.values["images.active.max"], 50, "expired grant");
    assert.equal(granted.values["goals.active.max"], 1, "a grant never lowers");
    assert.deepEqual([...granted.raisedByGrant].sort(), [
      "public_catalog",
      "variants.active.max",
    ]);
    const otherGranted = await entitlementsOf(tenantB);
    assert.equal(otherGranted.values["variants.active.max"], 50);
    tests.push(
      "a temporary grant raises one entitlement for its organization until it expires, and never lowers one"
    );

    // row security scopes the tenant tables to the active organization
    const visible = await withRuntimeSqlContext(
      runtimeUrl,
      tenantB,
      async (client) => {
        const billing = await client.query(
          "SELECT organization_id FROM public.organization_billing"
        );
        const grants = await client.query(
          "SELECT organization_id FROM public.entitlement_grants"
        );
        return [billing.rowCount, grants.rowCount];
      }
    );
    assert.deepEqual(visible, [0, 0], "B sees none of A's billing or grants");
    tests.push(
      "an organization sees neither another organization's billing record nor its grants through plain SQL"
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
    if (runtime) {
      await runtime.pool.end();
    }
    if (loginRole) {
      await admin.pool.query(`REVOKE "${runtimeRole}" FROM "${loginRole}"`);
      await admin.pool.query(`DROP ROLE IF EXISTS "${loginRole}"`);
    }
    await admin.pool.end();
  }
}

run().catch((error: unknown) => {
  console.error(
    `Billing catalog PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
