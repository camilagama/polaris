// biome-ignore-all lint/performance/noAwaitInLoops: Probes, in order.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { BILLING_STATES } from "@polaris/domain/billing/entitlements";
import {
  checkoutOpen,
  HANDLED_BILLING_PROVIDERS,
  renewalAlive,
} from "@polaris/domain/billing/renewal-cancellation";
import { createBillingStore } from "../src/billing-store";
import { createDatabase } from "../src/client";
import {
  recoverOrganizationClosure,
  requestOrganizationClosure,
} from "../src/organization-closure-repository";
import { PURGE_BILLING_FACT_KEYS } from "../src/purge-datasets";
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
  withTenantAs,
} from "./sales-gate-support";

/**
 * Closing the organization cancels the renewal of its subscription, on a real PostgreSQL 18 (ADR 0074, L4;
 * migration 0086): the closure writes `billing.renewal_cancel_requested` in its own transaction, with or
 * without a provider, keyed by the closure cycle, and leaves billing as it was; only the privacy owner's
 * function writes it, and only that shape; the hourly retry is by state (V6): it writes the cycle's event
 * when it is missing and sends a dispatched one back to pending while the renewal is alive, never a new key,
 * and stops once the cancellation is recorded, the closure is undone or nothing renews; only the billing
 * runtime executes it.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const TYPE = "billing.renewal_cancel_requested";
const AFTER_THE_CLOSURE = /after_the_closure/;
const STATES_LISTED = /billing\.state IN \(([^)]*)\)/g;
const NOT_CANCELLED = /NOT billing\.cancel_at_period_end/;
const PROVIDER_LINKED = /billing\.provider IS NOT NULL/;
const SERVICE_ROLES = [
  "polaris_pr11_runtime",
  "polaris_catalog_runtime",
  "polaris_admin_runtime",
  "polaris_privacy_runtime",
  "polaris_outbox_runtime",
];

interface OutboxRow {
  attempts: number;
  available_at: Date;
  event: Record<string, unknown>;
  id: string;
  idempotency_key: string;
  status: string;
}

async function run() {
  const branch = requiredEnvironment("POLARIS_SALES_GATE_BRANCH");
  assert.match(branch, gateBranchPattern);
  const adminUrl = requiredEnvironment("POLARIS_SALES_GATE_DATABASE_URL");
  const parsedAdminUrl = new URL(adminUrl);
  assert.match(parsedAdminUrl.hostname, disposableHostPattern);
  assert.doesNotMatch(parsedAdminUrl.hostname, poolerPattern);

  const owner = createDatabase(adminUrl, { maxConnections: 2 });
  const logins: [string, string][] = [];
  const tests: string[] = [];
  let runtime: ReturnType<typeof createDatabase> | undefined;
  let billing: ReturnType<typeof createBillingStore> | undefined;

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
      "PostgreSQL 18 with every migration replayed from scratch, the cancellation of the renewal at the closure included"
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
    const tenantUrl = await login(runtimeRole, "polaris_renew_tenant");
    const billingUrl = await login(
      "polaris_billing_runtime",
      "polaris_renew_bill"
    );
    runtime = createDatabase(tenantUrl, { maxConnections: 2 });
    const runtimeDb = runtime.db;
    billing = createBillingStore(billingUrl);
    const store = billing;

    const suffix = randomUUID().slice(0, 8);
    const fixture = (label: string, plan: "free" | "pro" = "pro") =>
      createTenantFixture(
        owner.pool,
        `renew ${label} ${suffix}`,
        "America/Sao_Paulo",
        plan
      );
    const nameOf = async (tenant: TenantFixture) =>
      (
        await owner.pool.query<{ name: string }>(
          "SELECT name FROM public.organizations WHERE id = $1",
          [tenant.organizationId]
        )
      ).rows[0]?.name as string;
    const close = async (tenant: TenantFixture) => {
      const confirmation = await nameOf(tenant);
      return withTenantAs(
        runtimeDb,
        tenant,
        "organization:close",
        (transaction, identity) =>
          requestOrganizationClosure(transaction, identity, { confirmation })
      );
    };
    // references are unique across organizations: each run has its own
    const refOf = (label: string) => `${label}_${suffix}`;
    const linkProvider = (tenant: TenantFixture, label: string) =>
      owner.pool.query(
        "UPDATE public.organization_billing SET provider = 'asaas', provider_ref = $2 WHERE organization_id = $1",
        [tenant.organizationId, refOf(label)]
      );
    const billingRow = async (organizationId: string) =>
      (
        await owner.pool.query(
          "SELECT to_jsonb(b) - 'updated_at' AS row FROM public.organization_billing b WHERE b.organization_id = $1",
          [organizationId]
        )
      ).rows[0]?.row ?? null;
    const events = async (organizationId: string) =>
      (
        await owner.pool.query<OutboxRow>(
          "SELECT id, idempotency_key, event, status, attempts, available_at FROM public.event_outbox WHERE organization_id = $1 AND type = $2 ORDER BY created_at, id",
          [organizationId, TYPE]
        )
      ).rows;
    const cycleOf = async (organizationId: string) =>
      Number(
        (
          await owner.pool.query<{ ms: string }>(
            "SELECT (floor(extract(epoch FROM requested_at) * 1000))::bigint::text AS ms FROM public.organization_closures WHERE organization_id = $1",
            [organizationId]
          )
        ).rows[0]?.ms
      );
    /** What the dispatcher does once the queue accepted the event, `ago` seconds back. */
    const dispatched = (eventId: string, ago: number) =>
      owner.pool.query(
        "UPDATE public.event_outbox SET status = 'dispatched', attempts = attempts + 1, dispatched_at = now() - $2 * interval '1 second' WHERE id = $1",
        [eventId, ago]
      );
    const rearm = (
      minAge = 3600,
      limit = 1000,
      providers: readonly string[] = ["asaas"]
    ) => store.rearmRenewalCancellations(minAge, limit, providers);

    // ------------------------------------------------- 1. the closure writes the request, in its transaction
    const linked = await fixture("linked");
    await linkProvider(linked, "pol_renew_linked");
    const linkedBefore = await billingRow(linked.organizationId);
    assert.deepEqual(await events(linked.organizationId), []);
    await close(linked);
    const linkedEvents = await events(linked.organizationId);
    assert.equal(linkedEvents.length, 1, "one request per closure");
    const cycle = await cycleOf(linked.organizationId);
    assert.ok(Number.isSafeInteger(cycle) && cycle > 0);
    const [first] = linkedEvents;
    assert.ok(first);
    assert.equal(first.idempotency_key, `${TYPE}:${cycle}`);
    assert.deepEqual(
      first.event,
      { requestedAt: cycle },
      "the body names the closure cycle and nothing else"
    );
    assert.equal(first.status, "pending");
    assert.equal(first.attempts, 0);
    assert.deepEqual(
      await billingRow(linked.organizationId),
      linkedBefore,
      "the billing record is exactly as it was: the consumer cancels, the closure only asks"
    );

    const free = await fixture("free", "free");
    await close(free);
    const freeEvents = await events(free.organizationId);
    assert.equal(
      freeEvents.length,
      1,
      "a closure without a provider asks too; the consumer finds nothing to cancel"
    );
    assert.equal(await billingRow(free.organizationId), null);

    const rolledBack = await fixture("rolled back");
    await linkProvider(rolledBack, "pol_renew_rollback");
    await assert.rejects(
      () =>
        withTenantAs(
          runtimeDb,
          rolledBack,
          "organization:close",
          async (transaction, identity) => {
            await requestOrganizationClosure(transaction, identity, {
              confirmation: await nameOf(rolledBack),
            });
            throw new Error("after_the_closure");
          }
        ),
      AFTER_THE_CLOSURE
    );
    assert.deepEqual(
      await events(rolledBack.organizationId),
      [],
      "a closure rolled back leaves no request"
    );
    assert.equal(
      (
        await owner.pool.query<{ status: string }>(
          "SELECT status FROM public.organizations WHERE id = $1",
          [rolledBack.organizationId]
        )
      ).rows[0]?.status,
      "active"
    );
    tests.push(
      "the closure writes billing.renewal_cancel_requested in its own transaction (a rolled back closure leaves none), with or without a provider, keyed by the closure cycle (the request instant in milliseconds, the body's only key), pending and untouched, and leaves the billing record exactly as it was"
    );

    // ------------------------------------------------- 2. only that shape, only through the closure function
    const asPrivacyOwner = async (statement: string, values: unknown[]) => {
      const client = await owner.pool.connect();
      try {
        await client.query("BEGIN");
        await withGateRole(client, "polaris_privacy_owner", () =>
          client.query(statement, values)
        );
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    };
    const insert =
      "INSERT INTO public.event_outbox (organization_id, type, event, idempotency_key, correlation_id) VALUES ($1, $2, $3::jsonb, $4, 'gate')";
    const forged: [string, unknown[]][] = [
      [
        "another cycle than the closure's",
        [
          linked.organizationId,
          TYPE,
          JSON.stringify({ requestedAt: cycle - 1 }),
          `${TYPE}:${cycle - 1}`,
        ],
      ],
      [
        "a key that is not the body's",
        [
          linked.organizationId,
          TYPE,
          JSON.stringify({ requestedAt: cycle }),
          `${TYPE}:x${cycle}`,
        ],
      ],
      [
        "a key beside the cycle",
        [
          linked.organizationId,
          TYPE,
          JSON.stringify({ providerRef: "pol_x", requestedAt: cycle }),
          `${TYPE}:${cycle}`,
        ],
      ],
      [
        "the cycle as text",
        [
          linked.organizationId,
          TYPE,
          JSON.stringify({ requestedAt: String(cycle) }),
          `${TYPE}:${cycle}`,
        ],
      ],
      [
        "an organization that is open",
        [
          rolledBack.organizationId,
          TYPE,
          JSON.stringify({ requestedAt: cycle }),
          `${TYPE}:${cycle}`,
        ],
      ],
    ];
    for (const [label, values] of forged) {
      await expectSqlState(
        () => asPrivacyOwner(insert, values),
        "42501",
        `the privacy owner cannot write ${label}`
      );
    }
    await expectSqlState(
      () =>
        withRuntimeSqlContext(tenantUrl, rolledBack, (client) =>
          client.query(insert, [
            rolledBack.organizationId,
            TYPE,
            JSON.stringify({ requestedAt: cycle }),
            `${TYPE}:${cycle}`,
          ])
        ),
      "42501",
      "the tenant runtime cannot write it at all"
    );
    const visible = async (organizationId: string) => {
      const client = await owner.pool.connect();
      try {
        await client.query("BEGIN");
        const result = await withGateRole(client, "polaris_privacy_owner", () =>
          client.query(
            "SELECT organization_id, state, provider, provider_ref, cancel_at_period_end FROM public.organization_billing WHERE organization_id = $1",
            [organizationId]
          )
        );
        return result.rowCount;
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    };
    assert.equal(await visible(linked.organizationId), 1);
    assert.equal(
      await visible(rolledBack.organizationId),
      0,
      "the privacy owner reads the billing record only of an organization in closure"
    );
    tests.push(
      "only the privacy owner (the closure function's owner) reads the billing record of an organization in closure (never of an open one) and writes the event, and only for an organization in closure, with the very cycle of its closure record as the body's only key (an integer) and the key the type and that cycle; the tenant runtime cannot write the type at all"
    );

    // ------------------------------------------------- 3. the retry by state (V6)
    assert.deepEqual(
      await rearm(),
      { inserted: 0, rearmed: 0 },
      "a pending request is the dispatcher's: nothing to do"
    );
    await dispatched(first.id, 60);
    assert.deepEqual(
      await rearm(),
      { inserted: 0, rearmed: 0 },
      "a request dispatched a minute ago is still the queue's"
    );
    await dispatched(first.id, 7200);
    assert.deepEqual(await rearm(), { inserted: 0, rearmed: 1 });
    const rearmed = await events(linked.organizationId);
    assert.equal(rearmed.length, 1, "never a new key for the same cycle");
    assert.equal(rearmed[0]?.id, first.id, "the same event, sent again");
    assert.equal(rearmed[0]?.status, "pending");
    assert.ok(
      (rearmed[0]?.available_at.getTime() ?? 0) <= Date.now() + 1000,
      "due now"
    );
    assert.deepEqual(
      await rearm(),
      { inserted: 0, rearmed: 0 },
      "and only once while it waits"
    );

    // what the consumer writes once the provider cancelled: the record stops asking
    await dispatched(first.id, 7200);
    const cancellation = {
      fact: { occurredAt: new Date(), type: "subscription_cancelled" as const },
      organizationId: linked.organizationId,
      provider: "asaas",
      providerEventId: `command:cancel_renewal:${first.id}`,
      providerRef: refOf("pol_renew_linked"),
    };
    const stored = await store.recordEvent(cancellation);
    assert.equal(stored.duplicate, false);
    assert.equal((await store.processEvent(stored.id)).status, "applied");
    assert.equal(
      (await store.readRecord(linked.organizationId))?.cancelAtPeriodEnd,
      true
    );
    const again = await store.recordEvent(cancellation);
    assert.deepEqual(
      again,
      { duplicate: true, id: stored.id },
      "a second delivery of the same cycle is a duplicate"
    );
    assert.deepEqual(
      await rearm(),
      { inserted: 0, rearmed: 0 },
      "a renewal cancelled is no longer owed"
    );
    assert.equal(
      (await events(linked.organizationId))[0]?.status,
      "dispatched"
    );

    // the request resent long after (the Admin), once the organization subscribed again: the fact of the
    // new subscription has an ID of its own (the request and the reference), so it applies and the record
    // says cancelled; the same request for the same subscription stays a duplicate
    await owner.pool.query(
      "UPDATE public.organization_billing SET provider_ref = $2, provider_subscription_id = NULL, cancel_at_period_end = false WHERE organization_id = $1",
      [linked.organizationId, refOf("pol_renew_linked_again")]
    );
    const resent = await store.recordEvent({
      ...cancellation,
      fact: { occurredAt: new Date(), type: "subscription_cancelled" },
      providerEventId: `command:cancel_renewal:${first.id}:again`,
      providerRef: refOf("pol_renew_linked_again"),
    });
    assert.equal(resent.duplicate, false);
    assert.equal((await store.processEvent(resent.id)).status, "applied");
    assert.equal(
      (await store.readRecord(linked.organizationId))?.cancelAtPeriodEnd,
      true,
      "the resent cancellation of another subscription is recorded"
    );

    // a closure whose request is missing (closed before the event existed, or a checkout paid after it)
    const missing = await fixture("missing");
    await linkProvider(missing, "pol_renew_missing");
    await close(missing);
    await owner.pool.query(
      "DELETE FROM public.event_outbox WHERE organization_id = $1 AND type = $2",
      [missing.organizationId, TYPE]
    );
    const missingBilling = await billingRow(missing.organizationId);
    assert.deepEqual(await rearm(), { inserted: 1, rearmed: 0 });
    const written = await events(missing.organizationId);
    assert.equal(written.length, 1);
    const missingCycle = await cycleOf(missing.organizationId);
    assert.equal(written[0]?.idempotency_key, `${TYPE}:${missingCycle}`);
    assert.deepEqual(written[0]?.event, { requestedAt: missingCycle });
    assert.equal(written[0]?.status, "pending");
    assert.deepEqual(
      await rearm(),
      { inserted: 0, rearmed: 0 },
      "written once"
    );
    assert.deepEqual(await billingRow(missing.organizationId), missingBilling);

    // nothing renews, or nothing is Polaris's to ask: no request, never a rearm
    const notOwed: [string, (tenant: TenantFixture) => Promise<unknown>][] = [
      ["no provider linked", () => Promise.resolve()],
      [
        "a checkout not paid yet",
        (tenant) =>
          owner.pool.query(
            "UPDATE public.organization_billing SET state = 'trial_setup', access_ends_at = NULL WHERE organization_id = $1",
            [tenant.organizationId]
          ),
      ],
      [
        "a record back on Free",
        (tenant) =>
          owner.pool.query(
            "UPDATE public.organization_billing SET state = 'free', access_ends_at = NULL WHERE organization_id = $1",
            [tenant.organizationId]
          ),
      ],
    ];
    for (const [label, prepare] of notOwed) {
      const tenant = await fixture(label);
      if (label !== "no provider linked") {
        await linkProvider(tenant, `pol_renew_${randomUUID().slice(0, 8)}`);
      }
      await prepare(tenant);
      await close(tenant);
      const [event] = await events(tenant.organizationId);
      assert.ok(event);
      await dispatched(event.id, 7200);
      await owner.pool.query("DELETE FROM public.event_outbox WHERE id = $1", [
        event.id,
      ]);
      assert.deepEqual(
        await rearm(),
        { inserted: 0, rearmed: 0 },
        `nothing is owed with ${label}`
      );
    }
    const open = await fixture("open");
    await linkProvider(open, "pol_renew_open");
    assert.deepEqual(
      await rearm(),
      { inserted: 0, rearmed: 0 },
      "an open organization with a live renewal is not the closure's to cancel"
    );

    // undone, then closed again: the old cycle is left alone, the new one has its own request
    const undone = await fixture("undone");
    await linkProvider(undone, "pol_renew_undone");
    await close(undone);
    const [undoneFirst] = await events(undone.organizationId);
    assert.ok(undoneFirst);
    await dispatched(undoneFirst.id, 7200);
    await recoverOrganizationClosure(
      runtimeDb,
      undone.userId,
      undone.organizationId
    );
    assert.deepEqual(
      await rearm(),
      { inserted: 0, rearmed: 0 },
      "a closure undone is no longer asked again by the hourly run"
    );
    // the next cycle must not share the first one's millisecond
    await new Promise((resolve) => setTimeout(resolve, 5));
    await close(undone);
    const undoneEvents = await events(undone.organizationId);
    assert.equal(undoneEvents.length, 2, "a new cycle, a new request");
    const undoneCycle = await cycleOf(undone.organizationId);
    assert.equal(undoneEvents[1]?.idempotency_key, `${TYPE}:${undoneCycle}`);
    assert.notEqual(undoneEvents[0]?.idempotency_key, `${TYPE}:${undoneCycle}`);
    await dispatched(undoneEvents[1]?.id as string, 7200);
    assert.deepEqual(await rearm(), { inserted: 0, rearmed: 1 });
    const afterReclose = await events(undone.organizationId);
    assert.equal(
      afterReclose[0]?.status,
      "dispatched",
      "the old cycle's request is not sent again"
    );
    assert.equal(afterReclose[1]?.status, "pending");

    // a provider Polaris does not cancel through is the person's: never asked again, unless the app lists it.
    // Woovi is listed since its outbound port (cobrança PR 6): the list the app passes asks it again (L4)
    assert.ok(HANDLED_BILLING_PROVIDERS.includes("woovi"));
    const woovi = await fixture("woovi");
    await owner.pool.query(
      "UPDATE public.organization_billing SET provider = 'woovi', provider_ref = $2 WHERE organization_id = $1",
      [woovi.organizationId, refOf("woovi")]
    );
    await close(woovi);
    const [wooviEvent] = await events(woovi.organizationId);
    assert.ok(wooviEvent);
    await dispatched(wooviEvent.id, 7200);
    assert.deepEqual(
      await rearm(3600, 1000, ["asaas"]),
      { inserted: 0, rearmed: 0 },
      "a provider not listed is not asked again"
    );
    assert.deepEqual(
      await rearm(3600, 1000, HANDLED_BILLING_PROVIDERS),
      { inserted: 0, rearmed: 1 },
      "Woovi, listed by the app, is asked again while its renewal is alive"
    );

    // an event sent 200 times is left to the incident: it does not cycle until the purge
    await owner.pool.query(
      "UPDATE public.event_outbox SET status = 'dispatched', attempts = 200, dispatched_at = now() - interval '2 hours' WHERE id = $1",
      [wooviEvent.id]
    );
    assert.deepEqual(
      await rearm(3600, 1000, ["asaas", "woovi"]),
      { inserted: 0, rearmed: 0 },
      "past 200 sends it is the incident's"
    );
    await owner.pool.query(
      "UPDATE public.event_outbox SET attempts = 199 WHERE id = $1",
      [wooviEvent.id]
    );
    assert.deepEqual(
      await rearm(3600, 1000, ["asaas", "woovi"]),
      { inserted: 0, rearmed: 1 },
      "below it, still asked again"
    );
    await owner.pool.query(
      "UPDATE public.organization_billing SET provider = NULL, provider_ref = NULL WHERE organization_id = $1",
      [woovi.organizationId]
    );

    // a batch never passes its limit
    const many: TenantFixture[] = [];
    for (const label of ["batch 1", "batch 2"]) {
      const tenant = await fixture(label);
      await linkProvider(tenant, `pol_renew_${randomUUID().slice(0, 8)}`);
      await close(tenant);
      await owner.pool.query(
        "DELETE FROM public.event_outbox WHERE organization_id = $1 AND type = $2",
        [tenant.organizationId, TYPE]
      );
      many.push(tenant);
    }
    assert.deepEqual(await rearm(3600, 1), { inserted: 1, rearmed: 0 });
    assert.deepEqual(await rearm(3600, 1), { inserted: 1, rearmed: 0 });
    for (const tenant of many) {
      assert.equal((await events(tenant.organizationId)).length, 1);
    }
    for (const [minAge, limit, providers] of [
      [899, 10, ["asaas"]],
      [86_401, 10, ["asaas"]],
      [3600, 0, ["asaas"]],
      [3600, 1001, ["asaas"]],
      [3600, 10, []],
      [3600, 10, ["Asaas"]],
      [3600, 10, ["asaas; drop"]],
      [3600, 10, Array.from({ length: 9 }, (_, index) => `p${index}`)],
    ] as const) {
      await expectSqlState(
        () => rearm(minAge, limit, providers),
        "22023",
        `the hourly run refuses an age of ${minAge} s, a batch of ${limit} or the providers ${JSON.stringify(providers)}`
      );
    }
    tests.push(
      "the retry is by state (V6), only at the providers the app lists and below 200 sends: a pending request and one dispatched less than the minimum age are left alone; one dispatched earlier is sent back to pending, the same row and key, once; the cycle's request is written when it is missing, once; nothing is asked once the cancellation is recorded (whose second delivery is a duplicate, while the same request for a subscription made again is a fact of its own that applies), without a provider, with a checkout not paid, on Free, for an open organization or for a closure undone; closing again after an undo has a request of its own and the old cycle is not sent again; the batch respects its limit and the arguments are checked"
    );

    // ------------------------------------------------- 3b. the checkout open at the closure is given up
    const opened = await fixture("checkout open");
    await linkProvider(opened, "pol_renew_checkout");
    await owner.pool.query(
      "UPDATE public.organization_billing SET state = 'trial_setup', access_ends_at = NULL WHERE organization_id = $1",
      [opened.organizationId]
    );
    await close(opened);
    const [openedEvent] = await events(opened.organizationId);
    assert.ok(openedEvent);
    const openedLink = await store.readProviderLink(opened.organizationId);
    assert.ok(openedLink);
    assert.equal(openedLink.providerSubscriptionId, null);
    assert.equal(
      checkoutOpen(
        await store.readRecord(opened.organizationId),
        openedLink,
        await store.checkoutDiscarded(opened.organizationId, openedLink)
      ),
      true,
      "a checkout linked before the closure and not paid is open until the closure gives it up"
    );
    const openedBilling = await billingRow(opened.organizationId);
    // what the consumer writes once the provider gave the checkout up, on the billing runtime; twice is once
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await store.recordCheckoutDiscarded({
        link: openedLink,
        organizationId: opened.organizationId,
        requestId: openedEvent.id,
      });
    }
    const ledger = (
      await owner.pool.query<{
        fact: Record<string, unknown>;
        fact_type: string;
        provider: string;
        provider_event_id: string;
        provider_ref: string | null;
        state_after: string;
        state_before: string;
        status: string;
      }>(
        "SELECT provider, provider_event_id, provider_ref, fact, fact_type, status, state_before, state_after FROM public.billing_events WHERE organization_id = $1 AND fact ->> 'type' = 'checkout_discarded'",
        [opened.organizationId]
      )
    ).rows;
    assert.equal(ledger.length, 1, "the same request writes one ledger row");
    const [discardRow] = ledger;
    assert.ok(discardRow);
    assert.deepEqual(
      {
        ...discardRow,
        fact: Object.keys(discardRow.fact).sort(),
      },
      {
        fact: ["occurredAt", "type"],
        fact_type: "command",
        provider: "polaris",
        provider_event_id: `command:discard_checkout:${openedEvent.id}:${createHash("sha256").update(refOf("pol_renew_checkout")).digest("hex").slice(0, 32)}`,
        provider_ref: refOf("pol_renew_checkout"),
        state_after: "trial_setup",
        state_before: "trial_setup",
        status: "applied",
      },
      "a command of the ledger, the reference in its column and nothing of it in the fact"
    );
    for (const key of Object.keys(discardRow.fact)) {
      assert.ok(
        (PURGE_BILLING_FACT_KEYS as readonly string[]).includes(key),
        `the purge keeps the key ${key} of the fact`
      );
    }
    assert.equal(
      await store.checkoutDiscarded(opened.organizationId, openedLink),
      true
    );
    assert.equal(
      checkoutOpen(
        await store.readRecord(opened.organizationId),
        openedLink,
        await store.checkoutDiscarded(opened.organizationId, openedLink)
      ),
      false,
      "once given up, nothing is open"
    );
    assert.deepEqual(
      await billingRow(opened.organizationId),
      openedBilling,
      "giving the checkout up changes no billing state"
    );
    assert.equal(
      await store.checkoutDiscarded(opened.organizationId, {
        provider: "asaas",
        providerRef: refOf("pol_renew_checkout_next"),
      }),
      false,
      "another checkout of the organization is not the one given up"
    );
    assert.equal(
      await store.checkoutDiscarded(linked.organizationId, openedLink),
      false,
      "the ledger row is the organization's own"
    );
    tests.push(
      "a checkout linked before the closure and not paid (no subscription matched, no Pro) is open until the billing runtime records it given up: one command row of the ledger per request (writing it twice is one row), the reference in its column, a fact the purge keeps whole, no billing state changed; another checkout or another organization is not the one given up"
    );

    // ------------------------------------------------- 4. the same predicate as the domain
    const definition = (
      await owner.pool.query<{ source: string }>(
        "SELECT prosrc AS source FROM pg_proc WHERE oid = 'public.rearm_renewal_cancellations(integer, integer, text[])'::regprocedure"
      )
    ).rows[0]?.source as string;
    const listed = [...definition.matchAll(STATES_LISTED)]
      .map((match) => match[1] as string)
      .map((states) =>
        states
          .split(",")
          .map((state) => state.trim().replaceAll("'", ""))
          .sort()
      );
    const domain = BILLING_STATES.filter((state) =>
      renewalAlive(
        { cancelAtPeriodEnd: false, state },
        { provider: "asaas", providerSubscriptionId: "sub_gate" }
      )
    ).sort();
    assert.equal(
      listed.length,
      2,
      "both parts of the function list the states"
    );
    for (const states of listed) {
      assert.deepEqual(
        states,
        domain,
        "the states the database calls alive are the domain's"
      );
    }
    assert.match(definition, NOT_CANCELLED);
    assert.match(definition, PROVIDER_LINKED);
    tests.push(
      "the database function calls a renewal alive with the domain's own predicate: the states that give Pro, a provider linked and no cancellation recorded"
    );

    // ------------------------------------------------- 5. who may do what
    const fn = "public.rearm_renewal_cancellations(integer, integer, text[])";
    const [meta] = (
      await owner.pool.query<{
        config: string[] | null;
        definer: boolean;
        owner: string;
      }>(
        `SELECT pg_get_userbyid(proowner) AS owner, prosecdef AS definer, proconfig AS config
           FROM pg_proc WHERE oid = '${fn}'::regprocedure`
      )
    ).rows;
    assert.deepEqual(meta, {
      config: ["search_path=pg_catalog, public, pg_temp"],
      definer: true,
      owner: "polaris_privacy_owner",
    });
    const [closureMeta] = (
      await owner.pool.query<{ config: string[] | null; owner: string }>(
        "SELECT pg_get_userbyid(proowner) AS owner, proconfig AS config FROM pg_proc WHERE oid = 'public.request_organization_closure(integer)'::regprocedure"
      )
    ).rows;
    assert.deepEqual(
      closureMeta,
      {
        config: ["search_path=pg_catalog, public, pg_temp"],
        owner: "polaris_privacy_owner",
      },
      "the closure function keeps its owner and its hardened search path"
    );
    const executes = async (role: string) =>
      (
        await owner.pool.query<{ allowed: boolean }>(
          `SELECT has_function_privilege($1, '${fn}', 'EXECUTE') AS allowed`,
          [role]
        )
      ).rows[0]?.allowed;
    assert.equal(await executes("polaris_billing_runtime"), true);
    for (const role of SERVICE_ROLES) {
      assert.equal(await executes(role), false, `${role} does not execute it`);
    }
    assert.equal(
      (
        await owner.pool.query<{ allowed: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = '${fn}'::regprocedure AND a.grantee = 0) AS allowed`
        )
      ).rows[0]?.allowed,
      false,
      "PUBLIC does not execute it"
    );
    const columns = async (privilege: string) =>
      (
        await owner.pool.query<{ column_name: string }>(
          `SELECT DISTINCT column_name FROM information_schema.column_privileges
            WHERE grantee = 'polaris_privacy_owner' AND table_schema = 'public' AND table_name = 'organization_billing' AND privilege_type = $1
            ORDER BY column_name`,
          [privilege]
        )
      ).rows.map((row) => row.column_name);
    assert.deepEqual(await columns("SELECT"), [
      "cancel_at_period_end",
      "organization_id",
      "provider",
      "provider_ref",
      "state",
    ]);
    for (const privilege of ["INSERT", "UPDATE", "DELETE"]) {
      assert.deepEqual(
        await columns(privilege),
        [],
        `the privacy owner cannot ${privilege} billing`
      );
    }
    tests.push(
      "the hourly function is the privacy owner's, SECURITY DEFINER with the hardened search path, executed by the billing runtime only (not PUBLIC, not another service); the closure function keeps its owner and search path; the privacy owner reads five columns of the billing record and writes none"
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
    await billing?.close().catch(() => undefined);
    await runtime?.pool.end().catch(() => undefined);
    for (const [role, group] of logins) {
      await owner.pool.query(`REVOKE "${group}" FROM "${role}"`);
      await owner.pool.query(`DROP ROLE IF EXISTS "${role}"`);
    }
    await owner.pool.end();
  }
}

run().catch((error: unknown) => {
  console.error(
    `Renewal cancellation PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
