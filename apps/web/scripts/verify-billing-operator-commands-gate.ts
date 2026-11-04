// biome-ignore-all lint/performance/noAwaitInLoops: a gate runs its probes strictly one at a time, for a clear failure
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  operatorCancelRenewal,
  type RefundCommandDependencies,
  refundCurrentPeriod,
} from "@polaris/billing/operator-commands";
import {
  type BillingProviderPort,
  ProviderUnavailableError,
  type RefundOptions,
} from "@polaris/billing/provider-port";
import {
  BillingCommandInProgressError,
  type BillingStore,
  createBillingStore,
} from "@polaris/db/billing-store";
import { createDatabase } from "@polaris/db/client";
import {
  createTenantFixture,
  disposableHostPattern,
  gateBranchPattern,
  journalMigrationCount,
  poolerPattern,
  redactedFailure,
  requiredEnvironment,
  type TenantFixture,
  temporaryRuntimeUrl,
} from "../../../packages/db/scripts/sales-gate-support";

/**
 * The operator's provider commands (ADR 0105) on a real PostgreSQL 18, with the real billing store, inbox, ledger and
 * lock, and a provider that keeps the state of one charge the way the Asaas adapter reads it (a charge already being
 * refunded is not offered again):
 *   1. the refund decides by the state of the charge, never by the command ID: a repeat with another command ID, a
 *      repeat with the same one after the provider accepted and the answer was lost, and a repeat while the charge is
 *      being refunded (before it is refunded) all refund once;
 *   2. the amount the operator saw is checked under the lock before anything: another one is `amount_changed`, with
 *      no cancellation and no decision written;
 *   3. the decision (actor and reason) is written once per command ID in the ledger, before the provider is asked;
 *   4. the operator's cancellation: one fact per command ID, the lock of another command refuses it at once.
 * The fixtures stay, as in the other gates; the logins are dropped at the end.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const DAY = 86_400_000;

type ChargeStatus = "CONFIRMED" | "REFUND_REQUESTED" | "REFUNDED";

interface FakeProvider {
  amount: string;
  /** The provider accepts the refund and then the answer is lost (a timeout after it was accepted). */
  answerLostOnce: boolean;
  calls: string[];
  live: boolean;
  port: BillingProviderPort;
  refunds: number;
  status: ChargeStatus;
}

/** One live subscription and its charge of the period in force; nothing leaves the process. */
function fakeProvider(amount = "24.90"): FakeProvider {
  const provider = {
    amount,
    answerLostOnce: false,
    calls: [] as string[],
    live: true,
    refunds: 0,
    status: "CONFIRMED" as ChargeStatus,
  } as FakeProvider;
  provider.port = {
    cancelRenewal: () => {
      provider.calls.push("cancelRenewal");
      const answer = provider.live ? "cancelled" : "already_cancelled";
      provider.live = false;
      return Promise.resolve(answer);
    },
    discardCheckout: () => Promise.resolve("discarded"),
    hasSubscription: () => Promise.resolve(true),
    overduePaymentPage: () => Promise.resolve(null),
    prepareSubscription: () => Promise.reject(new Error("not in this gate")),
    provider: "asaas",
    readState: () => Promise.resolve([]),
    refundCurrentPeriod: async (
      _providerRef: string,
      _now: Date,
      _subscriptionId: string | null,
      _charge: unknown,
      options?: RefundOptions
    ) => {
      provider.calls.push("readCharge");
      // as `refundableCharge`: only a paid charge (CONFIRMED, RECEIVED) is offered for a refund
      if (provider.status !== "CONFIRMED") {
        return "nothing_to_refund";
      }
      await options?.beforeRefund?.({ amount: provider.amount });
      provider.calls.push("refund");
      provider.refunds += 1;
      provider.status = "REFUND_REQUESTED";
      if (provider.answerLostOnce) {
        provider.answerLostOnce = false;
        throw new ProviderUnavailableError();
      }
      return "refund_requested";
    },
    refundsEnabled: true,
  } as BillingProviderPort;
  return provider;
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

    const role = `polaris_operator_cmd_${randomUUID().replaceAll("-", "")}`;
    const password = randomBytes(24).toString("hex");
    await owner.pool.query(
      `CREATE ROLE "${role}" WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`
    );
    await owner.pool.query(`GRANT "polaris_billing_runtime" TO "${role}"`);
    logins.push([role, "polaris_billing_runtime"]);
    const billingUrl = temporaryRuntimeUrl(adminUrl, role, password);
    const newStore = (options?: Parameters<typeof createBillingStore>[1]) => {
      const created = createBillingStore(billingUrl, options);
      stores.push(created);
      return created;
    };
    // its own count of command locks: the gate holds one and acts as another isolate with the other store
    const billing = newStore({ commandLocks: { held: 0 } });
    const suffix = randomUUID().slice(0, 8);
    const clock = await billing.databaseNow();

    /** A store paid by card yesterday, monthly, its record giving Pro. */
    const paidStore = async (label: string): Promise<TenantFixture> => {
      const tenant = await createTenantFixture(
        owner.pool,
        `operator commands ${label} ${suffix}`,
        "America/Sao_Paulo",
        "free"
      );
      const providerRef = `chk-${suffix}-${randomUUID().slice(0, 8)}`;
      const firstChargeAt = new Date(clock.getTime() - DAY);
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
      const stored = await billing.recordEvent({
        fact: {
          amount: { currency: "BRL", value: "24.90" },
          cycleMonths: 1,
          occurredAt: firstChargeAt,
          periodEndsAt: new Date(firstChargeAt.getTime() + 30 * DAY),
          type: "charge_succeeded",
        },
        organizationId: tenant.organizationId,
        provider: "asaas",
        providerEventId: `gate-${randomUUID()}`,
        providerRef,
      });
      const applied = await billing.processEvent(stored.id, clock);
      assert.equal(applied.status, "applied", `${label}: the charge applies`);
      return tenant;
    };
    const decision = (reason: string) => ({ actor: "admin:gate", reason });
    const refund = (
      provider: FakeProvider,
      tenant: TenantFixture,
      requestId: string,
      expectedAmount = "24.90",
      store: BillingStore = billing
    ) =>
      refundCurrentPeriod(
        {
          now: () => clock,
          portFor: () => provider.port,
          store,
        } satisfies RefundCommandDependencies,
        {
          decision: decision("Cliente pediu por e-mail"),
          expectedAmount,
          organizationId: tenant.organizationId,
          requestId,
        }
      );
    const record = async (tenant: TenantFixture) =>
      (
        await owner.pool.query<{ cancel_at_period_end: boolean }>(
          "SELECT cancel_at_period_end FROM public.organization_billing WHERE organization_id = $1",
          [tenant.organizationId]
        )
      ).rows[0];
    const ledger = async (tenant: TenantFixture, prefix: string) =>
      (
        await owner.pool.query<{
          fact: Record<string, string>;
          provider_event_id: string;
        }>(
          "SELECT provider_event_id, fact FROM public.billing_events WHERE organization_id = $1 AND provider_event_id LIKE $2 ORDER BY received_at",
          [tenant.organizationId, `${prefix}%`]
        )
      ).rows;

    // ------------------------------------------------ 1. once, by the state of the charge
    const shopA = await paidStore("another command id");
    const providerA = fakeProvider();
    const requestA1 = randomUUID();
    assert.equal(await refund(providerA, shopA, requestA1), "refund_requested");
    assert.equal((await record(shopA))?.cancel_at_period_end, true);
    assert.equal(
      await refund(providerA, shopA, randomUUID()),
      "nothing_to_refund",
      "another command ID finds the charge already being refunded"
    );
    assert.equal(providerA.refunds, 1);
    assert.deepEqual(providerA.calls, [
      "readCharge",
      "cancelRenewal",
      "refund",
      "readCharge",
    ]);
    const decisionsA = await ledger(shopA, "command:operator_refund:");
    assert.deepEqual(
      decisionsA.map((row) => row.provider_event_id),
      [`command:operator_refund:${requestA1}`],
      "one decision, of the command that reached the provider"
    );
    assert.deepEqual(decisionsA[0]?.fact, {
      actor: "admin:gate",
      occurredAt: clock.toISOString(),
      reason: "Cliente pediu por e-mail",
      type: "operator_refund_requested",
    });
    tests.push(
      "a refund repeated with another command ID finds the charge already being refunded and refunds nothing; the renewal was cancelled once, and the ledger holds one decision with the actor and the reason"
    );

    const shopB = await paidStore("answer lost");
    const providerB = fakeProvider();
    providerB.answerLostOnce = true;
    const requestB = randomUUID();
    await assert.rejects(
      () => refund(providerB, shopB, requestB),
      ProviderUnavailableError
    );
    assert.equal(
      await refund(providerB, shopB, requestB),
      "nothing_to_refund",
      "the same command ID after the answer was lost"
    );
    assert.equal(providerB.refunds, 1);
    assert.equal(
      (await ledger(shopB, "command:operator_refund:")).length,
      1,
      "the repeat of the same command writes no second decision"
    );
    tests.push(
      "a refund the provider accepted but whose answer was lost (the 503 of the Admin) is repeated with the same command ID and refunds nothing more"
    );

    for (const status of ["REFUND_REQUESTED", "REFUNDED"] as const) {
      const shop = await paidStore(`charge ${status}`);
      const provider = fakeProvider();
      provider.status = status;
      assert.equal(
        await refund(provider, shop, randomUUID()),
        "nothing_to_refund"
      );
      assert.equal(provider.refunds, 0);
      assert.deepEqual(provider.calls, ["readCharge"]);
      assert.equal(
        (await record(shop))?.cancel_at_period_end,
        false,
        "nothing to refund cancels nothing"
      );
      assert.deepEqual(await ledger(shop, "command:operator_refund:"), []);
    }
    tests.push(
      "while the charge is being refunded (REFUND_REQUESTED) or once refunded, a refund refunds nothing, cancels nothing and writes no decision"
    );

    // ------------------------------------------------ 2. the amount the operator saw
    const shopC = await paidStore("amount changed");
    const providerC = fakeProvider("49.80");
    assert.equal(
      await refund(providerC, shopC, randomUUID(), "24.90"),
      "amount_changed"
    );
    assert.deepEqual(providerC.calls, ["readCharge"]);
    assert.equal(providerC.refunds, 0);
    assert.equal((await record(shopC))?.cancel_at_period_end, false);
    assert.deepEqual(await ledger(shopC, "command:"), []);
    assert.equal(
      await refund(providerC, shopC, randomUUID(), "49.80"),
      "refund_requested",
      "with the amount it holds, the same charge is refunded"
    );
    tests.push(
      "a refund whose expected amount is not the charge's answers amount_changed, with no cancellation, no refund and nothing in the ledger"
    );

    // ------------------------------------------------ 3. the lock of another command
    const shopD = await paidStore("lock");
    const providerD = fakeProvider();
    const other = newStore({ commandLocks: { held: 0 } });
    await billing.withOrganizationLock(shopD.organizationId, async () => {
      await assert.rejects(
        () => refund(providerD, shopD, randomUUID(), "24.90", other),
        BillingCommandInProgressError
      );
      await assert.rejects(
        () =>
          operatorCancelRenewal(
            { now: () => clock, portFor: () => providerD.port, store: other },
            {
              commandId: randomUUID(),
              decision: decision("Cancelar a pedido do dono"),
              organizationId: shopD.organizationId,
            }
          ),
        BillingCommandInProgressError
      );
    });
    assert.deepEqual(providerD.calls, []);
    assert.deepEqual(await ledger(shopD, "command:"), []);
    tests.push(
      "while another command holds the store's lock (the owner's, or another operator's), the operator's refund and cancellation are refused at once, touching neither the provider nor the ledger"
    );

    // ------------------------------------------------ 4. the operator's cancellation
    const shopE = await paidStore("cancel");
    const providerE = fakeProvider();
    const cancel = (commandId: string) =>
      operatorCancelRenewal(
        { now: () => clock, portFor: () => providerE.port, store: billing },
        {
          commandId,
          decision: decision("Cancelar a pedido do dono"),
          organizationId: shopE.organizationId,
        }
      );
    const commandE = randomUUID();
    assert.equal(await cancel(commandE), "cancelled");
    assert.equal(await cancel(commandE), "already_cancelled");
    assert.equal((await record(shopE))?.cancel_at_period_end, true);
    assert.equal(
      (await ledger(shopE, `command:cancel_renewal:${commandE}:`)).length,
      1,
      "the same command ID is the same cancellation fact"
    );
    assert.deepEqual(
      (await ledger(shopE, "command:operator_cancel_renewal:")).map(
        (row) => row.fact
      ),
      [
        {
          actor: "admin:gate",
          occurredAt: clock.toISOString(),
          reason: "Cancelar a pedido do dono",
          type: "operator_renewal_cancel_requested",
        },
      ]
    );
    tests.push(
      "the operator's cancellation writes its decision and one cancellation fact per command ID; a repeat is already_cancelled and writes neither again"
    );

    console.log(
      JSON.stringify(
        {
          branch,
          database: serverRow.database_name,
          status: "passed",
          tests,
        },
        null,
        2
      )
    );
  } finally {
    for (const store of stores) {
      await store.close();
    }
    for (const [role, group] of logins) {
      await owner.pool.query(`REVOKE "${group}" FROM "${role}"`);
      await owner.pool.query(`DROP ROLE IF EXISTS "${role}"`);
    }
    await owner.pool.end();
  }
}

run().catch((error: unknown) => {
  console.error(
    `Billing operator commands PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
