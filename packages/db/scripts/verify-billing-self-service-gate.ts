// biome-ignore-all lint/performance/noAwaitInLoops: a gate runs its probes strictly one at a time, for a clear failure
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { BillingFact } from "@polaris/domain/billing/facts";
import { Client } from "pg";
import {
  closeSupportCase,
  openSupportCase,
} from "../src/admin-support-repository";
import {
  type BillingStore,
  createBillingStore,
  type RefundedRenewal,
} from "../src/billing-store";
import { createDatabase } from "../src/client";
import { withGateRole } from "./gate-roles";
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
 * The owner's billing self-service, the database part (ADR 0104, migration 0100), on a real
 * PostgreSQL 18:
 *   1. the new columns of `organization_billing`: written only by the billing role, invisible to the tenant, three of
 *      them readable by the Admin owner (and its closed list of columns), and their checks;
 *   2. `attachProvider` records the price and the day of the first charge and clears, with a new link, the first charge,
 *      the owner's refund request and the back-off: a new subscription opens a new window of the right of withdrawal;
 *   3. `processEvent` records the first charge with the provider's moment (`fact.occurredAt`, never the processing),
 *      its amount and its ledger row, only for the first charge of the link;
 *   4. the owner's limit on provider commands: one every 30 seconds and 10 an hour per store;
 *   5. the hourly safety net (§5): a chargeback is cancelled, `won` is never touched, a new subscription is never
 *      touched, a refusing provider backs off and stops at 10 tries; and the pending refund becomes one incident;
 *   6. `billing_cancellation_feedback`: forced row security, grants per role, the 12 months of the privacy maintenance;
 *   7. the seven audit types, one row per request ID and type (an `INSERT … ON CONFLICT DO NOTHING` of the tenant with
 *      INSERT only), and the cap of 10 per type, store and hour on the three refusals, exact under concurrency, read
 *      by the cap's own owner only;
 *   8. `admin_read_refund_window`: the operator and the case, the closed keys, the audit in the same transaction, and
 *      the platform audit check that keeps every value of 0091.
 * The fixtures stay, as in the other gates; the logins are dropped at the end.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const issuer = "https://polaris-self-service-gate.cloudflareaccess.com";

/** The columns of 0100 on `organization_billing`. */
const NEW_COLUMNS = [
  "first_charge_amount",
  "first_charge_at",
  "first_charge_event_id",
  "first_charge_on",
  "price_amount",
  "price_id",
  "provider_command_at",
  "provider_commands_hour",
  "provider_commands_hour_start",
  "refund_rearm_at",
  "refund_rearm_attempts",
  "refund_request_id",
  "refund_requested_at",
] as const;

/** What the Admin owner reads of `organization_billing`: the columns of 0062 and three of 0100 (ADR 0104, decision 8). */
const ADMIN_OWNER_COLUMNS = [
  "access_ends_at",
  "cancel_at_period_end",
  "cycle_months",
  "first_charge_amount",
  "first_charge_at",
  "last_fact_at",
  "organization_id",
  "over_limit_since",
  "pending_cycle_months",
  "provider",
  "refund_requested_at",
  "revoked_reason",
  "revoked_through",
  "state",
  "trial_started_at",
  "version",
];

const CAPPED = [
  "billing.command_rate_limited",
  "billing.command_in_progress",
  "billing.command_refused",
] as const;

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 32);

const platformTypesOf = (definition: string): string[] =>
  [...definition.matchAll(/'([a-z_.]+)'/g)]
    .map((match) => match[1] ?? "")
    .sort();

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one linear gate script, scenario by scenario
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
    const tenantUrl = await login(runtimeRole, "polaris_self_tenant");
    const billingUrl = await login(
      "polaris_billing_runtime",
      "polaris_self_billing"
    );
    const adminLoginUrl = await login(
      "polaris_admin_runtime",
      "polaris_self_admin"
    );
    const privacyUrl = await login(
      "polaris_privacy_runtime",
      "polaris_self_privacy"
    );
    const as = async <T>(
      url: string,
      operation: (client: Client) => Promise<T>
    ): Promise<T> => {
      const client = new Client({
        connectionString: url,
        connectionTimeoutMillis: 5000,
      });
      await client.connect();
      try {
        return await operation(client);
      } finally {
        await client.end();
      }
    };
    /** Runs as an owner role (withGateRole: also when the gate user is not a superuser), inside a transaction that is rolled back. */
    const asOwnerRole = async <T>(
      role: string,
      operation: (client: Client) => Promise<T>
    ): Promise<T> =>
      as(adminUrl, async (client) => {
        await client.query("BEGIN");
        try {
          return await withGateRole(client, role, () => operation(client));
        } finally {
          await client.query("ROLLBACK");
        }
      });

    store = createBillingStore(billingUrl);
    const billing = store;
    const suffix = randomUUID().slice(0, 8);
    // the provider's references are unique per provider: one set per run
    const ref = (name: string) => `${name}-${suffix}`;
    const newTenant = (label: string) =>
      createTenantFixture(
        owner.pool,
        `self-service ${label} ${suffix}`,
        "America/Sao_Paulo",
        "free"
      );
    const record = async (tenant: TenantFixture) =>
      (
        await owner.pool.query<{
          cancel_at_period_end: boolean;
          first_charge_amount: string | null;
          first_charge_at: Date | null;
          first_charge_event_id: string | null;
          first_charge_on: string | null;
          price_amount: string | null;
          price_id: string | null;
          provider_command_at: Date | null;
          provider_commands_hour: number | null;
          refund_rearm_at: Date | null;
          refund_rearm_attempts: number | null;
          refund_request_id: string | null;
          refund_requested_at: Date | null;
          revoked_cancel_at_period_end: boolean;
          revoked_reason: string | null;
          state: string;
        }>(
          `SELECT state, cancel_at_period_end, revoked_reason, revoked_cancel_at_period_end, price_amount::text,
                  price_id, first_charge_on::text, first_charge_at, first_charge_amount::text, first_charge_event_id,
                  refund_requested_at, refund_request_id, provider_command_at, provider_commands_hour,
                  refund_rearm_attempts, refund_rearm_at
             FROM public.organization_billing WHERE organization_id = $1`,
          [tenant.organizationId]
        )
      ).rows[0];
    const apply = async (
      tenant: TenantFixture,
      providerRef: string,
      fact: BillingFact,
      now: Date
    ) => {
      const stored = await billing.recordEvent({
        fact,
        organizationId: tenant.organizationId,
        provider: "asaas",
        providerEventId: `gate-${randomUUID()}`,
        providerRef,
      });
      const processed = await billing.processEvent(stored.id, now);
      return { ...processed, id: stored.id };
    };

    // ------------------------------------------------ 1. the new columns: who reads and writes them
    const columns = await owner.pool.query<{
      column_name: string;
      is_nullable: string;
    }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'organization_billing' AND column_name = ANY($1::text[])
        ORDER BY column_name`,
      [[...NEW_COLUMNS]]
    );
    assert.deepEqual(
      columns.rows.map((row) => [row.column_name, row.is_nullable]),
      NEW_COLUMNS.map((column) => [column, "YES"]),
      "every new column exists and is nullable (expand only)"
    );
    for (const column of NEW_COLUMNS) {
      const privileges = await owner.pool.query<{
        admin_select: boolean;
        billing_update: boolean;
        tenant_select: boolean;
        tenant_update: boolean;
      }>(
        `SELECT has_column_privilege('polaris_billing_runtime', 'public.organization_billing', $1, 'UPDATE') AS billing_update,
                has_column_privilege($2, 'public.organization_billing', $1, 'SELECT') AS tenant_select,
                has_column_privilege($2, 'public.organization_billing', $1, 'UPDATE') AS tenant_update,
                has_column_privilege('polaris_admin_owner', 'public.organization_billing', $1, 'SELECT') AS admin_select`,
        [column, runtimeRole]
      );
      const [privilege] = privileges.rows;
      assert.equal(
        privilege?.billing_update,
        true,
        `billing updates ${column}`
      );
      assert.equal(privilege?.tenant_select, false, `tenant reads ${column}`);
      assert.equal(privilege?.tenant_update, false, `tenant writes ${column}`);
      assert.equal(
        privilege?.admin_select,
        [
          "first_charge_amount",
          "first_charge_at",
          "refund_requested_at",
        ].includes(column),
        `the Admin owner reads ${column} only when decision 8 needs it`
      );
    }
    // nobody but the billing role (and the table's owner) writes them
    const writers = await owner.pool.query<{ grantee: string }>(
      `SELECT DISTINCT grantee FROM information_schema.column_privileges
        WHERE table_schema = 'public' AND table_name = 'organization_billing' AND column_name = ANY($1::text[])
          AND privilege_type IN ('UPDATE', 'INSERT')
          AND grantee <> (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.organization_billing'::regclass)
        ORDER BY grantee`,
      [[...NEW_COLUMNS]]
    );
    assert.deepEqual(
      writers.rows.map((row) => row.grantee),
      ["polaris_billing_runtime"]
    );
    const adminColumns = await owner.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.column_privileges
        WHERE table_schema = 'public' AND table_name = 'organization_billing'
          AND grantee = 'polaris_admin_owner' AND privilege_type = 'SELECT'
        ORDER BY column_name`
    );
    assert.deepEqual(
      adminColumns.rows.map((row) => row.column_name),
      ADMIN_OWNER_COLUMNS,
      "the Admin owner reads exactly the closed list (0062 plus three), never provider_ref, price_id nor refund_request_id"
    );
    const tenantA = await newTenant("columns");
    await owner.pool.query(
      "INSERT INTO public.organization_billing (organization_id) VALUES ($1)",
      [tenantA.organizationId]
    );
    for (const column of [
      "price_amount",
      "first_charge_at",
      "refund_requested_at",
    ]) {
      await expectSqlState(
        () =>
          withRuntimeSqlContext(tenantUrl, tenantA, (client) =>
            client.query(
              `SELECT ${column} FROM public.organization_billing WHERE organization_id = $1`,
              [tenantA.organizationId]
            )
          ),
        "42501",
        `the tenant cannot read ${column}`
      );
    }
    await withRuntimeSqlContext(tenantUrl, tenantA, async (client) => {
      const visible = await client.query(
        "SELECT state, provider FROM public.organization_billing WHERE organization_id = $1",
        [tenantA.organizationId]
      );
      assert.equal(visible.rows.length, 1, "the old columns stay readable");
    });
    const invalid: [string, string][] = [
      [
        "price_amount = 24.9, price_id = 'pro-1'",
        "organization_billing_price_coherent",
      ],
      ["price_amount = 24.90", "organization_billing_price_coherent"],
      [
        "price_amount = 0.00, price_id = 'pro-1'",
        "organization_billing_price_coherent",
      ],
      [
        "first_charge_amount = 24.90",
        "organization_billing_first_charge_coherent",
      ],
      [
        `first_charge_event_id = '${randomUUID()}'`,
        "organization_billing_first_charge_coherent",
      ],
      [
        "first_charge_at = now(), first_charge_amount = 24.9",
        "organization_billing_first_charge_coherent",
      ],
      [
        `refund_request_id = '${randomUUID()}'`,
        "organization_billing_refund_request_coherent",
      ],
      [
        "provider_commands_hour = 1",
        "organization_billing_provider_commands_coherent",
      ],
      [
        "provider_commands_hour_start = now(), provider_commands_hour = 11",
        "organization_billing_provider_commands_coherent",
      ],
      [
        "refund_rearm_attempts = 1",
        "organization_billing_refund_rearm_coherent",
      ],
      [
        "refund_rearm_at = now(), refund_rearm_attempts = 11",
        "organization_billing_refund_rearm_coherent",
      ],
    ];
    for (const [assignment, constraint] of invalid) {
      await expectSqlState(
        () =>
          owner.pool.query(
            `UPDATE public.organization_billing SET ${assignment} WHERE organization_id = $1`,
            [tenantA.organizationId]
          ),
        "23514",
        `the check refuses ${assignment}`,
        constraint
      );
    }
    tests.push(
      "the 13 new columns are nullable, written only by the billing role, invisible to the tenant (42501 on each, the old ones still readable), three of them readable by the Admin owner, whose list of columns is exactly the closed list of ADR 0104; the checks refuse a price without its ID or scale, an amount or event of the first charge without its moment, a request ID without the anchor, a counter over 10 and a back-off without its moment"
    );

    // ------------------------------------------------ 2. attachProvider and the new window of every new subscription
    const base = new Date();
    const at = (hours: number) => new Date(base.getTime() + hours * HOUR);
    const tenantB = await newTenant("first charge");
    await billing.startTrial(tenantB.organizationId, tenantB.userId, at(-96));
    await billing.attachProvider(
      tenantB.organizationId,
      "asaas",
      ref("chk-b1"),
      {
        firstChargeOn: "2026-10-21",
        priceAmount: "24.90",
        priceId: "pro-1",
      }
    );
    let current = await record(tenantB);
    assert.equal(current?.price_amount, "24.90");
    assert.equal(current?.price_id, "pro-1");
    assert.equal(current?.first_charge_on, "2026-10-21");
    // the same link again is the same subscription: nothing changes
    await billing.attachProvider(
      tenantB.organizationId,
      "asaas",
      ref("chk-b1"),
      {
        firstChargeOn: "2026-10-30",
        priceAmount: "249.00",
        priceId: "pro-12",
      }
    );
    current = await record(tenantB);
    assert.equal(current?.price_id, "pro-1", "the same link keeps its terms");

    // ------------------------------------------------ 3. the first charge, at the provider's moment
    const ready = await apply(
      tenantB,
      ref("chk-b1"),
      { cycleMonths: 1, occurredAt: at(-95), type: "trial_method_ready" },
      at(-95)
    );
    assert.equal(ready.status, "applied");
    // the webhook of the first charge arrives two days late: the moment is the provider's
    const firstChargeAt = at(-50);
    const first = await apply(
      tenantB,
      ref("chk-b1"),
      {
        cycleMonths: 1,
        occurredAt: firstChargeAt,
        periodEndsAt: at(24 * 28),
        type: "charge_succeeded",
      },
      at(-2)
    );
    assert.equal(first.status, "applied");
    current = await record(tenantB);
    assert.equal(current?.state, "active");
    assert.equal(
      current?.first_charge_at?.getTime(),
      firstChargeAt.getTime(),
      "first_charge_at is fact.occurredAt, not the moment it was processed"
    );
    assert.equal(
      current?.first_charge_amount,
      "24.90",
      "without an amount in the fact, the price sent to the provider"
    );
    assert.equal(current?.first_charge_event_id, first.id);
    // a renewal is not the first charge
    const renewal = await apply(
      tenantB,
      ref("chk-b1"),
      {
        amount: { currency: "BRL", value: "26.90" },
        cycleMonths: 1,
        occurredAt: at(-1),
        periodEndsAt: at(24 * 58),
        type: "charge_succeeded",
      },
      at(-1)
    );
    assert.equal(renewal.status, "applied");
    current = await record(tenantB);
    assert.equal(current?.first_charge_at?.getTime(), firstChargeAt.getTime());
    assert.equal(current?.first_charge_event_id, first.id);

    // Pix without a trial: Free to active, with the amount of the fact; then a refund and a new subscription
    const tenantC = await newTenant("new window");
    await billing.attachProvider(
      tenantC.organizationId,
      "asaas",
      ref("chk-c1"),
      {
        firstChargeOn: "2026-10-01",
        priceAmount: "24.90",
        priceId: "pro-1",
      }
    );
    const c1At = at(-30);
    const c1 = await apply(
      tenantC,
      ref("chk-c1"),
      {
        amount: { currency: "BRL", value: "19.90" },
        cycleMonths: 1,
        occurredAt: c1At,
        periodEndsAt: at(24 * 29),
        type: "charge_succeeded",
      },
      at(-29)
    );
    assert.equal(c1.status, "applied");
    current = await record(tenantC);
    assert.equal(
      current?.first_charge_amount,
      "19.90",
      "the amount of the fact"
    );
    assert.equal(current?.first_charge_at?.getTime(), c1At.getTime());
    // the owner's anchor and the net's back-off of this link (written as PR D and the net will)
    await owner.pool.query(
      `UPDATE public.organization_billing SET refund_requested_at = $2, refund_request_id = $3,
              refund_rearm_attempts = 2, refund_rearm_at = $2 WHERE organization_id = $1`,
      [tenantC.organizationId, at(-28), randomUUID()]
    );
    const refunded = await apply(
      tenantC,
      ref("chk-c1"),
      {
        occurredAt: at(-27),
        periodEndsAt: at(24 * 29),
        type: "charge_refunded",
      },
      at(-27)
    );
    assert.equal(refunded.status, "applied");
    current = await record(tenantC);
    assert.equal(current?.revoked_reason, "refund");
    assert.notEqual(current?.state, "active");
    // a new subscription: a new window of the right of withdrawal
    await billing.attachProvider(
      tenantC.organizationId,
      "asaas",
      ref("chk-c2"),
      {
        firstChargeOn: "2026-10-20",
        priceAmount: "249.00",
        priceId: "pro-12",
      }
    );
    current = await record(tenantC);
    assert.equal(current?.first_charge_at, null);
    assert.equal(current?.first_charge_amount, null);
    assert.equal(current?.first_charge_event_id, null);
    assert.equal(current?.refund_requested_at, null);
    assert.equal(current?.refund_request_id, null);
    assert.equal(current?.refund_rearm_attempts, null);
    assert.equal(current?.refund_rearm_at, null);
    assert.equal(current?.revoked_reason, null);
    assert.equal(current?.price_amount, "249.00");
    assert.equal(current?.first_charge_on, "2026-10-20");
    const c2At = at(-3);
    const c2 = await apply(
      tenantC,
      ref("chk-c2"),
      {
        cycleMonths: 12,
        occurredAt: c2At,
        periodEndsAt: at(24 * 360),
        type: "charge_succeeded",
      },
      at(-3)
    );
    assert.equal(c2.status, "applied");
    current = await record(tenantC);
    assert.equal(
      current?.first_charge_at?.getTime(),
      c2At.getTime(),
      "the new subscription has its own first charge, so its own window"
    );
    assert.equal(current?.first_charge_amount, "249.00");
    tests.push(
      "attachProvider records the price, its ID and the day of the first charge, keeps them for the same link, and with a new link clears the first charge, the owner's refund anchor and request ID and the back-off of the net: the new subscription records its own first charge, so each new subscription opens a new window of the right of withdrawal (decision (i))"
    );
    tests.push(
      "processEvent records the first charge of the link when it takes a trial or Free to active: first_charge_at is the provider's moment (a webhook two days late does not move it), the amount of the fact (or the price sent without one) and the ledger row; a renewal changes none of it"
    );

    // ------------------------------------------------ 4. the owner's limit: 1 every 30 s, 10 an hour
    const tenantD = await newTenant("limit");
    const t0 = at(-5);
    const second = (seconds: number) => new Date(t0.getTime() + seconds * 1000);
    assert.equal(
      await billing.claimProviderCommand(tenantD.organizationId, t0),
      true
    );
    assert.equal(
      await billing.claimProviderCommand(tenantD.organizationId, second(10)),
      false,
      "a second command within 30 s is refused"
    );
    assert.equal(
      await billing.claimProviderCommand(tenantD.organizationId, second(29)),
      false
    );
    let accepted = 1;
    for (let index = 1; index < 12; index += 1) {
      if (
        await billing.claimProviderCommand(
          tenantD.organizationId,
          second(index * 31)
        )
      ) {
        accepted += 1;
      }
    }
    assert.equal(accepted, 10, "10 an hour, the 11th refused");
    current = await record(tenantD);
    assert.equal(current?.provider_commands_hour, 10);
    assert.equal(
      await billing.claimProviderCommand(tenantD.organizationId, second(3600)),
      true,
      "a new hour counts from 1 again"
    );
    current = await record(tenantD);
    assert.equal(current?.provider_commands_hour, 1);
    // another store is counted on its own
    assert.equal(
      await billing.claimProviderCommand(tenantA.organizationId, second(3601)),
      true
    );
    tests.push(
      "the owner's limit counts on the record: a second command within 30 s is refused, at most 10 an hour (the 11th refused, nothing counted for it), a new hour counts from 1, and another store is counted on its own"
    );

    // ------------------------------------------------ 5. the safety net (§5)
    const providers = ["asaas"];
    const calls: RefundedRenewal[] = [];
    const cancelling = (renewalCalled: RefundedRenewal) => {
      calls.push(renewalCalled);
      return Promise.resolve("cancelled" as const);
    };
    // only the stores of this gate are in play: the net reads every store, so the others are left with a link of
    // another provider for the passes below
    const netPass = async (
      cancel: (
        renewalCalled: RefundedRenewal
      ) => Promise<"already_cancelled" | "cancelled" | "nothing_to_cancel">,
      now: Date
    ) => billing.rearmRefundedRenewals({ cancel, limit: 100, now, providers });
    const isolate = await owner.pool.query(
      `UPDATE public.organization_billing SET provider = 'gate_other', provider_subscription_id = NULL
        WHERE provider = 'asaas' AND revoked_reason IS NOT NULL
          AND organization_id <> ALL($1::text[])`,
      [[tenantC.organizationId]]
    );
    assert.ok((isolate.rowCount ?? 0) >= 0);

    // a chargeback on a paid period: the renewal is cancelled once
    const tenantE = await newTenant("chargeback");
    await billing.attachProvider(
      tenantE.organizationId,
      "asaas",
      ref("chk-e1"),
      {
        firstChargeOn: "2026-10-01",
        priceAmount: "24.90",
        priceId: "pro-1",
      }
    );
    await apply(
      tenantE,
      ref("chk-e1"),
      {
        cycleMonths: 1,
        occurredAt: at(-20),
        periodEndsAt: at(24 * 20),
        type: "charge_succeeded",
      },
      at(-20)
    );
    const disputed = await apply(
      tenantE,
      ref("chk-e1"),
      {
        occurredAt: at(-10),
        periodEndsAt: at(24 * 20),
        type: "charge_disputed",
      },
      at(-10)
    );
    assert.equal(disputed.status, "applied");
    current = await record(tenantE);
    assert.equal(current?.revoked_reason, "chargeback");
    assert.equal(current?.revoked_cancel_at_period_end, false);
    // a refund that cancelled first (the owner's or the operator's order) is not touched
    const tenantF = await newTenant("refund cancelled first");
    await owner.pool.query(
      `INSERT INTO public.organization_billing
         (organization_id, state, provider, provider_ref, revoked_through, revoked_reason, revoked_cycle_months, revoked_cancel_at_period_end)
       VALUES ($1, 'free', 'asaas', 'chk-f1-' || gen_random_uuid(), $2, 'refund', 1, true)`,
      [tenantF.organizationId, at(24 * 20)]
    );
    // a chargeback won on a paid period: never touched (it gave nothing back)
    const tenantW = await newTenant("won");
    await owner.pool.query(
      `INSERT INTO public.organization_billing
         (organization_id, state, access_ends_at, cycle_months, provider, provider_ref, revoked_through, revoked_reason)
       VALUES ($1, 'active', $2, 1, 'asaas', 'chk-w1-' || gen_random_uuid(), $2, 'won')`,
      [tenantW.organizationId, at(24 * 20)]
    );
    calls.length = 0;
    const firstPass = await netPass(cancelling, at(-9));
    assert.deepEqual(
      calls.map((call) => call.organizationId).sort(),
      [tenantE.organizationId].sort(),
      "only the chargeback's renewal is cancelled: not the won one, not the refund that cancelled first, not the new subscription of the refunded store"
    );
    assert.equal(firstPass.rearmed, 1);
    assert.deepEqual(
      { ...calls[0] },
      {
        attempt: 1,
        organizationId: tenantE.organizationId,
        provider: "asaas",
        providerRef: ref("chk-e1"),
        providerSubscriptionId: null,
        reason: "chargeback",
      }
    );
    current = await record(tenantE);
    assert.equal(current?.revoked_cancel_at_period_end, true);
    const ledger = await owner.pool.query<{ provider_event_id: string }>(
      `SELECT provider_event_id FROM public.billing_events
        WHERE organization_id = $1 AND provider = 'polaris' AND fact ->> 'type' = 'revoked_cancel'`,
      [tenantE.organizationId]
    );
    assert.deepEqual(
      ledger.rows.map((entry) => entry.provider_event_id),
      [
        `command:revoked_cancel:${tenantE.organizationId}:${digest(ref("chk-e1"))}:1`,
      ]
    );
    calls.length = 0;
    await netPass(cancelling, at(30));
    assert.equal(calls.length, 0, "a cancelled renewal is never asked again");
    const wonRow = await owner.pool.query<{
      refund_rearm_attempts: number | null;
    }>(
      "SELECT refund_rearm_attempts FROM public.organization_billing WHERE organization_id = $1",
      [tenantW.organizationId]
    );
    assert.equal(
      wonRow.rows[0]?.refund_rearm_attempts,
      null,
      "won: no try spent"
    );
    tests.push(
      "the safety net cancels the renewal of a chargeback (one call with the store's own link, the memory says cancelled, the ledger row command:revoked_cancel:<store>:<digest>:1, never asked again) and never touches `won`, a refund that cancelled first nor the new subscription of a refunded store"
    );

    // a refund at the provider's panel, then a new subscription before the net ran: the new one is not touched
    const tenantG = await newTenant("refund then new");
    await owner.pool.query(
      `INSERT INTO public.organization_billing
         (organization_id, state, provider, provider_ref, revoked_through, revoked_reason, revoked_cycle_months)
       VALUES ($1, 'free', 'asaas', 'chk-g1-' || gen_random_uuid(), $2, 'refund', 1)`,
      [tenantG.organizationId, at(24 * 20)]
    );
    await billing.attachProvider(
      tenantG.organizationId,
      "asaas",
      ref("chk-g2"),
      {
        firstChargeOn: "2026-10-25",
        priceAmount: "24.90",
        priceId: "pro-1",
      }
    );
    calls.length = 0;
    await netPass(cancelling, at(40));
    assert.equal(
      calls.some((call) => call.organizationId === tenantG.organizationId),
      false,
      "reembolso → nova assinatura: the rearm does not touch the new one"
    );
    // the same refund, left alone, is cancelled (the control of the case above)
    const tenantH = await newTenant("refund at the panel");
    await owner.pool.query(
      `INSERT INTO public.organization_billing
         (organization_id, state, provider, provider_ref, provider_subscription_id, revoked_through, revoked_reason, revoked_cycle_months)
       VALUES ($1, 'free', 'asaas', 'chk-h1-' || gen_random_uuid(), $3, $2, 'refund', 1)`,
      [tenantH.organizationId, at(24 * 20), ref("sub_h1")]
    );
    // a store of a provider the pass does not handle here is left alone
    const tenantO = await newTenant("other provider");
    await owner.pool.query(
      `INSERT INTO public.organization_billing
         (organization_id, state, provider, provider_ref, revoked_through, revoked_reason, revoked_cycle_months)
       VALUES ($1, 'free', 'woovi', 'woovi-o1-' || gen_random_uuid(), $2, 'chargeback', 1)`,
      [tenantO.organizationId, at(24 * 20)]
    );
    calls.length = 0;
    await netPass(cancelling, at(41));
    assert.deepEqual(
      calls.map((call) => [
        call.organizationId,
        call.providerSubscriptionId,
        call.reason,
      ]),
      [[tenantH.organizationId, ref("sub_h1"), "refund"]]
    );
    tests.push(
      "a refund made at the provider's panel is cancelled by the net with the stored subscription; a refunded store that subscribed again before the net ran is not touched (attachProvider cleared the memory), and a store of a provider the pass does not handle is left alone"
    );

    // the provider refuses: 1 h, 2 h, 4 h ... 24 h, and the 10th failure stops the net for the store
    const tenantR = await newTenant("refusing provider");
    await owner.pool.query(
      `INSERT INTO public.organization_billing
         (organization_id, state, provider, provider_ref, revoked_through, revoked_reason, revoked_cycle_months)
       VALUES ($1, 'free', 'asaas', 'chk-r1-' || gen_random_uuid(), $2, 'chargeback', 1)`,
      [tenantR.organizationId, at(24 * 60)]
    );
    const refusing = (renewalCalled: RefundedRenewal) => {
      calls.push(renewalCalled);
      return Promise.reject(new Error("provider_unavailable"));
    };
    let clock = at(50).getTime();
    const tries: number[] = [];
    let exhausted = 0;
    const silence = console.error;
    const silenceWarn = console.warn;
    const errorLines: string[] = [];
    const rearmIncidents = async () =>
      Number(
        (
          await owner.pool.query<{ count: string }>(
            `SELECT COALESCE(sum(occurrence_count), 0)::text AS count FROM public.operational_incidents
              WHERE kind = 'billing_refund_pending' AND cause = 'refund_rearm_exhausted'`
          )
        ).rows[0]?.count ?? 0
      );
    const rearmLedger = async (organizationId: string) =>
      (
        await owner.pool.query<{ provider_event_id: string }>(
          `SELECT provider_event_id FROM public.billing_events
            WHERE provider = 'polaris' AND organization_id = $1 AND fact ->> 'type' = 'refund_rearm_exhausted'`,
          [organizationId]
        )
      ).rows.map((entry) => entry.provider_event_id);
    const rearmIncidentsBefore = await rearmIncidents();
    let rearmIncidentsAtNinth = -1;
    console.error = (...args: unknown[]) => {
      errorLines.push(args.map((arg) => JSON.stringify(arg)).join(" "));
    };
    console.warn = () => undefined;
    try {
      const expectedGaps = [1, 2, 4, 8, 16, 24, 24, 24, 24];
      for (let attempt = 1; attempt <= 10; attempt += 1) {
        calls.length = 0;
        if (attempt === 10) {
          rearmIncidentsAtNinth = await rearmIncidents();
        }
        const pass = await netPass(refusing, new Date(clock));
        assert.equal(calls.length, 1, `try ${attempt} is made when due`);
        assert.equal(calls[0]?.attempt, attempt);
        tries.push(attempt);
        exhausted += pass.exhausted;
        const gap = expectedGaps[attempt - 1];
        if (gap !== undefined) {
          // not due a little before the back-off ends (five minutes of slack for the cron)
          calls.length = 0;
          await netPass(refusing, new Date(clock + gap * HOUR - 10 * 60_000));
          assert.equal(
            calls.length,
            0,
            `no try before ${gap} h after try ${attempt}`
          );
          clock += gap * HOUR;
        }
      }
      const afterTenth = await rearmIncidents();
      calls.length = 0;
      await netPass(refusing, new Date(clock + 30 * DAY));
      assert.equal(calls.length, 0, "after the 10th failure the net stops");
      // the 11th pass, and the sweep of the incidents, add nothing for the same store and link
      await billing.recordPendingRefundIncidents(
        new Date(clock + 30 * DAY),
        1000
      );
      assert.equal(
        rearmIncidentsAtNinth,
        rearmIncidentsBefore,
        "no incident before the 10th failure"
      );
      assert.equal(
        afterTenth - rearmIncidentsBefore,
        1,
        "the 10th failure opens one occurrence of refund_rearm_exhausted"
      );
      assert.equal(
        await rearmIncidents(),
        afterTenth,
        "an 11th pass and the sweep do not add a second occurrence"
      );
    } finally {
      console.error = silence;
      console.warn = silenceWarn;
    }
    assert.equal(tries.length, 10);
    assert.equal(exhausted, 1, "the 10th failure is reported as exhausted");
    const exhaustedLogs = errorLines.filter((line) =>
      line.includes("billing_refund_rearm_exhausted")
    );
    assert.equal(
      exhaustedLogs.length,
      1,
      "the 10th failure logs billing_refund_rearm_exhausted once"
    );
    assert.ok(
      exhaustedLogs.every(
        (line) =>
          line.includes(tenantR.organizationId) && !line.includes("chk-r1-")
      ),
      "the log names the store, never the provider's reference"
    );
    const ledgerR = await rearmLedger(tenantR.organizationId);
    assert.equal(ledgerR.length, 1, "one ledger row for the store and link");
    assert.match(
      ledgerR[0] ?? "",
      new RegExp(
        `^command:refund_rearm_exhausted:${tenantR.organizationId}:[0-9a-f]{32}$`
      )
    );
    current = await record(tenantR);
    assert.equal(current?.refund_rearm_attempts, 10);
    assert.equal(current?.revoked_cancel_at_period_end, false);
    tests.push(
      "a provider that refuses is tried again after 1 h, 2 h, 4 h, 8 h, 16 h and then every 24 h (never before), and the 10th failure stops the net for the store, is reported and logged as exhausted (billing_refund_rearm_exhausted) and opens one occurrence of the incident billing_refund_pending / refund_rearm_exhausted with one ledger row for the store and link; an 11th pass and the sweep add none"
    );

    // the incident of a stopped net the pass could not write is written by the next sweep, once
    const tenantS = await newTenant("stopped net without incident");
    await owner.pool.query(
      `INSERT INTO public.organization_billing
         (organization_id, state, provider, provider_ref, revoked_through, revoked_reason, revoked_cycle_months,
          refund_rearm_attempts, refund_rearm_at)
       VALUES ($1, 'free', 'gate_other', 'chk-s1-' || gen_random_uuid(), $2, 'refund', 1, 10, $3)`,
      [tenantS.organizationId, at(24 * 60), at(60)]
    );
    const beforeSweep = await rearmIncidents();
    const silencedSweep = console.error;
    console.error = () => undefined;
    let firstSweep: number;
    let secondSweep: number;
    try {
      // within the hour of the 10th try it may still be running: not a stop yet
      await billing.recordPendingRefundIncidents(
        new Date(at(60).getTime() + 30 * 60_000),
        1000
      );
      assert.equal(
        (await rearmLedger(tenantS.organizationId)).length,
        0,
        "a 10th try still within its hour is not a stop"
      );
      firstSweep = await billing.recordPendingRefundIncidents(at(61), 1000);
      secondSweep = await billing.recordPendingRefundIncidents(at(62), 1000);
    } finally {
      console.error = silencedSweep;
    }
    assert.ok(firstSweep >= 1);
    assert.equal(secondSweep, 0, "a second sweep adds nothing");
    assert.equal(await rearmIncidents(), beforeSweep + 1);
    assert.equal((await rearmLedger(tenantS.organizationId)).length, 1);
    // a new link is another link: its own stop would be a new occurrence, the old one is not repeated
    await billing.attachProvider(
      tenantS.organizationId,
      "gate_other",
      ref("chk-s2")
    );
    assert.equal(
      await billing.recordPendingRefundIncidents(at(63), 1000),
      0,
      "a new link clears the memory of the stopped net"
    );
    tests.push(
      "a stopped net whose incident is missing (the database failed in its pass) gets it from the next sweep of the incidents, once and not within the hour of the 10th try; a new link clears the memory"
    );

    // the owner's refund still pending after 24 hours: one incident per store and request
    const incidentCount = async () =>
      Number(
        (
          await owner.pool.query<{ count: string }>(
            "SELECT COALESCE(sum(occurrence_count), 0)::text AS count FROM public.operational_incidents WHERE kind = 'billing_refund_pending'"
          )
        ).rows[0]?.count ?? 0
      );
    const tenantP = await newTenant("pending refund");
    const tenantQ = await newTenant("recent request");
    const anchorNow = new Date();
    await owner.pool.query(
      `INSERT INTO public.organization_billing
         (organization_id, state, access_ends_at, cycle_months, cancel_at_period_end, provider, provider_ref, refund_requested_at, refund_request_id)
       VALUES ($1, 'active', $3, 1, true, 'asaas', 'chk-p1-' || gen_random_uuid(), $2, $4),
              ($5, 'active', $3, 1, true, 'asaas', 'chk-q1-' || gen_random_uuid(), $6, $7)`,
      [
        tenantP.organizationId,
        new Date(anchorNow.getTime() - 25 * HOUR),
        new Date(anchorNow.getTime() + 20 * DAY),
        randomUUID(),
        tenantQ.organizationId,
        new Date(anchorNow.getTime() - 23 * HOUR),
        randomUUID(),
      ]
    );
    // revoked by a dispute: a chargeback ends the refund (as refundWindowOf), a won dispute leaves it owed
    const tenantChargeback = await newTenant("pending refund chargeback");
    const tenantWon = await newTenant("pending refund won");
    for (const [tenant, reason] of [
      [tenantChargeback, "chargeback"],
      [tenantWon, "won"],
    ] as const) {
      await owner.pool.query(
        `INSERT INTO public.organization_billing
           (organization_id, state, access_ends_at, cycle_months, cancel_at_period_end, provider, provider_ref,
            refund_requested_at, refund_request_id, revoked_through, revoked_reason, revoked_cycle_months,
            revoked_cancel_at_period_end)
         VALUES ($1, 'free', NULL, NULL, false, 'asaas', 'chk-d1-' || gen_random_uuid(), $2, $3, $4, $5::text,
                 CASE WHEN $5::text = 'won' THEN NULL ELSE 1 END, $5::text <> 'won')`,
        [
          tenant.organizationId,
          new Date(anchorNow.getTime() - 25 * HOUR),
          randomUUID(),
          new Date(anchorNow.getTime() + 20 * DAY),
          reason,
        ]
      );
    }
    const before = await incidentCount();
    const silenced = console.error;
    console.error = () => undefined;
    let firstIncidents: number;
    let secondIncidents: number;
    try {
      firstIncidents = await billing.recordPendingRefundIncidents(
        anchorNow,
        1000
      );
      secondIncidents = await billing.recordPendingRefundIncidents(
        anchorNow,
        1000
      );
    } finally {
      console.error = silenced;
    }
    const after = await incidentCount();
    const pendingLedger = await owner.pool.query<{ organization_id: string }>(
      "SELECT organization_id FROM public.billing_events WHERE provider = 'polaris' AND fact ->> 'type' = 'refund_pending' AND organization_id = ANY($1::text[])",
      [
        [
          tenantP.organizationId,
          tenantQ.organizationId,
          tenantChargeback.organizationId,
          tenantWon.organizationId,
        ],
      ]
    );
    assert.deepEqual(
      pendingLedger.rows.map((entry) => entry.organization_id).sort(),
      [tenantP.organizationId, tenantWon.organizationId].sort(),
      "the request 25 hours old makes one ledger row (a won dispute too); the one 23 hours old and the chargeback none"
    );
    assert.ok(firstIncidents >= 1);
    assert.equal(secondIncidents, 0, "a second pass adds nothing");
    assert.equal(after - before, firstIncidents);
    // a completed refund is not pending
    await owner.pool.query(
      `UPDATE public.organization_billing SET state = 'free', access_ends_at = NULL, cycle_months = NULL,
              cancel_at_period_end = false, revoked_through = $2, revoked_reason = 'refund', revoked_cycle_months = 1,
              revoked_cancel_at_period_end = true
        WHERE organization_id = $1`,
      [tenantQ.organizationId, new Date(anchorNow.getTime() + 20 * DAY)]
    );
    assert.equal(
      await billing.recordPendingRefundIncidents(
        new Date(anchorNow.getTime() + 2 * HOUR),
        1000
      ),
      0,
      "a refund completed within the 24 hours is never an incident"
    );
    await expectSqlState(
      () =>
        withRuntimeSqlContext(tenantUrl, tenantA, (client) =>
          client.query(
            "SELECT public.record_billing_refund_pending_incident($1::uuid, 'refund_not_completed')",
            [randomUUID()]
          )
        ),
      "42501",
      "only the billing role records the incident"
    );
    for (const cause of ["refund_unknown", null]) {
      await expectSqlState(
        () =>
          as(billingUrl, (client) =>
            client.query(
              "SELECT public.record_billing_refund_pending_incident($1::uuid, $2::text)",
              [randomUUID(), cause]
            )
          ),
        "22023",
        `the incident takes only its two causes (${String(cause)})`
      );
    }
    tests.push(
      "an owner's refund still not completed 24 hours after the request becomes one occurrence of the incident billing_refund_pending, with one ledger row for the store and request: 25 hours makes one (a won dispute too), 23 hours none, a chargeback none, a second pass none, a completed refund none; only the billing role executes the function, and only with the causes refund_not_completed and refund_rearm_exhausted"
    );

    // ------------------------------------------------ 6. billing_cancellation_feedback
    const forced = await owner.pool.query<{
      relforcerowsecurity: boolean;
      relrowsecurity: boolean;
    }>(
      "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.billing_cancellation_feedback'::regclass"
    );
    assert.deepEqual(
      { ...forced.rows[0] },
      { relforcerowsecurity: true, relrowsecurity: true }
    );
    const feedbackColumns = await owner.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'billing_cancellation_feedback' ORDER BY column_name`
    );
    assert.deepEqual(
      feedbackColumns.rows.map((entry) => entry.column_name),
      ["cycle_months", "id", "reason", "recorded_on", "state"],
      "no store and no person"
    );
    const reasonText = `Caro demais ${randomUUID()}`;
    await as(billingUrl, (client) =>
      client.query(
        "INSERT INTO public.billing_cancellation_feedback (reason, state, cycle_months) VALUES ($1, 'active', 1)",
        [reasonText]
      )
    );
    const recorded = await owner.pool.query<{
      recorded_on: string;
      today: string;
    }>(
      "SELECT recorded_on::text, (timezone('America/Sao_Paulo', now()))::date::text AS today FROM public.billing_cancellation_feedback WHERE reason = $1",
      [reasonText]
    );
    assert.equal(
      recorded.rows[0]?.recorded_on,
      recorded.rows[0]?.today,
      "only the day, in São Paulo"
    );
    for (const [label, url, statement] of [
      [
        "the billing role reads",
        billingUrl,
        "SELECT reason FROM public.billing_cancellation_feedback",
      ],
      [
        "the billing role sets the day",
        billingUrl,
        "INSERT INTO public.billing_cancellation_feedback (reason, state, recorded_on) VALUES ('x', 'active', '2020-01-01')",
      ],
      [
        "the billing role deletes",
        billingUrl,
        "DELETE FROM public.billing_cancellation_feedback",
      ],
      [
        "the privacy runtime deletes directly",
        privacyUrl,
        "DELETE FROM public.billing_cancellation_feedback",
      ],
      [
        "the Admin runtime reads directly",
        adminLoginUrl,
        "SELECT reason FROM public.billing_cancellation_feedback",
      ],
    ] as const) {
      await expectSqlState(
        () => as(url, (client) => client.query(statement)),
        "42501",
        label
      );
    }
    await expectSqlState(
      () =>
        withRuntimeSqlContext(tenantUrl, tenantA, (client) =>
          client.query(
            "SELECT reason FROM public.billing_cancellation_feedback"
          )
        ),
      "42501",
      "the tenant reads nothing"
    );
    await expectSqlState(
      () =>
        withRuntimeSqlContext(tenantUrl, tenantA, (client) =>
          client.query(
            "INSERT INTO public.billing_cancellation_feedback (reason, state) VALUES ('x', 'active')"
          )
        ),
      "42501",
      "the tenant writes nothing"
    );
    for (const reason of ["", "x".repeat(501)]) {
      await expectSqlState(
        () =>
          as(billingUrl, (client) =>
            client.query(
              "INSERT INTO public.billing_cancellation_feedback (reason, state) VALUES ($1, 'active')",
              [reason]
            )
          ),
        "23514",
        `a reason of ${reason.length} characters`
      );
    }
    await asOwnerRole("polaris_admin_owner", async (client) => {
      const read = await client.query(
        "SELECT reason FROM public.billing_cancellation_feedback WHERE reason = $1",
        [reasonText]
      );
      assert.equal(read.rows.length, 1, "the Admin owner reads it");
    });
    // the 12 months, counted in days of São Paulo: one day past them leaves, the last day stays
    const kept = `kept ${randomUUID()}`;
    const expired = `expired ${randomUUID()}`;
    await owner.pool.query(
      `INSERT INTO public.billing_cancellation_feedback (reason, state, recorded_on) VALUES
         ($1, 'active', (timezone('America/Sao_Paulo', now()))::date - interval '12 months'),
         ($2, 'grace', (timezone('America/Sao_Paulo', now()))::date - interval '12 months' - interval '1 day')`,
      [kept, expired]
    );
    await asOwnerRole("polaris_privacy_owner", async (client) => {
      const visible = await client.query(
        "SELECT id FROM public.billing_cancellation_feedback"
      );
      const expiredCount = await owner.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM public.billing_cancellation_feedback WHERE recorded_on < (timezone('America/Sao_Paulo', now()))::date - interval '12 months'"
      );
      assert.equal(
        visible.rows.length,
        Number(expiredCount.rows[0]?.count),
        "the privacy owner sees only what is past its 12 months"
      );
    });
    let removedTotal = 0;
    for (let batch = 0; batch < 100; batch += 1) {
      const removed = await as(privacyUrl, (client) =>
        client.query<{ removed: number }>(
          "SELECT public.expire_billing_cancellation_feedback(500) AS removed"
        )
      );
      const count = Number(removed.rows[0]?.removed ?? 0);
      removedTotal += count;
      if (count < 500) {
        break;
      }
    }
    assert.ok(removedTotal >= 1);
    const left = await owner.pool.query<{ reason: string }>(
      "SELECT reason FROM public.billing_cancellation_feedback WHERE reason = ANY($1::text[]) ORDER BY reason",
      [[kept, expired, reasonText]]
    );
    assert.deepEqual(
      left.rows.map((entry) => entry.reason).sort(),
      [kept, reasonText].sort(),
      "the reason a day past 12 months leaves, the one of the last day and today's stay"
    );
    await expectSqlState(
      () =>
        as(privacyUrl, (client) =>
          client.query("SELECT public.expire_billing_cancellation_feedback(0)")
        ),
      "22023",
      "a limit out of range"
    );
    await expectSqlState(
      () =>
        as(billingUrl, (client) =>
          client.query("SELECT public.expire_billing_cancellation_feedback(10)")
        ),
      "42501",
      "only the privacy runtime expires"
    );
    tests.push(
      "billing_cancellation_feedback has forced row security and no store or person; the billing role only inserts the reason, the state and the cycle (the day is the São Paulo default; it reads, dates or deletes nothing), the tenant and the runtimes of the Admin and privacy touch nothing, the Admin owner reads, the reason is 1 to 500 characters, and the privacy maintenance deletes exactly what is a day past 12 months (the privacy owner sees nothing else)"
    );

    // ------------------------------------------------ 7. the audit of the owner's requests and its cap
    const audit = async (
      tenant: TenantFixture,
      eventType: string,
      entityId: string,
      url = tenantUrl
    ) =>
      withRuntimeSqlContext(url, tenant, (client) =>
        client.query(
          `INSERT INTO public.tenant_audit_event (organization_id, actor_user_id, event_type, entity_type, entity_id)
           VALUES ($1, $2, $3, 'billing_request', $4)
           ON CONFLICT DO NOTHING`,
          [tenant.organizationId, tenant.userId, eventType, entityId]
        )
      );
    const auditCount = async (tenant: TenantFixture, eventType: string) =>
      Number(
        (
          await owner.pool.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM public.tenant_audit_event WHERE organization_id = $1 AND event_type = $2",
            [tenant.organizationId, eventType]
          )
        ).rows[0]?.count ?? 0
      );
    const tenantT = await newTenant("audit");
    const requestId = randomUUID();
    await audit(tenantT, "billing.refund_requested", requestId);
    await audit(tenantT, "billing.refund_requested", requestId);
    assert.equal(
      await auditCount(tenantT, "billing.refund_requested"),
      1,
      "the same request ID and type is one row, without an error, with INSERT only"
    );
    const classes = await owner.pool.query<{
      event_class: string;
      event_type: string;
    }>(
      "SELECT DISTINCT event_type, event_class FROM public.tenant_audit_event WHERE organization_id = $1",
      [tenantT.organizationId]
    );
    assert.deepEqual(
      classes.rows.map((entry) => [entry.event_type, entry.event_class]),
      [["billing.refund_requested", "security"]]
    );
    // one accepted, nine refused, one accepted: both accepted have their row
    await audit(
      tenantT,
      "billing.owner_renewal_cancel_requested",
      randomUUID()
    );
    for (let index = 0; index < 9; index += 1) {
      await audit(tenantT, "billing.command_rate_limited", randomUUID());
    }
    await audit(
      tenantT,
      "billing.owner_renewal_cancel_requested",
      randomUUID()
    );
    assert.equal(
      await auditCount(tenantT, "billing.owner_renewal_cancel_requested"),
      2
    );
    // eleven of each refusal in the same hour: ten rows each, the 11th dropped in silence
    await audit(tenantT, "billing.command_rate_limited", randomUUID());
    await audit(tenantT, "billing.command_rate_limited", randomUUID());
    for (const eventType of [
      "billing.command_in_progress",
      "billing.command_refused",
    ]) {
      for (let index = 0; index < 11; index += 1) {
        await audit(tenantT, eventType, randomUUID());
      }
    }
    for (const eventType of CAPPED) {
      assert.equal(
        await auditCount(tenantT, eventType),
        10,
        `${eventType}: ten an hour`
      );
    }
    // the accepted types have no cap
    for (let index = 0; index < 11; index += 1) {
      await audit(tenantT, "billing.overdue_payment_opened", randomUUID());
    }
    assert.equal(
      await auditCount(tenantT, "billing.overdue_payment_opened"),
      11
    );
    const overdueClass = await owner.pool.query<{ event_class: string }>(
      "SELECT DISTINCT event_class FROM public.tenant_audit_event WHERE organization_id = $1 AND event_type = 'billing.overdue_payment_opened'",
      [tenantT.organizationId]
    );
    assert.equal(overdueClass.rows[0]?.event_class, "operational");
    const cappedClass = await owner.pool.query<{ event_class: string }>(
      "SELECT DISTINCT event_class FROM public.tenant_audit_event WHERE organization_id = $1 AND event_type = ANY($2::text[])",
      [tenantT.organizationId, [...CAPPED]]
    );
    assert.deepEqual(
      cappedClass.rows.map((entry) => entry.event_class),
      ["security"]
    );
    // rows older than an hour do not count
    const tenantU = await newTenant("audit hour");
    await owner.pool.query(
      `INSERT INTO public.tenant_audit_event (organization_id, actor_user_id, event_type, entity_type, entity_id, created_at)
       SELECT $1, $2, 'billing.command_refused', 'billing_request', gen_random_uuid()::text, now() - interval '61 minutes'
         FROM generate_series(1, 10)`,
      [tenantU.organizationId, tenantU.userId]
    );
    for (let index = 0; index < 10; index += 1) {
      await audit(tenantU, "billing.command_refused", randomUUID());
    }
    assert.equal(
      await auditCount(tenantU, "billing.command_refused"),
      20,
      "the rows of more than an hour ago do not count"
    );
    // exact under concurrency: fifteen at once on fifteen connections, ten rows
    const tenantV = await newTenant("audit race");
    await Promise.all(
      Array.from({ length: 15 }, () =>
        audit(tenantV, "billing.command_in_progress", randomUUID())
      )
    );
    assert.equal(await auditCount(tenantV, "billing.command_in_progress"), 10);
    // another store keeps its own count
    await audit(tenantV, "billing.command_rate_limited", randomUUID());
    assert.equal(await auditCount(tenantV, "billing.command_rate_limited"), 1);
    tests.push(
      "the tenant writes the owner's request with INSERT … ON CONFLICT DO NOTHING and INSERT only under forced row security: the same request ID and type is one row; one accepted, nine refused and one accepted keep both accepted rows; eleven of each refusal type in an hour keep ten (the third type like the other two), the accepted types have no cap, rows older than an hour do not count, fifteen at once on fifteen connections keep exactly ten (the advisory lock), and the classes are security for the six and operational for the overdue payment"
    );

    // the cap's own owner and its reading
    const trigger = await owner.pool.query<{
      enabled: string;
      owner: string;
      search_path: string[] | null;
      security_definer: boolean;
    }>(
      `SELECT t.tgenabled AS enabled, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS security_definer,
              p.proconfig AS search_path
         FROM pg_trigger AS t JOIN pg_proc AS p ON p.oid = t.tgfoid
        WHERE t.tgrelid = 'public.tenant_audit_event'::regclass AND t.tgname = 'tenant_audit_event_billing_command_cap'`
    );
    assert.deepEqual(
      { ...trigger.rows[0] },
      {
        enabled: "A",
        owner: "polaris_billing_audit_owner",
        search_path: ["search_path=pg_catalog, public, pg_temp"],
        security_definer: true,
      }
    );
    const readers = await owner.pool.query<{ grantee: string }>(
      `SELECT DISTINCT grantee FROM information_schema.column_privileges
        WHERE table_schema = 'public' AND table_name = 'tenant_audit_event' AND privilege_type = 'SELECT'
          AND grantee <> (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.tenant_audit_event'::regclass)
        ORDER BY grantee`
    );
    assert.deepEqual(
      readers.rows.map((entry) => entry.grantee),
      ["polaris_billing_audit_owner", "polaris_retention_owner"],
      "the cap's owner is the only new reader of the tenant audit"
    );
    const capColumns = await owner.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.column_privileges
        WHERE table_schema = 'public' AND table_name = 'tenant_audit_event' AND grantee = 'polaris_billing_audit_owner'
        ORDER BY column_name`
    );
    assert.deepEqual(
      capColumns.rows.map((entry) => entry.column_name),
      ["created_at", "event_type", "organization_id"]
    );
    await asOwnerRole("polaris_billing_audit_owner", async (client) => {
      const seen = await client.query<{ event_type: string }>(
        "SELECT DISTINCT event_type FROM public.tenant_audit_event WHERE organization_id = $1 ORDER BY event_type",
        [tenantT.organizationId]
      );
      assert.deepEqual(
        seen.rows.map((entry) => entry.event_type),
        [...CAPPED].sort(),
        "it sees only the three refusal types, never an accepted request"
      );
      await expectSqlState(
        () =>
          client.query(
            "SELECT actor_user_id FROM public.tenant_audit_event LIMIT 1"
          ),
        "42501",
        "nor who did it"
      );
    });
    const ownerRole = await owner.pool.query<{
      rolbypassrls: boolean;
      rolcanlogin: boolean;
      rolsuper: boolean;
    }>(
      "SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'polaris_billing_audit_owner'"
    );
    assert.deepEqual(
      { ...ownerRole.rows[0] },
      { rolbypassrls: false, rolcanlogin: false, rolsuper: false }
    );
    tests.push(
      "the cap is a BEFORE INSERT trigger enabled ALWAYS, SECURITY DEFINER of polaris_billing_audit_owner (no login, no bypass) with a fixed search_path; that owner is the only new reader of tenant_audit_event, of three columns, and sees only the three refusal types"
    );

    // ------------------------------------------------ 8. the operator's read of the window
    const principal = async (status = "active") =>
      (
        await owner.pool.query<{ id: string }>(
          "INSERT INTO public.platform_principals (issuer, subject, role, status) VALUES ($1, $2, 'platform_owner', $3) RETURNING id",
          [issuer, `sub-${randomUUID()}`, status]
        )
      ).rows[0]?.id as string;
    const operator = await principal();
    const inactive = await principal("disabled");
    const openCase = async (organizationId: string) =>
      (
        await as(adminLoginUrl, (client) =>
          openSupportCase(client, operator, {
            context: null,
            kind: "support",
            organizationId,
            reason: "Pedido de desistência por e-mail",
          })
        )
      )?.id as string;
    const caseC = await openCase(tenantC.organizationId);
    const caseB = await openCase(tenantB.organizationId);
    const readWindow = (
      who: string,
      caseId: string,
      organizationId: string,
      url = adminLoginUrl
    ) =>
      as(url, (client) =>
        client.query<{ window: Record<string, unknown> }>(
          "SELECT public.admin_read_refund_window($1::uuid, $2::uuid, $3) AS window",
          [who, caseId, organizationId]
        )
      );
    const platformAudit = async (caseId: string) =>
      (
        await owner.pool.query<{
          detail: string | null;
          entity_id: string;
          event_type: string;
          organization_id: string;
          principal_id: string;
        }>(
          "SELECT principal_id, event_type, organization_id, entity_id, detail FROM public.platform_audit_events WHERE support_case_id = $1 AND event_type = 'billing.refund_window_read'",
          [caseId]
        )
      ).rows;
    const read = await readWindow(operator, caseC, tenantC.organizationId);
    const window = read.rows[0]?.window ?? {};
    assert.deepEqual(Object.keys(window).sort(), [
      "firstChargeAmount",
      "firstChargeAt",
      "method",
      "now",
      "refundRequestedAt",
      "state",
    ]);
    assert.equal(window.firstChargeAmount, "249.00");
    assert.equal(
      new Date(String(window.firstChargeAt)).getTime(),
      c2At.getTime()
    );
    assert.equal(window.method, "card");
    assert.equal(window.state, "active");
    assert.equal(window.refundRequestedAt, null);
    const serialized = JSON.stringify(window);
    for (const secret of [ref("chk-c2"), "pro-12", "sub_"]) {
      assert.equal(serialized.includes(secret), false, `no ${secret}`);
    }
    assert.deepEqual(
      (await platformAudit(caseC)).map((entry) => ({ ...entry })),
      [
        {
          detail: "leitura da janela de reembolso",
          entity_id: tenantC.organizationId,
          event_type: "billing.refund_window_read",
          organization_id: tenantC.organizationId,
          principal_id: operator,
        },
      ],
      "the read is audited in the same transaction, with the operator, the store and the case"
    );
    // the case of another store, an inactive operator and a closed case: one refusal, no audit row
    await expectSqlState(
      () => readWindow(operator, caseB, tenantC.organizationId),
      "42501",
      "a case of another store"
    );
    await expectSqlState(
      () => readWindow(inactive, caseC, tenantC.organizationId),
      "42501",
      "an inactive operator"
    );
    await as(adminLoginUrl, (client) =>
      closeSupportCase(client, operator, caseC, "Resolvido")
    );
    await expectSqlState(
      () => readWindow(operator, caseC, tenantC.organizationId),
      "42501",
      "a closed case"
    );
    assert.equal(
      (await platformAudit(caseC)).length,
      1,
      "a refusal leaves no audit row"
    );
    assert.equal((await platformAudit(caseB)).length, 0);
    for (const [label, url] of [
      ["the tenant", tenantUrl],
      ["the billing role", billingUrl],
      ["the privacy runtime", privacyUrl],
    ] as const) {
      await expectSqlState(
        () => readWindow(operator, caseB, tenantB.organizationId, url),
        "42501",
        `${label} cannot execute it`
      );
    }
    const definer = await owner.pool.query<{
      owner: string;
      search_path: string[] | null;
      security_definer: boolean;
    }>(
      `SELECT pg_get_userbyid(proowner) AS owner, prosecdef AS security_definer, proconfig AS search_path
         FROM pg_proc WHERE oid = 'public.admin_read_refund_window(uuid, uuid, text)'::regprocedure`
    );
    assert.deepEqual(
      { ...definer.rows[0] },
      {
        owner: "polaris_admin_owner",
        search_path: ["search_path=pg_catalog, public, pg_temp"],
        security_definer: true,
      }
    );
    // the check of the platform audit keeps every value of 0091, plus the new one
    const constraint = await owner.pool.query<{ definition: string }>(
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = 'platform_audit_events_type_allowed'"
    );
    const migration0091 = readFileSync(
      new URL(
        "../drizzle/0091_email_dos_avisos_de_encerramento.sql",
        import.meta.url
      ),
      "utf8"
    );
    const line0091 =
      migration0091
        .split("\n")
        .find((line) =>
          line.includes('ADD CONSTRAINT "platform_audit_events_type_allowed"')
        ) ?? "";
    // the exact list now: 0091's, the refund window of 0100 and the three of 0105 (the two of the internal-store marker
    // and the read of the activation funnel). A migration that widens or narrows it changes this line with it.
    assert.deepEqual(
      platformTypesOf(constraint.rows[0]?.definition ?? ""),
      [
        ...platformTypesOf(line0091),
        "activation_funnel.read",
        "billing.refund_window_read",
        "organization.marked_internal",
        "organization.unmarked_internal",
      ].sort(),
      "exactly the list of 0091 plus billing.refund_window_read and the three of 0105: no value of 0091 is gone"
    );
    tests.push(
      "admin_read_refund_window answers, to an active operator under an open case of the same store, exactly firstChargeAt, firstChargeAmount, refundRequestedAt, state, method and now (no reference, price ID or subscription), audited in the same transaction with the operator, the store and the case; a case of another store, an inactive operator and a closed case get the same 42501 and leave no row; only the Admin runtime executes it; it is SECURITY DEFINER of polaris_admin_owner with a fixed search_path, and the platform audit check is exactly the list of 0091 plus billing.refund_window_read and the three of 0105"
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
    for (const [role, group] of logins) {
      await owner.pool.query(`REVOKE "${group}" FROM "${role}"`);
      await owner.pool.query(`DROP ROLE IF EXISTS "${role}"`);
    }
    await owner.pool.end();
  }
}

run().catch((error: unknown) => {
  console.error(
    `Billing self-service PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
