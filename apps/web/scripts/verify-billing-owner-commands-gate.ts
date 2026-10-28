// biome-ignore-all lint/performance/noAwaitInLoops: a gate runs its probes strictly one at a time, for a clear failure
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type {
  BillingProviderPort,
  RefundableCharge,
  RefundOutcome,
} from "@polaris/billing/provider-port";
import { ProviderUnavailableError } from "@polaris/billing/provider-port";
import {
  type BillingStore,
  createBillingStore,
} from "@polaris/db/billing-store";
import { createDatabase } from "@polaris/db/client";
import { recordBillingRequestAudit } from "@polaris/db/tenant-audit";
import type { BillingFact } from "@polaris/domain/billing/facts";
import { refundWindowClosesAt } from "@polaris/domain/billing/plan-view";
import {
  createTenantFixture,
  disposableHostPattern,
  gateBranchPattern,
  journalMigrationCount,
  poolerPattern,
  redactedFailure,
  requiredEnvironment,
  runtimeRole,
  type TenantFixture,
  temporaryRuntimeUrl,
  withTenantAs,
} from "../../../packages/db/scripts/sales-gate-support";
import { refundCancelEventId } from "../src/server/billing/commands";
import {
  type OwnerCommandDependencies,
  OwnerCommandProviderFailure,
  OwnerCommandRefusal,
  ownerCancelRenewal,
  ownerRequestRefund,
} from "../src/server/billing/owner-commands";

/**
 * The owner's billing commands (ADR 0104, decisions 3 and 4; PR D of the Assinatura design v2) on a real PostgreSQL 18, with
 * the real billing store and inbox (`recordEvent` and `processEvent`) and a fake provider:
 *   1. the refund decides by the state: cancel ok → refund fails (`refund_pending`) → another request ID → one
 *      `subscription_cancelled` and one refund, and the refund's webhook then answers every new request the same;
 *   2. the anchor: written by the first request, before the provider, kept when the provider fails at step 1 or 2,
 *      the first of two concurrent requests wins, and a request barred by the limit writes none;
 *   3. the clock is the database's: a request anchored at 23:58 of the last day finishes after midnight; an anchor
 *      a minute short of 72 hours finishes, one past 72 hours is `refund_window_expired`; a first charge whose
 *      webhook came two days late is judged by the provider's moment;
 *   4. the lock never waits: a webhook of the same store is applied while a command holds it, a second command of the
 *      same store is refused at once, the isolate holds one command lock at a time and 20 commands at once leave the
 *      pool to a webhook of a third store; the limit of 30 s and of 10 an hour;
 *   5. the audit of a request (the tenant inserts with no SELECT, one row per request ID and type) and the reason of
 *      a cancellation (no store, no person).
 * The fixtures stay, as in the other gates; the logins are dropped at the end.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

interface FakeProvider {
  calls: string[];
  cancel: () => Promise<
    "already_cancelled" | "cancelled" | "nothing_to_cancel"
  >;
  /** The first charge each refund was asked for (ADR 0104: only that one is refunded). */
  firstCharges: RefundableCharge[];
  refund: () => Promise<RefundOutcome>;
}

/** A provider that answers what the scenario sets and writes down each call; nothing leaves the process. */
function fakeProvider(): FakeProvider & { port: BillingProviderPort } {
  const provider: FakeProvider = {
    calls: [],
    cancel: () => Promise.resolve("cancelled"),
    firstCharges: [],
    refund: () => Promise.resolve("refund_requested"),
  };
  const port = {
    cancelRenewal: () => {
      provider.calls.push("cancelRenewal");
      return provider.cancel();
    },
    discardCheckout: () => Promise.resolve("discarded"),
    hasSubscription: () => Promise.resolve(true),
    overduePaymentPage: () => Promise.resolve(null),
    prepareSubscription: () => Promise.reject(new Error("not in this gate")),
    provider: "asaas",
    readState: () => Promise.resolve([]),
    refundCurrentPeriod: (_providerRef, _now, _subscriptionId, firstCharge) => {
      provider.calls.push("refundCurrentPeriod");
      provider.firstCharges.push(firstCharge);
      return provider.refund();
    },
    refundsEnabled: true,
  } as BillingProviderPort;
  return Object.assign(provider, { port });
}

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
  const stores: BillingStore[] = [];
  let runtime: ReturnType<typeof createDatabase> | undefined;

  try {
    const server = await owner.pool.query<{
      database_name: string;
      server_version_num: string;
    }>(
      "SELECT current_database() AS database_name, current_setting('server_version_num') AS server_version_num"
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
      await login(runtimeRole, "polaris_owner_cmd_tenant"),
      { maxConnections: 2 }
    );
    const tenantDb = runtime.db;
    const billingUrl = await login(
      "polaris_billing_runtime",
      "polaris_owner_cmd_billing"
    );
    const newStore = (options?: Parameters<typeof createBillingStore>[1]) => {
      const created = createBillingStore(billingUrl, options);
      stores.push(created);
      return created;
    };
    const billing = newStore();
    const suffix = randomUUID().slice(0, 8);
    const ref = (name: string) =>
      `${name}-${suffix}-${randomUUID().slice(0, 8)}`;
    const newTenant = (label: string) =>
      createTenantFixture(
        owner.pool,
        `owner commands ${label} ${suffix}`,
        "America/Sao_Paulo",
        "free"
      );
    const dbNow = async () => await billing.databaseNow();

    /** A fact through the real inbox, as a webhook would bring it. */
    const apply = async (
      tenant: TenantFixture,
      providerRef: string,
      fact: BillingFact,
      providerEventId = `gate-${randomUUID()}`,
      store: BillingStore = billing
    ) => {
      const stored = await store.recordEvent({
        fact,
        organizationId: tenant.organizationId,
        provider: "asaas",
        providerEventId,
        providerRef,
      });
      return await store.processEvent(stored.id, await dbNow());
    };
    /** A store paid by card, its first charge at `firstChargeAt` (the provider's moment), monthly. */
    const paidStore = async (label: string, firstChargeAt: Date) => {
      const tenant = await newTenant(label);
      const providerRef = ref("chk");
      await billing.attachProvider(
        tenant.organizationId,
        "asaas",
        providerRef,
        {
          firstChargeOn: firstChargeAt.toISOString().slice(0, 10),
          priceAmount: "24.90",
          priceId: "pro-1",
        }
      );
      const periodEndsAt = new Date(firstChargeAt.getTime() + 30 * DAY);
      const paid = await apply(tenant, providerRef, {
        amount: { currency: "BRL", value: "24.90" },
        cycleMonths: 1,
        occurredAt: firstChargeAt,
        periodEndsAt,
        type: "charge_succeeded",
      });
      assert.equal(
        paid.status,
        "applied",
        `${label}: the first charge applies`
      );
      return {
        firstChargeEventId: paid.eventId,
        periodEndsAt,
        providerRef,
        tenant,
      };
    };
    const row = async (tenant: TenantFixture) =>
      (
        await owner.pool.query<{
          cancel_at_period_end: boolean;
          provider_command_at: Date | null;
          refund_request_id: string | null;
          refund_requested_at: Date | null;
          revoked_reason: string | null;
          state: string;
        }>(
          `SELECT state, cancel_at_period_end, revoked_reason, refund_requested_at, refund_request_id::text,
                  provider_command_at
             FROM public.organization_billing WHERE organization_id = $1`,
          [tenant.organizationId]
        )
      ).rows[0];
    const cancellations = async (tenant: TenantFixture) =>
      Number(
        (
          await owner.pool.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM public.billing_events WHERE organization_id = $1 AND fact_type = 'subscription_cancelled'",
            [tenant.organizationId]
          )
        ).rows[0]?.count ?? 0
      );
    /** The limit of 30 s is the store's own; between the steps of one scenario the gate moves its count back. */
    const clearLimit = async (tenant: TenantFixture) => {
      await owner.pool.query(
        `UPDATE public.organization_billing
            SET provider_command_at = NULL, provider_commands_hour_start = NULL, provider_commands_hour = NULL
          WHERE organization_id = $1`,
        [tenant.organizationId]
      );
    };
    const dependencies = (
      provider: { port: BillingProviderPort },
      store: BillingStore = billing
    ): OwnerCommandDependencies => ({
      portFor: () => provider.port,
      store,
    });
    const refusalOf = async (promise: Promise<unknown>) => {
      try {
        await promise;
      } catch (error: unknown) {
        if (error instanceof OwnerCommandRefusal) {
          return error.code;
        }
        if (error instanceof OwnerCommandProviderFailure) {
          return error.code;
        }
        throw error;
      }
      return "no refusal";
    };

    // ------------------------------------------------ 0. what the commands read: the clock, the record, the ledger
    const before = Date.now();
    const clock = await dbNow();
    assert.ok(Math.abs(clock.getTime() - before) < 5 * MINUTE);
    const shopZ = await paidStore("read", new Date(clock.getTime() - DAY));
    const read = await billing.readOwnerCommandRecord(
      shopZ.tenant.organizationId
    );
    assert.equal(read.state, "active");
    assert.equal(read.firstChargeAmount, "24.90");
    assert.equal(read.link?.providerRef, shopZ.providerRef);
    assert.equal(read.refundRequestedAt, null);
    assert.equal(read.refundRequestId, null);
    assert.deepEqual(
      read.firstCharge,
      { eventId: shopZ.firstChargeEventId, periodEndsAt: shopZ.periodEndsAt },
      "the first charge's event and the period its own fact paid for"
    );
    // the first charge's event is read only within the store: another store's event reads as no period
    const shopY = await paidStore("other", new Date(clock.getTime() - DAY));
    await owner.pool.query(
      "UPDATE public.organization_billing SET first_charge_event_id = $2::uuid WHERE organization_id = $1",
      [shopZ.tenant.organizationId, shopY.firstChargeEventId]
    );
    assert.deepEqual(
      (await billing.readOwnerCommandRecord(shopZ.tenant.organizationId))
        .firstCharge,
      { eventId: shopY.firstChargeEventId, periodEndsAt: null },
      "another store's event gives no period (the owner's refund refuses)"
    );
    // and a period that is not an ISO instant reads as none, never failing the read
    await owner.pool.query(
      `UPDATE public.billing_events SET fact = jsonb_set(fact, '{periodEndsAt}', '"not a date"')
        WHERE id = $1::uuid`,
      [shopY.firstChargeEventId]
    );
    assert.equal(
      (await billing.readOwnerCommandRecord(shopY.tenant.organizationId))
        .firstCharge.periodEndsAt,
      null
    );
    await owner.pool.query(
      "UPDATE public.organization_billing SET first_charge_event_id = $2::uuid WHERE organization_id = $1",
      [shopZ.tenant.organizationId, shopZ.firstChargeEventId]
    );
    const none = await billing.readOwnerCommandRecord(randomUUID());
    assert.equal(none.state, "free");
    assert.equal(none.link, null);
    assert.equal(
      await billing.hasLedgerEvent("asaas", `gate-missing-${randomUUID()}`),
      false
    );
    tests.push(
      "the commands read the database's clock, the record with its link, the anchor and the first charge (its event and the period its own fact paid for, none for another store's event or a malformed period; no record reads as Free with no link), and ask the ledger for their own fact by its ID"
    );

    // ------------------------------------------------ 1. the refund decides by the state (decision 1 of the design)
    const shopA = await paidStore(
      "refund by state",
      new Date(clock.getTime() - DAY)
    );
    const providerA = fakeProvider();
    providerA.refund = () => Promise.reject(new ProviderUnavailableError());
    const requestA1 = randomUUID();
    const first = await ownerRequestRefund(dependencies(providerA), {
      organizationId: shopA.tenant.organizationId,
      requestId: requestA1,
    });
    assert.equal(
      first.response.result,
      "refund_pending",
      "AS-42: 200, pending"
    );
    assert.equal(first.audit, "billing.refund_requested");
    assert.deepEqual(providerA.calls, ["cancelRenewal", "refundCurrentPeriod"]);
    assert.deepEqual(
      providerA.firstCharges,
      [{ eventId: shopA.firstChargeEventId, periodEndsAt: shopA.periodEndsAt }],
      "the refund is asked only for the first charge recorded"
    );
    let current = await row(shopA.tenant);
    assert.equal(
      current?.cancel_at_period_end,
      true,
      "the renewal is cancelled"
    );
    assert.equal(
      current?.refund_request_id,
      requestA1,
      "the anchor is the first request's"
    );
    const anchoredAt = current?.refund_requested_at;
    assert.ok(anchoredAt);
    assert.equal(
      await billing.hasLedgerEvent(
        "asaas",
        await refundCancelEventId(requestA1, shopA.providerRef)
      ),
      true,
      "the cancellation is the request's own fact (command:refund_cancel)"
    );
    // another request ID: the record shows the renewal cancelled, so only the refund is asked
    await clearLimit(shopA.tenant);
    providerA.calls.length = 0;
    providerA.refund = () => Promise.resolve("refund_requested");
    const requestA2 = randomUUID();
    const second = await ownerRequestRefund(dependencies(providerA), {
      organizationId: shopA.tenant.organizationId,
      requestId: requestA2,
    });
    assert.equal(second.response.result, "refund_requested");
    assert.equal(second.audit, "billing.refund_requested");
    assert.deepEqual(providerA.calls, ["refundCurrentPeriod"]);
    assert.equal(
      await cancellations(shopA.tenant),
      1,
      "one subscription_cancelled"
    );
    current = await row(shopA.tenant);
    assert.equal(
      current?.refund_request_id,
      requestA1,
      "the anchor stays the first's"
    );
    assert.equal(current?.refund_requested_at?.getTime(), anchoredAt.getTime());
    // the refund's webhook, through the inbox: the period is taken back
    const refunded = await apply(shopA.tenant, shopA.providerRef, {
      amount: { currency: "BRL", value: "24.90" },
      occurredAt: await dbNow(),
      periodEndsAt: shopA.periodEndsAt,
      type: "charge_refunded",
    });
    assert.equal(refunded.status, "applied");
    current = await row(shopA.tenant);
    assert.equal(current?.revoked_reason, "refund");
    providerA.calls.length = 0;
    const third = await ownerRequestRefund(dependencies(providerA), {
      organizationId: shopA.tenant.organizationId,
      requestId: randomUUID(),
    });
    assert.equal(
      third.response.result,
      "refund_requested",
      "done: the same answer"
    );
    assert.equal(
      third.audit,
      "billing.command_refused",
      "a new request ID is refused in the audit"
    );
    assert.deepEqual(
      providerA.calls,
      [],
      "and nothing is asked of the provider"
    );
    const repeat = await ownerRequestRefund(dependencies(providerA), {
      organizationId: shopA.tenant.organizationId,
      requestId: requestA1,
    });
    assert.equal(
      repeat.audit,
      "billing.refund_requested",
      "the anchor's own request is recognized"
    );
    assert.equal(await cancellations(shopA.tenant), 1);
    tests.push(
      "refund by state with the real inbox: cancel ok → refund fails (refund_pending, the renewal cancelled by the request's own fact) → another request ID refunds without cancelling again (one subscription_cancelled, one refund, the anchor stays the first's) → after the refund's webhook every new request gets the same answer audited as refused, with no provider call, and the anchor's own request is recognized"
    );

    // ------------------------------------------------ 2. the anchor
    const shopB = await paidStore("anchor", new Date(clock.getTime() - DAY));
    const providerB = fakeProvider();
    providerB.cancel = () => Promise.reject(new ProviderUnavailableError());
    assert.equal(
      await refusalOf(
        ownerRequestRefund(dependencies(providerB), {
          organizationId: shopB.tenant.organizationId,
          requestId: randomUUID(),
        })
      ),
      "provider_unavailable",
      "the cancellation fails at the provider"
    );
    current = await row(shopB.tenant);
    assert.ok(
      current?.refund_requested_at,
      "the anchor stays after a failure at step 1"
    );
    assert.equal(current?.cancel_at_period_end, false, "nothing cancelled");
    assert.equal(await cancellations(shopB.tenant), 0);
    // two requests at once, without the lock (the store's own statement): the first wins, the second reads it
    const shopC = await paidStore(
      "anchor race",
      new Date(clock.getTime() - DAY)
    );
    const at = await dbNow();
    const requestC1: string = randomUUID();
    const requestC2: string = randomUUID();
    const anchors = await Promise.all(
      [requestC1, requestC2].map((requestId) =>
        billing.anchorRefundRequest(shopC.tenant.organizationId, {
          at,
          providerRef: shopC.providerRef,
          requestId,
        })
      )
    );
    current = await row(shopC.tenant);
    assert.ok(current?.refund_request_id);
    assert.ok([requestC1, requestC2].includes(current.refund_request_id));
    for (const anchor of anchors) {
      assert.equal(
        anchor?.refundRequestId,
        current.refund_request_id,
        "both read the one that stands"
      );
    }
    const later = await billing.anchorRefundRequest(
      shopC.tenant.organizationId,
      {
        at: new Date(at.getTime() + HOUR),
        providerRef: shopC.providerRef,
        requestId: randomUUID(),
      }
    );
    assert.equal(
      later?.refundRequestedAt.getTime(),
      at.getTime(),
      "a later request never moves it"
    );
    assert.equal(
      await billing.anchorRefundRequest(shopC.tenant.organizationId, {
        at,
        providerRef: ref("another-link"),
        requestId: randomUUID(),
      }),
      null,
      "another link's anchor is not this one"
    );
    // a request barred by the limit writes no anchor
    const shopD = await paidStore(
      "anchor limit",
      new Date(clock.getTime() - DAY)
    );
    assert.equal(
      await billing.claimProviderCommand(
        shopD.tenant.organizationId,
        await dbNow()
      ),
      true
    );
    const providerD = fakeProvider();
    assert.equal(
      await refusalOf(
        ownerRequestRefund(dependencies(providerD), {
          organizationId: shopD.tenant.organizationId,
          requestId: randomUUID(),
        })
      ),
      "billing_command_rate_limited"
    );
    assert.equal((await row(shopD.tenant))?.refund_requested_at, null);
    assert.deepEqual(providerD.calls, []);
    tests.push(
      "the anchor: kept when the provider fails at the cancellation (nothing cancelled), the first of two concurrent requests wins and both read it, a later request or another link never moves it, and a request barred by the limit writes none and calls nothing"
    );

    // ------------------------------------------------ 3. the database's clock at the edges
    // anchored at 23:58 of the last day (the renewal cancelled then), finished after midnight
    const now3 = await dbNow();
    const eightDaysAgo = new Date(now3.getTime() - 8 * DAY);
    const closesAt = refundWindowClosesAt(eightDaysAgo);
    assert.ok(
      closesAt.getTime() <= now3.getTime(),
      "the window of 8 days ago closed today"
    );
    const shopE = await paidStore("midnight", eightDaysAgo);
    const requestE = randomUUID();
    const anchorE = new Date(closesAt.getTime() - 2 * MINUTE);
    await apply(
      shopE.tenant,
      shopE.providerRef,
      { occurredAt: anchorE, type: "subscription_cancelled" },
      await refundCancelEventId(requestE, shopE.providerRef)
    );
    await owner.pool.query(
      "UPDATE public.organization_billing SET refund_requested_at = $2, refund_request_id = $3 WHERE organization_id = $1",
      [shopE.tenant.organizationId, anchorE, requestE]
    );
    const providerE = fakeProvider();
    const finished = await ownerRequestRefund(dependencies(providerE), {
      organizationId: shopE.tenant.organizationId,
      requestId: requestE,
    });
    assert.equal(
      finished.response.result,
      "refund_requested",
      "judged at the anchor, not at now"
    );
    assert.deepEqual(providerE.calls, ["refundCurrentPeriod"]);
    // a minute short of 72 hours finishes; a second past it is the operator's
    const shopF = await paidStore(
      "72 hours",
      new Date(now3.getTime() - 5 * DAY)
    );
    await owner.pool.query(
      "UPDATE public.organization_billing SET refund_requested_at = now() - interval '71 hours 59 minutes', refund_request_id = $2 WHERE organization_id = $1",
      [shopF.tenant.organizationId, randomUUID()]
    );
    const providerF = fakeProvider();
    const inTime = await ownerRequestRefund(dependencies(providerF), {
      organizationId: shopF.tenant.organizationId,
      requestId: randomUUID(),
    });
    assert.equal(inTime.response.result, "refund_requested");
    const shopG = await paidStore(
      "past 72 hours",
      new Date(now3.getTime() - 5 * DAY)
    );
    await owner.pool.query(
      "UPDATE public.organization_billing SET refund_requested_at = now() - interval '72 hours 1 second', refund_request_id = $2 WHERE organization_id = $1",
      [shopG.tenant.organizationId, randomUUID()]
    );
    const providerG = fakeProvider();
    assert.equal(
      await refusalOf(
        ownerRequestRefund(dependencies(providerG), {
          organizationId: shopG.tenant.organizationId,
          requestId: randomUUID(),
        })
      ),
      "refund_window_expired"
    );
    assert.deepEqual(providerG.calls, []);
    // the first charge's webhook came two days late: the window counts from the provider's moment
    const shopH = await paidStore(
      "late webhook",
      new Date(now3.getTime() - 9 * DAY)
    );
    const providerH = fakeProvider();
    assert.equal(
      await refusalOf(
        ownerRequestRefund(dependencies(providerH), {
          organizationId: shopH.tenant.organizationId,
          requestId: randomUUID(),
        })
      ),
      "nothing_to_refund"
    );
    assert.equal((await row(shopH.tenant))?.refund_requested_at, null);
    tests.push(
      "the database's clock: a request anchored at 23:58 of the last day finishes after midnight (judged at the anchor), an anchor 71 h 59 min old finishes and one 72 h 1 s old is refund_window_expired with no provider call, and a first charge processed late is judged by the provider's moment (closed, no anchor)"
    );

    // ------------------------------------------------ 4. the lock never waits, and the limit
    // the stores of the scenario first, one after the other (the pool is not the point of their setup)
    const shopJ = await paidStore("isolate", new Date(clock.getTime() - DAY));
    const shopK = await paidStore(
      "third store",
      new Date(clock.getTime() - DAY)
    );
    const crowd: Awaited<ReturnType<typeof paidStore>>[] = [];
    for (let index = 0; index < 20; index += 1) {
      crowd.push(
        await paidStore(`crowd ${index}`, new Date(clock.getTime() - DAY))
      );
    }
    const shopI = await paidStore("lock", new Date(clock.getTime() - DAY));
    const providerI = fakeProvider();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    providerI.cancel = async () => {
      entered();
      await held;
      return "cancelled";
    };
    const shopFree = await newTenant("cheap refusal");
    const holding = ownerCancelRenewal(dependencies(providerI), {
      organizationId: shopI.tenant.organizationId,
      requestId: randomUUID(),
    });
    await inside;
    // a webhook of the same store, on the same pool, while the command holds the lock and waits on the provider
    const webhookStarted = Date.now();
    const webhook = await apply(shopI.tenant, shopI.providerRef, {
      cycleMonths: 12,
      occurredAt: await dbNow(),
      type: "cycle_change_scheduled",
    });
    assert.notEqual(
      webhook.status,
      "received",
      "the webhook is processed, not left waiting"
    );
    assert.ok(
      Date.now() - webhookStarted < 5000,
      "the webhook does not wait for the lock"
    );
    // a second command of the same store, from another isolate (its own count), is refused at once by the lock
    const otherIsolate = newStore({ commandLocks: { held: 0 } });
    const refusedAt = Date.now();
    assert.equal(
      await refusalOf(
        ownerCancelRenewal(dependencies(fakeProvider(), otherIsolate), {
          organizationId: shopI.tenant.organizationId,
          requestId: randomUUID(),
        })
      ),
      "command_in_progress"
    );
    assert.ok(Date.now() - refusedAt < 1000, "in less than 1 s");
    // this isolate holds one command lock at a time: another store's command is refused too
    assert.equal(
      await refusalOf(
        ownerCancelRenewal(dependencies(fakeProvider()), {
          organizationId: shopJ.tenant.organizationId,
          requestId: randomUUID(),
        })
      ),
      "command_in_progress"
    );
    // a refusal that calls nothing does not ask for the isolate's lock: it answers what it is meanwhile
    assert.equal(
      await refusalOf(
        ownerCancelRenewal(dependencies(fakeProvider()), {
          organizationId: shopFree.organizationId,
          requestId: randomUUID(),
        })
      ),
      "nothing_to_cancel",
      "a store with nothing to cancel is answered while this isolate's lock is held"
    );
    assert.equal(
      await refusalOf(
        ownerRequestRefund(dependencies(fakeProvider()), {
          organizationId: shopFree.organizationId,
          requestId: randomUUID(),
        })
      ),
      "nothing_to_refund",
      "a store with nothing to refund is answered while this isolate's lock is held"
    );
    // 20 commands of 20 stores at once on the same pool: one at most takes the lock, and a third store's webhook goes on
    const crowdOutcomes = await Promise.all(
      crowd.map((shop) =>
        refusalOf(
          ownerCancelRenewal(dependencies(fakeProvider()), {
            organizationId: shop.tenant.organizationId,
            requestId: randomUUID(),
          })
        )
      )
    );
    assert.deepEqual(
      [...new Set(crowdOutcomes)],
      ["command_in_progress"],
      "while one command holds this isolate's lock, every other is refused at once"
    );
    const thirdWebhook = await apply(shopK.tenant, shopK.providerRef, {
      occurredAt: await dbNow(),
      type: "subscription_cancelled",
    });
    assert.equal(
      thirdWebhook.status,
      "applied",
      "a third store's webhook is applied meanwhile"
    );
    release();
    assert.equal((await holding).response.result, "cancelled");
    // and one after the other, the 20 go through, and the pool still serves the webhook
    for (const shop of crowd) {
      const outcome = await ownerCancelRenewal(dependencies(fakeProvider()), {
        organizationId: shop.tenant.organizationId,
        requestId: randomUUID(),
      });
      assert.equal(outcome.response.result, "cancelled");
    }
    const afterLoop = await apply(shopZ.tenant, shopZ.providerRef, {
      cycleMonths: 6,
      occurredAt: await dbNow(),
      type: "cycle_change_scheduled",
    });
    assert.notEqual(afterLoop.status, "received");
    tests.push(
      "the lock never waits: with a command holding it while the provider answers, a webhook of the same store is processed on the same pool, a second command of the same store from another isolate is command_in_progress in under 1 s, this isolate's other commands are refused at once (one lock per isolate) while its refusals that call nothing (nothing_to_cancel, nothing_to_refund) are answered without the lock, and 20 commands at once leave the pool to a third store's webhook; the 20 one after the other all go through"
    );

    // the limit: one every 30 s, and 10 an hour, without calling the provider
    const shopL = await paidStore("limit", new Date(clock.getTime() - DAY));
    const providerL = fakeProvider();
    await clearLimit(shopL.tenant);
    await owner.pool.query(
      "UPDATE public.organization_billing SET cancel_at_period_end = false WHERE organization_id = $1",
      [shopL.tenant.organizationId]
    );
    const firstCancel = await ownerCancelRenewal(dependencies(providerL), {
      organizationId: shopL.tenant.organizationId,
      requestId: randomUUID(),
    });
    assert.equal(firstCancel.response.result, "cancelled");
    // the renewal alive again (as after a new link), and a second command 5 s later
    await owner.pool.query(
      "UPDATE public.organization_billing SET cancel_at_period_end = false WHERE organization_id = $1",
      [shopL.tenant.organizationId]
    );
    providerL.calls.length = 0;
    assert.equal(
      await refusalOf(
        ownerCancelRenewal(dependencies(providerL), {
          organizationId: shopL.tenant.organizationId,
          requestId: randomUUID(),
        })
      ),
      "billing_command_rate_limited"
    );
    assert.deepEqual(providerL.calls, []);
    // 10 in the hour already, the last one 31 s ago
    await owner.pool.query(
      `UPDATE public.organization_billing
          SET provider_command_at = now() - interval '31 seconds',
              provider_commands_hour_start = now() - interval '50 minutes', provider_commands_hour = 10
        WHERE organization_id = $1`,
      [shopL.tenant.organizationId]
    );
    assert.equal(
      await refusalOf(
        ownerCancelRenewal(dependencies(providerL), {
          organizationId: shopL.tenant.organizationId,
          requestId: randomUUID(),
        })
      ),
      "billing_command_rate_limited"
    );
    // the hour over: it goes through again
    await owner.pool.query(
      "UPDATE public.organization_billing SET provider_commands_hour_start = now() - interval '61 minutes' WHERE organization_id = $1",
      [shopL.tenant.organizationId]
    );
    const afterHour = await ownerCancelRenewal(dependencies(providerL), {
      organizationId: shopL.tenant.organizationId,
      requestId: randomUUID(),
    });
    assert.equal(afterHour.response.result, "cancelled");
    assert.deepEqual(providerL.calls, ["cancelRenewal"]);
    tests.push(
      "the store's limit on the commands that call the provider: a second one within 30 s and an 11th within the hour are billing_command_rate_limited with no provider call; after the hour it goes through"
    );

    // ------------------------------------------------ 5. the audit of a request and the reason of a cancellation
    const shopM = await newTenant("audit");
    const requestM = randomUUID();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await withTenantAs(
        tenantDb,
        shopM,
        "billing:manage",
        (transaction, identity) =>
          recordBillingRequestAudit(transaction, identity, {
            eventType: "billing.owner_renewal_cancel_requested",
            requestId: requestM,
          })
      );
    }
    const audited = await owner.pool.query<{
      actor_user_id: string;
      entity_id: string;
      entity_type: string;
    }>(
      "SELECT actor_user_id, entity_type, entity_id FROM public.tenant_audit_event WHERE organization_id = $1 AND event_type = 'billing.owner_renewal_cancel_requested'",
      [shopM.organizationId]
    );
    assert.deepEqual(audited.rows, [
      {
        actor_user_id: shopM.userId,
        entity_id: requestM,
        entity_type: "billing_request",
      },
    ]);
    // the refusal of a request ID audited twice is one row too, with its actor
    const refusedRequest = randomUUID();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await withTenantAs(
        tenantDb,
        shopM,
        "billing:manage",
        (transaction, identity) =>
          recordBillingRequestAudit(transaction, identity, {
            eventType: "billing.command_refused",
            requestId: refusedRequest,
          })
      );
    }
    const refusedRows = await owner.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM public.tenant_audit_event WHERE organization_id = $1 AND event_type = 'billing.command_refused' AND entity_id = $2 AND actor_user_id = $3",
      [shopM.organizationId, refusedRequest, shopM.userId]
    );
    assert.equal(Number(refusedRows.rows[0]?.count), 1);
    // a refund already done asked again 11 times with new request IDs: the cap of the hour keeps 10 refusals
    const shopN = await newTenant("audit cap");
    for (let attempt = 0; attempt < 11; attempt += 1) {
      await withTenantAs(
        tenantDb,
        shopN,
        "billing:manage",
        (transaction, identity) =>
          recordBillingRequestAudit(transaction, identity, {
            eventType: "billing.command_refused",
            requestId: randomUUID(),
          })
      );
    }
    const capped = await owner.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM public.tenant_audit_event WHERE organization_id = $1 AND event_type = 'billing.command_refused'",
      [shopN.organizationId]
    );
    assert.equal(Number(capped.rows[0]?.count), 10);
    const reason = `motivo do gate ${randomUUID()}`;
    await billing.recordCancellationFeedback({
      cycleMonths: 1,
      reason,
      state: "active",
    });
    const feedback = await owner.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM public.billing_cancellation_feedback WHERE reason = $1 AND state = 'active' AND cycle_months = 1 AND recorded_on = (now() AT TIME ZONE 'America/Sao_Paulo')::date",
      [reason]
    );
    assert.equal(Number(feedback.rows[0]?.count), 1);
    tests.push(
      "the audit of a request is inserted by the tenant (no SELECT) once per request ID and type, with its actor, also for a refusal, and 11 refusals with new request IDs in the hour leave 10 rows (the trigger's cap, no error); the billing role keeps the reason of a cancellation with the São Paulo day and no store or person"
    );

    console.log(
      JSON.stringify(
        {
          branch,
          database: expectedDatabase,
          gate: "billing-owner-commands",
          status: "passed",
          tests,
        },
        null,
        2
      )
    );
  } finally {
    for (const store of stores) {
      await store.close().catch(() => undefined);
    }
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
    `Billing owner commands PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
