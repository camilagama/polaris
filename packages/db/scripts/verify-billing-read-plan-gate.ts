// biome-ignore-all lint/performance/noAwaitInLoops: a gate runs its probes strictly one at a time, for a clear failure
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { type BillingStore, createBillingStore } from "../src/billing-store";
import { createDatabase } from "../src/client";
import { readOwnerPlanTenantFacts } from "../src/plan-read-repository";
import { archiveProduct, deleteProduct } from "../src/product-repository";
import { TenantAuthorizationError } from "../src/tenant-transaction";
import {
  confirmPlainSale,
  createProductFixture,
  createSellableProduct,
  createTenantFixture,
  disposableHostPattern,
  gateBranchPattern,
  journalMigrationCount,
  poolerPattern,
  redactedFailure,
  requiredEnvironment,
  sqlState,
  runtimeRole,
  type TenantFixture,
  temporaryRuntimeUrl,
  withTenantAs,
} from "./sales-gate-support";

/**
 * The owner's read of the plan (`billing.readPlan`, ADR 0104 decision 2, PR C of design t268 v2) on a real
 * PostgreSQL 18:
 *   1. the tenant's part, as the tenant role with `billing:manage`: the usage counted as the writes count it (an
 *      archived product's variants and images count, a deleted one's do not), what the store keeps, the active prices
 *      and the effective limits raised by a grant (AS-1, AS-4, AS-5, AS-24), compared with SQL of its own; it never
 *      needs the columns of migration 0100, which the tenant cannot read;
 *   2. someone who is not a member and an organization that does not exist are refused alike (`tenant_access_denied`);
 *   3. the billing role's part: the record of each state, with the columns of 0100 as text and dates, and the trial
 *      of the organization and of the person (AS-12).
 * The fixtures stay, as in the other gates; the logins are dropped at the end.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const DAY = 86_400_000;
const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

async function run() {
  const branch = requiredEnvironment("POLARIS_SALES_GATE_BRANCH");
  assert.match(branch, gateBranchPattern);
  const adminUrl = requiredEnvironment("POLARIS_SALES_GATE_DATABASE_URL");
  const parsedAdminUrl = new URL(adminUrl);
  assert.match(parsedAdminUrl.hostname, disposableHostPattern);
  assert.doesNotMatch(parsedAdminUrl.hostname, poolerPattern);

  const owner = createDatabase(adminUrl, { maxConnections: 4 });
  const logins: [string, string][] = [];
  const tests: string[] = [];
  let runtime: ReturnType<typeof createDatabase> | undefined;
  let store: BillingStore | undefined;

  try {
    const server = await owner.pool.query<{
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
    const migrations = await owner.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations"
    );
    assert.equal(Number(migrations.rows[0]?.count), journalMigrationCount());
    tests.push(
      "disposable direct connection is PostgreSQL 18 with every migration replayed from scratch"
    );

    const login = async (group: string, prefix: string) => {
      const role = `${prefix}_${randomUUID().replaceAll("-", "")}`;
      const password = randomBytes(24).toString("hex");
      await owner.pool.query(
        `CREATE ROLE "${role}" WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`
      );
      await owner.pool.query(`GRANT "${group}" TO "${role}"`);
      logins.push([role, group]);
      return temporaryRuntimeUrl(adminUrl, role, password);
    };
    runtime = createDatabase(
      await login(runtimeRole, "polaris_read_plan_tenant"),
      { maxConnections: 4 }
    );
    const { db } = runtime;
    store = createBillingStore(
      await login("polaris_billing_runtime", "polaris_read_plan_billing")
    );
    const billing = store;
    const suffix = randomUUID().slice(0, 8);
    const newTenant = (label: string) =>
      createTenantFixture(
        owner.pool,
        `read plan ${label} ${suffix}`,
        "America/Sao_Paulo",
        "free"
      );

    // ------------------------------------------------ 1. the tenant's part: usage, kept, prices, limits
    const shop = await newTenant("usage");
    const sold = await createSellableProduct(
      { adminPool: owner.pool, db },
      shop,
      `vendido ${suffix}`,
      { cost: "10.00", quantity: 10 }
    );
    const archived = await createProductFixture(
      db,
      shop,
      `arquivado ${suffix}`
    );
    const deleted = await createProductFixture(db, shop, `apagado ${suffix}`);
    // two images of the product sold, one of the one to archive and one of the one to delete (which will no longer count)
    for (const productId of [
      sold.productId,
      sold.productId,
      archived.productId,
      deleted.productId,
    ]) {
      const uploadCommandId = randomUUID();
      const fingerprint = createHash("sha256")
        .update(randomUUID())
        .digest("hex");
      // one statement: the asset must be linked to its product before the transaction ends (deferred trigger)
      await owner.pool.query(
        `WITH asset AS (
           INSERT INTO public.media_assets
             (organization_id, byte_size, content_type, height, input_fingerprint, storage_key, upload_command_id, width)
           VALUES ($1, 4, 'image/webp', 2, $3, $4, $5, 2) RETURNING id
         )
         INSERT INTO public.product_media (organization_id, product_id, media_asset_id, position)
         SELECT $1, $2, asset.id, (SELECT count(*) FROM public.product_media WHERE product_id = $2) FROM asset`,
        [
          shop.organizationId,
          productId,
          fingerprint,
          `media/v2/${shop.organizationId}/${productId}/${uploadCommandId}/${fingerprint}/${randomUUID()}.webp`,
          uploadCommandId,
        ]
      );
    }
    await withTenantAs(db, shop, "product:update", (transaction, identity) =>
      archiveProduct(transaction, identity, {
        expectedVersion: 1,
        id: archived.productId,
      })
    );
    await withTenantAs(db, shop, "product:update", (transaction, identity) =>
      deleteProduct(transaction, identity, {
        expectedVersion: 1,
        id: deleted.productId,
      })
    );
    await confirmPlainSale({ adminPool: owner.pool, db }, shop, [
      { quantity: 1, variantId: sold.variantId },
    ]);
    await confirmPlainSale({ adminPool: owner.pool, db }, shop, [
      { quantity: 2, variantId: sold.variantId },
    ]);
    const read = (tenant: TenantFixture) =>
      withTenantAs(db, tenant, "billing:manage", (transaction, identity) =>
        readOwnerPlanTenantFacts(transaction, {
          organizationId: identity.organizationId,
        })
      );
    const facts = await read(shop);
    // what the database itself counts, by queries of the gate's own
    const {
      rows: [counted],
    } = await owner.pool.query<{
      goals: number;
      history_months: number;
      images: number;
      products: number;
      sales: number;
      variants: number;
    }>(
      `SELECT
           (SELECT count(*)::int FROM public.product_variants v
              JOIN public.products p ON p.organization_id = v.organization_id AND p.id = v.product_id
             WHERE v.organization_id = $1 AND p.deleted_at IS NULL) AS variants,
           (SELECT count(*)::int FROM public.product_media m
              JOIN public.products p ON p.organization_id = m.organization_id AND p.id = m.product_id
             WHERE m.organization_id = $1 AND p.deleted_at IS NULL) AS images,
           (SELECT count(*)::int FROM public.goals WHERE organization_id = $1 AND status = 'active') AS goals,
           (SELECT count(*)::int FROM public.sales WHERE organization_id = $1) AS sales,
           (SELECT count(DISTINCT to_char(occurred_on, 'YYYY-MM'))::int FROM public.sales WHERE organization_id = $1)
             AS history_months,
           (SELECT count(*)::int FROM public.products WHERE organization_id = $1 AND deleted_at IS NULL) AS products`,
      [shop.organizationId]
    );
    assert.ok(counted);
    assert.deepEqual(facts.usage, {
      goals: counted.goals,
      images: counted.images,
      variants: counted.variants,
    });
    assert.deepEqual(facts.usage, { goals: 0, images: 3, variants: 2 });
    assert.deepEqual(facts.kept, {
      historyMonths: counted.history_months,
      products: counted.products,
      sales: counted.sales,
    });
    assert.equal(facts.kept.sales, 2);
    assert.equal(facts.kept.products, 2);
    assert.ok(facts.kept.historyMonths >= 1 && facts.kept.historyMonths <= 2);
    // the tenant's part never needed the columns of 0100: the tenant role still cannot read them
    for (const column of [
      "first_charge_amount",
      "first_charge_at",
      "first_charge_on",
      "price_amount",
      "price_id",
      "refund_request_id",
      "refund_requested_at",
    ]) {
      const privilege = await owner.pool.query<{ allowed: boolean }>(
        "SELECT has_column_privilege($1, 'public.organization_billing', $2, 'SELECT') AS allowed",
        [runtimeRole, column]
      );
      assert.equal(
        privilege.rows[0]?.allowed,
        false,
        `the tenant reads ${column}`
      );
    }
    await assert.rejects(
      withTenantAs(db, shop, "billing:manage", (transaction) =>
        transaction.execute(
          sql`SELECT price_amount FROM public.organization_billing`
        )
      ),
      (error: unknown) => sqlState(error) === "42501"
    );
    tests.push(
      "the usage is counted as assertRoomFor counts it (archived counts, deleted does not) and what the store keeps matches SQL of its own"
    );

    const activePrices = (
      await owner.pool.query<{
        amount: string;
        interval_months: number;
        plan_id: string;
      }>(
        "SELECT amount::text, interval_months, plan_id FROM public.billing_prices WHERE active ORDER BY interval_months"
      )
    ).rows;
    assert.deepEqual(
      facts.prices.map((price) => [
        price.planId,
        price.intervalMonths,
        price.amount,
      ]),
      activePrices.map((price) => [
        price.plan_id,
        price.interval_months,
        price.amount,
      ])
    );
    assert.ok(
      !facts.prices.some((price) => price.intervalMonths === 6),
      "the semiannual price is not sold"
    );
    tests.push("the prices are the active rows of billing_prices (AS-5)");

    const freeLimits = facts.entitlements.values;
    assert.equal(facts.entitlements.plan, "free");
    await owner.pool.query(
      `INSERT INTO public.entitlement_grants (organization_id, key, limit_value, reason, granted_by, expires_at)
       VALUES ($1, 'variants.active.max', $2, 'read plan gate', 'gate', now() + interval '1 day')`,
      [shop.organizationId, freeLimits["variants.active.max"] + 25]
    );
    const granted = await read(shop);
    assert.equal(
      granted.entitlements.values["variants.active.max"],
      freeLimits["variants.active.max"] + 25,
      "a grant raises the limit the owner reads (AS-4)"
    );
    assert.equal(
      granted.entitlements.values["images.active.max"],
      freeLimits["images.active.max"]
    );
    tests.push("the limits read are the effective ones, raised by a grant");

    // ------------------------------------------------ 2. refusals: not a member and no organization, alike
    const stranger = await newTenant("stranger");
    const refusalOf = async (organizationId: string) => {
      try {
        await withTenantAs(
          db,
          { organizationId, userId: stranger.userId },
          "billing:manage",
          (transaction, identity) =>
            readOwnerPlanTenantFacts(transaction, {
              organizationId: identity.organizationId,
            })
        );
      } catch (error: unknown) {
        assert.ok(error instanceof TenantAuthorizationError);
        return error.code;
      }
      assert.fail("the read was not refused");
    };
    assert.equal(await refusalOf(shop.organizationId), "tenant_access_denied");
    assert.equal(await refusalOf(randomUUID()), "tenant_access_denied");
    tests.push(
      "someone who is not a member and an organization that does not exist are refused with the same code"
    );

    // ------------------------------------------------ 3. the billing role's part: the record of each state
    const empty = await billing.readOwnerPlan(shop.organizationId, shop.userId);
    assert.deepEqual(empty, {
      accessEndsAt: null,
      cancelAtPeriodEnd: false,
      cycleMonths: null,
      firstChargeAmount: null,
      firstChargeAt: null,
      firstChargeOn: null,
      priceAmount: null,
      provider: null,
      refundRequestedAt: null,
      revoked: null,
      state: "free",
      trialAvailable: true,
    });
    await owner.pool.query(
      "INSERT INTO public.billing_trial_claims (user_id, organization_id, reserved_at, consumed_at) VALUES ($1, $2, now(), now())",
      [shop.userId, stranger.organizationId]
    );
    assert.equal(
      (await billing.readOwnerPlan(shop.organizationId, shop.userId))
        .trialAvailable,
      false,
      "a person whose trial was consumed elsewhere has none here"
    );
    const reserved = await newTenant("reserved");
    await owner.pool.query(
      "INSERT INTO public.billing_trial_claims (user_id, organization_id, reserved_at) VALUES ($1, $2, now())",
      [reserved.userId, reserved.organizationId]
    );
    assert.equal(
      (await billing.readOwnerPlan(reserved.organizationId, reserved.userId))
        .trialAvailable,
      true,
      "a reservation not consumed is still the person's"
    );
    tests.push(
      "no record reads as Free, and the trial is the person's until consumed (AS-12)"
    );

    const now = Date.now();
    const firstChargeAt = new Date(now - 2 * DAY);
    const states: {
      expect: Record<string, unknown>;
      label: string;
      set: string;
    }[] = [
      {
        expect: { state: "trial_setup", trialAvailable: true },
        label: "trial_setup",
        set: "state = 'trial_setup', provider = 'asaas', provider_ref = $2, price_amount = 24.90, price_id = 'pro-1', first_charge_on = (now() AT TIME ZONE 'America/Sao_Paulo')::date + 7",
      },
      {
        expect: {
          cycleMonths: 1,
          firstChargeAt: null,
          priceAmount: "24.90",
          provider: "woovi",
          state: "trialing",
          trialAvailable: false,
        },
        label: "trialing",
        set: "state = 'trialing', access_ends_at = now() + interval '7 days', trial_started_at = now(), cycle_months = 1, provider = 'woovi', provider_ref = $2, price_amount = 24.90, price_id = 'pro-1', first_charge_on = '2026-10-17'",
      },
      {
        expect: {
          cancelAtPeriodEnd: false,
          firstChargeAmount: "24.90",
          firstChargeAt,
          provider: "asaas",
          state: "active",
        },
        label: "active",
        set: "state = 'active', access_ends_at = now() + interval '28 days', cycle_months = 1, provider = 'asaas', provider_ref = $2, price_amount = 24.90, price_id = 'pro-1', first_charge_on = '2026-10-10', first_charge_at = $3, first_charge_amount = 24.90",
      },
      {
        expect: {
          cancelAtPeriodEnd: true,
          refundRequestedAt: firstChargeAt,
          state: "active",
        },
        label: "active, renewal cancelled",
        set: "state = 'active', access_ends_at = now() + interval '28 days', cancel_at_period_end = true, cycle_months = 12, provider = 'asaas', provider_ref = $2, price_amount = 249.00, price_id = 'pro-12', first_charge_at = $3, first_charge_amount = 249.00, refund_requested_at = $3",
      },
      {
        expect: { provider: "asaas", state: "grace" },
        label: "grace",
        set: "state = 'grace', access_ends_at = now() + interval '7 days', cycle_months = 1, provider = 'asaas', provider_ref = $2",
      },
      {
        expect: { cycleMonths: null, state: "free_over_limit" },
        label: "free_over_limit",
        set: "state = 'free_over_limit', over_limit_since = now(), trial_started_at = now() - interval '40 days'",
      },
      {
        expect: {
          firstChargeAmount: "24.90",
          revoked: { reason: "refund" },
          state: "free",
          trialAvailable: false,
        },
        label: "free after a refund",
        set: "state = 'free', trial_started_at = now() - interval '9 days', provider = 'asaas', provider_ref = $2, first_charge_at = $3, first_charge_amount = 24.90, revoked_through = now() + interval '20 days', revoked_reason = 'refund'",
      },
    ];
    for (const scenario of states) {
      const tenant = await newTenant(scenario.label);
      await owner.pool.query(
        "INSERT INTO public.organization_billing (organization_id) VALUES ($1)",
        [tenant.organizationId]
      );
      await owner.pool.query(
        `UPDATE public.organization_billing SET ${scenario.set} WHERE organization_id = $1`,
        // exactly the parameters the statement names: PostgreSQL refuses one more
        [tenant.organizationId, `ref-${randomUUID()}`, firstChargeAt].slice(
          0,
          Math.max(
            1,
            ...[...scenario.set.matchAll(/\$(\d)/g)].map((match) =>
              Number(match[1])
            )
          )
        )
      );
      const plan = await billing.readOwnerPlan(
        tenant.organizationId,
        tenant.userId
      );
      for (const [key, value] of Object.entries(scenario.expect)) {
        assert.deepEqual(
          plan[key as keyof typeof plan],
          value,
          `${scenario.label}: ${key}`
        );
      }
      assert.ok(
        plan.firstChargeOn === null || CALENDAR_DAY.test(plan.firstChargeOn),
        `${scenario.label}: the day of the first charge is São Paulo's text`
      );
    }
    tests.push(
      "the billing role reads each state with the columns of 0100: the price and the first charge as text with two decimals, the moments as dates, the refund memory"
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
    await store?.close().catch(() => undefined);
    await runtime?.pool.end().catch(() => undefined);
    for (const [role, group] of logins) {
      await owner.pool
        .query(`REVOKE "${group}" FROM "${role}"`)
        .catch(() => undefined);
      await owner.pool
        .query(`DROP ROLE IF EXISTS "${role}"`)
        .catch(() => undefined);
    }
    await owner.pool.end();
  }
}

run().catch((error: unknown) => {
  console.error(
    `Billing read plan PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
