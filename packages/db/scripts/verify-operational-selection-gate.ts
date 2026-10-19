import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import {
  EntitlementVariantLockedError,
  OperationalSelectionError,
} from "@polaris/domain/billing/operational-selection";
import { createBillingStore } from "../src/billing-store";
import { createDatabase } from "../src/client";
import {
  inventoryCount,
  receiveStock,
  writeOffStock,
} from "../src/inventory-repository";
import {
  InvalidOperationalSelectionError,
  readOperationalSelection,
  selectOperationalVariants,
} from "../src/operational-selection-repository";
import { createProduct, deleteProduct } from "../src/product-repository";
import { cancelSale } from "../src/sale-cancellation-repository";
import { confirmSale } from "../src/sale-repository";
import {
  confirmPlainSale,
  createSellableProduct,
  createTenantFixture,
  disposableHostPattern,
  expectSqlState,
  gateBranchPattern,
  journalMigrationCount,
  poolerPattern,
  recentInstant,
  redactedFailure,
  requiredEnvironment,
  runtimeRole,
  type TenantFixture,
  temporaryRuntimeUrl,
  withRuntimeSqlContext,
  withTenantAs,
} from "./sales-gate-support";

/**
 * Free Over Limit on a real PostgreSQL 18 (plan PR82, ADR 0064): an organization
 * that left Pro holding more variants than Free allows keeps them all, and only
 * the ones it kept operational receive new commercial activity. The choice is
 * open while the adaptation window runs and can only grow after it; one that was
 * never made becomes the default (what sold most recently); undoing and
 * correcting activity stays possible; and the window starts when Pro access
 * actually ended, survives a trial checkout that is opened and abandoned, and
 * restarts only after the organization had Pro again.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const DAY_MS = 86_400_000;

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

    loginRole = `polaris_opsel_gate_rt_${randomUUID().replaceAll("-", "")}`;
    billingLoginRole = `polaris_opsel_gate_${randomUUID().replaceAll("-", "")}`;
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
    runtime = createDatabase(runtimeUrl, { maxConnections: 8 });
    const billing = createBillingStore(billingUrl);
    store = billing;
    const rt = { adminPool: admin.pool, db: runtime.db };
    const as = <T>(
      tenant: TenantFixture,
      capability: string,
      operation: Parameters<typeof withTenantAs<T>>[3]
    ) => withTenantAs(rt.db, tenant, capability, operation);

    // ------------------------------------------------------------- helpers
    const plainProducts = (tenant: TenantFixture, count: number) =>
      as(tenant, "product:create", (tx, identity) =>
        inSequence(count, () =>
          createProduct(tx, identity, { name: `P ${randomUUID()}` })
        )
      );
    const variantIds = async (tenant: TenantFixture) =>
      (
        await admin.pool.query<{ id: string }>(
          "SELECT v.id FROM public.product_variants v JOIN public.products p ON p.organization_id = v.organization_id AND p.id = v.product_id WHERE v.organization_id = $1 AND p.deleted_at IS NULL ORDER BY v.id",
          [tenant.organizationId]
        )
      ).rows.map((row) => row.id);
    const productOf = async (tenant: TenantFixture, variantId: string) =>
      (
        await admin.pool.query<{ id: string; version: number }>(
          "SELECT p.id, p.version FROM public.products p JOIN public.product_variants v ON v.organization_id = p.organization_id AND v.product_id = p.id WHERE v.organization_id = $1 AND v.id = $2",
          [tenant.organizationId, variantId]
        )
      ).rows[0] as { id: string; version: number };
    const stockOf = async (tenant: TenantFixture, variantId: string) =>
      (
        await admin.pool.query<{ quantity: number; version: number }>(
          "SELECT quantity, version FROM public.inventory_balances WHERE organization_id = $1 AND variant_id = $2",
          [tenant.organizationId, variantId]
        )
      ).rows[0] as { quantity: number; version: number };
    const saleCount = async (tenant: TenantFixture) =>
      Number(
        (
          await admin.pool.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM public.sales WHERE organization_id = $1",
            [tenant.organizationId]
          )
        ).rows[0]?.count
      );
    const selectionRows = async (tenant: TenantFixture) =>
      (
        await admin.pool.query<{
          episode_started_at: Date;
          source: string;
          variant_id: string;
        }>(
          "SELECT variant_id, source, episode_started_at FROM public.operational_variant_selections WHERE organization_id = $1 ORDER BY variant_id",
          [tenant.organizationId]
        )
      ).rows;
    const model = (tenant: TenantFixture) =>
      as(tenant, "product:update", (tx, identity) =>
        readOperationalSelection(tx, identity)
      );
    const choose = (tenant: TenantFixture, ids: readonly string[]) =>
      as(tenant, "product:update", (tx, identity) =>
        selectOperationalVariants(tx, identity, {
          requestId: randomUUID(),
          variantIds: ids,
        })
      );
    const sell = (tenant: TenantFixture, variantId: string) =>
      confirmPlainSale(rt, tenant, [{ quantity: 1, variantId }]);
    const receive = (tenant: TenantFixture, variantId: string) =>
      as(tenant, "inventory:adjust", (tx, identity) =>
        receiveStock(tx, identity, {
          commandId: randomUUID(),
          commandVersion: 1,
          occurredOn: "2026-10-01",
          quantity: 1,
          unitCost: "5.00",
          variantId,
        })
      );
    /** The organization left Pro `daysAgo` days ago (null: with no start recorded). */
    const downgrade = (tenant: TenantFixture, daysAgo: number | null) =>
      admin.pool.query(
        `UPDATE public.organization_billing SET state = 'free_over_limit', access_ends_at = NULL, cancel_at_period_end = false, cycle_months = NULL, pending_cycle_months = NULL,
           over_limit_since = ${daysAgo === null ? "NULL" : "now() - make_interval(secs => $2)"}
         WHERE organization_id = $1`,
        daysAgo === null
          ? [tenant.organizationId]
          : [tenant.organizationId, daysAgo * 86_400]
      );
    const expectLocked = async (
      operation: () => Promise<unknown>,
      variantId: string,
      label: string
    ) =>
      await assert.rejects(
        operation,
        (error: unknown) => {
          assert.ok(
            error instanceof EntitlementVariantLockedError,
            `${label}: got ${String(error)}`
          );
          assert.equal(error.variantId, variantId, `${label}: which variant`);
          return true;
        },
        label
      );
    const expectSelectionRefusal = async (
      operation: () => Promise<unknown>,
      code: string,
      label: string
    ) =>
      await assert.rejects(
        operation,
        (error: unknown) => {
          assert.ok(
            error instanceof OperationalSelectionError,
            `${label}: got ${String(error)}`
          );
          assert.equal(error.code, code, label);
          return true;
        },
        label
      );

    // ----------------------------------------- O1: a Pro organization with 55 variants
    // 50 plain products (no stock), then five sellable ones: S1..S5 are the newest.
    const o1 = await createTenantFixture(admin.pool, "opsel one");
    await plainProducts(o1, 50);
    const sellables: { variantId: string }[] = [];
    await inSequence(5, async (index) => {
      sellables.push(
        await createSellableProduct(rt, o1, `S${index + 1}`, {
          cost: "5.00",
          quantity: 10,
        })
      );
    });
    const [s1, s2, s3, s4, s5] = sellables.map((entry) => entry.variantId) as [
      string,
      string,
      string,
      string,
      string,
    ];
    assert.equal((await variantIds(o1)).length, 55);

    // Pro: nothing is restricted, whatever the count
    for (const id of [s1, s2, s3]) {
      // biome-ignore lint/performance/noAwaitInLoops: Three sales, in order.
      await sell(o1, id);
    }
    assert.equal((await model(o1)).phase, "unrestricted");
    await expectSelectionRefusal(
      () => choose(o1, [s1]),
      "nothing_to_select",
      "there is nothing to choose on Pro"
    );
    tests.push(
      "a Pro organization is never restricted, holds 55 variants and has nothing to choose"
    );

    // ------------------------------------------------ adapting (just left Pro)
    await downgrade(o1, 0);
    const adapting = await model(o1);
    assert.equal(adapting.phase, "adapting");
    assert.equal(adapting.limit, 50);
    assert.equal(adapting.liveVariants, 55);
    assert.deepEqual(adapting.selectedVariantIds, []);
    assert.ok(adapting.windowEndsAt);
    const windowMs = adapting.windowEndsAt.getTime() - Date.now();
    // the application clock and the database clock may differ by a little
    assert.ok(
      Math.abs(windowMs - 7 * DAY_MS) < 3_600_000,
      "the window is seven days from the start"
    );
    const preSale = {
      adjustments: [],
      commandId: randomUUID(),
      commandVersion: 1,
      items: [
        {
          chargedUnitPrice: "19.90",
          listedUnitPrice: "20.00",
          quantity: 1,
          variantId: s5,
        },
      ],
      occurredAt: recentInstant(),
      payment: { anticipationRequested: false, method: "pix" as const },
      paymentProfile: null,
      requestId: randomUUID(),
    };
    const confirmPre = () =>
      as(o1, "sale:create", (tx, identity) =>
        confirmSale(tx, identity, preSale)
      );
    const preConfirmed = await confirmPre();
    assert.equal(preConfirmed.replayed, false);
    await receive(o1, s5);
    tests.push(
      "while the window is open every variant is still operational (a sale and a stock receipt of the variant that will be left out both pass) and the model says when it ends"
    );

    // the choice: replaced freely while adapting, validated always
    const all = await variantIds(o1);
    const leftOut = [
      s4,
      s5,
      ...all.filter((id) => ![s1, s2, s3, s4, s5].includes(id)).slice(-3),
    ];
    const final = all.filter((id) => !leftOut.includes(id));
    assert.equal(final.length, 50);
    await expectSelectionRefusal(
      () => choose(o1, all.slice(0, 51)),
      "selection_too_large",
      "more than the limit"
    );
    await expectSelectionRefusal(
      () => choose(o1, [randomUUID()]),
      "variant_unavailable",
      "a variant that does not exist"
    );
    await assert.rejects(
      () => choose(o1, ["not-a-uuid"]),
      InvalidOperationalSelectionError
    );
    assert.equal((await selectionRows(o1)).length, 0, "refusals left nothing");
    const firstChoice = [...final.slice(0, 49), s5];
    const chosen1 = await choose(o1, firstChoice);
    assert.equal(chosen1.selectedVariantIds.length, 50);
    const chosen2 = await choose(o1, final);
    assert.deepEqual([...chosen2.selectedVariantIds].sort(), [...final].sort());
    assert.equal(
      (await selectionRows(o1)).filter((row) => row.source === "user").length,
      50,
      "the second choice replaced the first"
    );
    assert.equal(
      Number(
        (
          await admin.pool.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM public.tenant_audit_event WHERE organization_id = $1 AND event_type = 'operational_selection.changed'",
            [o1.organizationId]
          )
        ).rows[0]?.count
      ),
      2,
      "each accepted change is audited, a refusal is not"
    );
    // still every variant is operational inside the window
    await sell(o1, s5);
    tests.push(
      "the choice is validated (too large, unknown variant, malformed ID are refused and leave nothing), replaced freely while the window is open, audited, and does not restrict anything yet"
    );

    // --------------------------------------------------------- the window ends
    await admin.pool.query(
      "UPDATE public.organization_billing SET over_limit_since = over_limit_since - interval '8 days' WHERE organization_id = $1",
      [o1.organizationId]
    );
    await admin.pool.query(
      "UPDATE public.operational_variant_selections SET episode_started_at = episode_started_at - interval '8 days' WHERE organization_id = $1",
      [o1.organizationId]
    );
    const frozen = await model(o1);
    assert.equal(frozen.phase, "frozen");
    assert.deepEqual([...frozen.selectedVariantIds].sort(), [...final].sort());

    const salesBefore = await saleCount(o1);
    const s5Stock = await stockOf(o1, s5);
    await expectLocked(
      () => sell(o1, s5),
      s5,
      "a sale of a variant that was left out"
    );
    await expectLocked(
      () =>
        confirmPlainSale(rt, o1, [
          { quantity: 1, variantId: s1 },
          { quantity: 1, variantId: s5 },
        ]),
      s5,
      "a sale that has one variant left out refuses the whole sale"
    );
    assert.equal(await saleCount(o1), salesBefore, "no sale was written");
    assert.deepEqual(await stockOf(o1, s5), s5Stock, "no stock moved");
    await sell(o1, s1);
    await expectLocked(
      () => receive(o1, s5),
      s5,
      "a stock receipt of a variant that was left out"
    );
    await receive(o1, s1);
    tests.push(
      "after the window only the chosen variants are sold or received: a sale with one variant left out is refused whole and writes nothing, and the chosen ones still pass"
    );

    // integrity operations on a locked variant stay possible
    const replayed = await confirmPre();
    assert.equal(replayed.replayed, true, "a sale confirmed before replays");
    assert.equal(replayed.sale.id, preConfirmed.sale.id);
    await as(o1, "inventory:adjust", async (tx, identity) => {
      const balance = await stockOf(o1, s5);
      await inventoryCount(tx, identity, {
        commandId: randomUUID(),
        commandVersion: 1,
        expectedVersion: balance.version,
        occurredOn: "2026-10-10",
        physicalQuantity: balance.quantity,
        valuationUnitCost: null,
        variantId: s5,
      });
    });
    await as(o1, "inventory:adjust", (tx, identity) =>
      writeOffStock(tx, identity, {
        commandId: randomUUID(),
        commandVersion: 1,
        occurredOn: "2026-10-10",
        quantity: 1,
        reasonCode: "damaged",
        requestId: randomUUID(),
        variantId: s5,
      })
    );
    const quantityBeforeCancel = (await stockOf(o1, s5)).quantity;
    await as(o1, "sale:cancel", (tx, identity) =>
      cancelSale(tx, identity, {
        commandId: randomUUID(),
        commandVersion: 1,
        reasonCode: "customer_request",
        requestId: randomUUID(),
        saleId: preConfirmed.sale.id,
      })
    );
    assert.equal(
      (await stockOf(o1, s5)).quantity,
      quantityBeforeCancel + 1,
      "cancelling an old sale of a locked variant returns its unit"
    );
    tests.push(
      "what was confirmed before replays, and counting, writing off and cancelling a sale of a locked variant stay possible (history stays correctable)"
    );

    // the choice is frozen: no swap, no removal, growth only within the limit
    await expectSelectionRefusal(
      () => choose(o1, [...final.slice(1), s5]),
      "selection_frozen",
      "swapping one variant for another once frozen"
    );
    await expectSelectionRefusal(
      () => choose(o1, final.slice(1)),
      "selection_frozen",
      "removing one once frozen"
    );
    await expectSelectionRefusal(
      () => choose(o1, [...final, s5]),
      "selection_too_large",
      "growing past the limit"
    );
    assert.equal((await choose(o1, final)).phase, "frozen", "the same choice");
    await expectLocked(
      () => sell(o1, s5),
      s5,
      "still locked after the refusals"
    );

    // deleting a chosen variant's product frees a place to grow into
    const dropped = final[0] as string;
    const droppedProduct = await productOf(o1, dropped);
    await as(o1, "product:update", (tx, identity) =>
      deleteProduct(tx, identity, {
        expectedVersion: droppedProduct.version,
        id: droppedProduct.id,
        requestId: randomUUID(),
      })
    );
    const afterDelete = await model(o1);
    assert.equal(afterDelete.liveVariants, 54);
    assert.equal(
      afterDelete.selectedVariantIds.filter((id) => id !== dropped).length,
      49
    );
    const grown = await choose(o1, [...final.slice(1), s5]);
    assert.equal(grown.selectedVariantIds.length, 50);
    await sell(o1, s5);
    await expectLocked(() => sell(o1, s4), s4, "the other one is still locked");
    tests.push(
      "once frozen the choice cannot swap or drop a variant and cannot pass the limit; deleting a chosen variant's product frees one place, and only then can another variant be added"
    );

    // back within the limit: everything is operational again
    await as(o1, "inventory:adjust", async (tx, identity) => {
      const { quantity } = await stockOf(o1, s4);
      await writeOffStock(tx, identity, {
        commandId: randomUUID(),
        commandVersion: 1,
        occurredOn: "2026-10-10",
        quantity,
        reasonCode: "damaged",
        requestId: randomUUID(),
        variantId: s4,
      });
    });
    const toDelete = [
      s4,
      ...leftOut.filter((entry) => entry !== s4 && entry !== s5),
    ];
    await inSequence(toDelete.length, async (index) => {
      const product = await productOf(o1, toDelete[index] as string);
      await as(o1, "product:update", (tx, identity) =>
        deleteProduct(tx, identity, {
          expectedVersion: product.version,
          id: product.id,
          requestId: randomUUID(),
        })
      );
    });
    const within = await model(o1);
    assert.equal(within.liveVariants, 50);
    assert.equal(within.phase, "unrestricted");
    // the variant that was locked is operational again as soon as the organization is within the limit
    await sell(o1, s5);
    tests.push(
      "an organization that returns to the limit (by deleting what it does not use) has every remaining variant operational again"
    );

    // ----------------------------- O2: chose nothing: the default is what sold most recently
    const o2 = await createTenantFixture(admin.pool, "opsel two");
    await plainProducts(o2, 52);
    const o2Sold: string[] = [];
    for (let index = 1; index <= 3; index += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: Three products, in order.
      const product = await createSellableProduct(rt, o2, `D${index}`, {
        cost: "5.00",
        quantity: 10,
      });
      o2Sold.push(product.variantId);
      await sell(o2, product.variantId);
    }
    const o2All = await variantIds(o2);
    assert.equal(o2All.length, 55);
    // time passes: these sales happened ten days ago, before the window that ended a day ago
    await admin.pool.query(
      "UPDATE public.sales SET confirmed_at = confirmed_at - interval '10 days' WHERE organization_id = $1",
      [o2.organizationId]
    );
    await downgrade(o2, 8);
    assert.equal(
      (await selectionRows(o2)).length,
      0,
      "nothing is written until something needs it"
    );
    const oldestUnsold = o2All
      .filter((id) => !o2Sold.includes(id))
      .slice(0, 47);
    const newestUnsold = o2All.filter((id) => !o2Sold.includes(id)).slice(47);
    assert.equal(newestUnsold.length, 5);
    // concurrent first uses: the default is written once, never twice
    const race = await Promise.allSettled([
      sell(o2, o2Sold[0] as string),
      sell(o2, o2Sold[1] as string),
      sell(o2, newestUnsold[0] as string),
      as(o2, "inventory:adjust", (tx, identity) =>
        receiveStock(tx, identity, {
          commandId: randomUUID(),
          commandVersion: 1,
          occurredOn: "2026-10-01",
          quantity: 1,
          unitCost: "5.00",
          variantId: newestUnsold[1] as string,
        })
      ),
    ]);
    for (const outcome of race.slice(0, 2)) {
      assert.equal(
        outcome.status,
        "fulfilled",
        `a kept variant must sell: ${outcome.status === "rejected" ? String(outcome.reason) : ""}`
      );
    }
    for (const outcome of race.slice(2)) {
      assert.equal(outcome.status, "rejected");
      assert.ok(
        outcome.status === "rejected" &&
          outcome.reason instanceof EntitlementVariantLockedError,
        "the ones left out are refused, not broken by the concurrent write"
      );
    }
    const defaultRows = await selectionRows(o2);
    assert.equal(defaultRows.length, 50);
    assert.ok(defaultRows.every((row) => row.source === "default"));
    const defaultIds = new Set(defaultRows.map((row) => row.variant_id));
    for (const id of [...o2Sold, ...oldestUnsold]) {
      assert.ok(defaultIds.has(id), "what sold, then the oldest, is kept");
    }
    for (const id of newestUnsold) {
      assert.ok(!defaultIds.has(id), "the newest unsold are left out");
    }
    const o2Model = await model(o2);
    assert.equal(o2Model.phase, "frozen");
    assert.equal(o2Model.selectedVariantIds.length, 50);
    tests.push(
      "an organization that chose nothing gets the default once the window ends (what sold most recently up to the end of the window, then the oldest), written exactly once under concurrent first uses, and the variants left out are refused"
    );

    // ------------------------ a new episode (Pro again, then Pro ends again) starts over
    await admin.pool.query(
      "UPDATE public.organization_billing SET state = 'active', access_ends_at = now() + interval '30 days', over_limit_since = NULL WHERE organization_id = $1",
      [o2.organizationId]
    );
    assert.equal((await model(o2)).phase, "unrestricted");
    await admin.pool.query(
      "UPDATE public.organization_billing SET state = 'free_over_limit', access_ends_at = NULL, over_limit_since = now() - interval '9 days' WHERE organization_id = $1",
      [o2.organizationId]
    );
    const newEpisode = await model(o2);
    assert.equal(newEpisode.phase, "frozen");
    const fresh = await selectionRows(o2);
    assert.equal(fresh.length, 50);
    assert.equal(
      new Set(fresh.map((row) => row.episode_started_at.getTime())).size,
      1,
      "the rows of the earlier episode were replaced, not mixed in"
    );
    tests.push(
      "the choice of an earlier episode is ignored and replaced when the organization leaves Pro again"
    );

    // ------------------------- no start recorded: frozen at once, never an open window
    const o3 = await createTenantFixture(admin.pool, "opsel three");
    await plainProducts(o3, 51);
    await downgrade(o3, null);
    const o3Model = await model(o3);
    assert.equal(o3Model.phase, "frozen");
    assert.equal(o3Model.windowEndsAt, null);
    assert.equal(o3Model.selectedVariantIds.length, 50);
    const o3Locked = (await variantIds(o3)).find(
      (id) => !o3Model.selectedVariantIds.includes(id)
    ) as string;
    await expectLocked(
      () => receive(o3, o3Locked),
      o3Locked,
      "a record with no start never opens a window"
    );
    // opening a trial checkout on such a record does not give it a fresh window either
    const o3Rows = await selectionRows(o3);
    await billing.startTrial(o3.organizationId, o3.userId, new Date());
    const [o3Setup] = (
      await admin.pool.query<{ since: Date | null; state: string }>(
        "SELECT state, over_limit_since AS since FROM public.organization_billing WHERE organization_id = $1",
        [o3.organizationId]
      )
    ).rows;
    assert.equal(o3Setup?.state, "trial_setup");
    assert.equal(o3Setup?.since, null, "still no start recorded");
    const o3After = await model(o3);
    assert.equal(o3After.phase, "frozen", "still frozen, not a new window");
    assert.deepEqual(
      (await selectionRows(o3)).map((row) => row.variant_id),
      o3Rows.map((row) => row.variant_id),
      "the default is the same set"
    );
    tests.push(
      "a free-over-limit record with no start recorded is frozen at once and stays frozen through a trial checkout: the window is never open by default"
    );

    // ------------------------- abandoning a trial checkout returns to Free Over Limit with the same episode
    const o5 = await createTenantFixture(admin.pool, "opsel five");
    await plainProducts(o5, 51);
    await downgrade(o5, 5);
    const o5Choice = (await variantIds(o5)).slice(0, 50);
    await choose(o5, o5Choice);
    const [o5Before] = (
      await admin.pool.query<{ since: Date | null }>(
        "SELECT over_limit_since AS since FROM public.organization_billing WHERE organization_id = $1",
        [o5.organizationId]
      )
    ).rows;
    assert.ok(o5Before?.since);
    await billing.startTrial(o5.organizationId, o5.userId, new Date());
    await billing.attachProvider(o5.organizationId, "gate", "sub_gate_o5");
    const cancelled = await billing.recordEvent({
      fact: { occurredAt: new Date(), type: "subscription_cancelled" },
      organizationId: o5.organizationId,
      provider: "gate",
      providerEventId: `cancel-${randomUUID()}`,
      providerRef: "sub_gate_o5",
    });
    const abandoned = await billing.processEvent(cancelled.id, new Date());
    assert.equal(abandoned.status, "applied");
    const [o5After] = (
      await admin.pool.query<{ since: Date | null; state: string }>(
        "SELECT state, over_limit_since AS since FROM public.organization_billing WHERE organization_id = $1",
        [o5.organizationId]
      )
    ).rows;
    assert.equal(
      o5After?.state,
      "free_over_limit",
      "still over the limit: back to Free Over Limit, not to plain Free"
    );
    assert.equal(
      o5After?.since?.getTime(),
      o5Before.since.getTime(),
      "the episode did not restart"
    );
    const o5Model = await model(o5);
    assert.equal(o5Model.phase, "adapting", "the window was not cut short");
    assert.deepEqual(
      [...o5Model.selectedVariantIds].sort(),
      [...o5Choice].sort(),
      "the choice was kept"
    );
    tests.push(
      "opening a trial checkout and abandoning it returns an organization that is still over the limit to Free Over Limit, with the same episode start and the same choice (the window is neither cut short nor restarted)"
    );

    // ------------------------- a grant that raised the limit and expired: the choice follows the limit
    const o6 = await createTenantFixture(admin.pool, "opsel six");
    await plainProducts(o6, 52);
    const o6Sold: string[] = [];
    await inSequence(3, async (index) => {
      const product = await createSellableProduct(rt, o6, `G${index + 1}`, {
        cost: "5.00",
        quantity: 10,
      });
      o6Sold.push(product.variantId);
      await sell(o6, product.variantId);
    });
    await admin.pool.query(
      "UPDATE public.sales SET confirmed_at = confirmed_at - interval '10 days' WHERE organization_id = $1",
      [o6.organizationId]
    );
    await admin.pool.query(
      "INSERT INTO public.entitlement_grants (organization_id, key, limit_value, reason, granted_by, expires_at) VALUES ($1, 'variants.active.max', 53, 'gate', 'gate', now() + interval '1 day')",
      [o6.organizationId]
    );
    await downgrade(o6, 8);
    await sell(o6, o6Sold[0] as string);
    const raised = await model(o6);
    assert.equal(raised.limit, 53);
    assert.equal(raised.selectedVariantIds.length, 53);
    await admin.pool.query(
      "UPDATE public.entitlement_grants SET starts_at = now() - interval '2 days', expires_at = now() - interval '1 minute' WHERE organization_id = $1",
      [o6.organizationId]
    );
    const lapsed = await model(o6);
    assert.equal(lapsed.limit, 50);
    assert.equal(lapsed.phase, "frozen");
    assert.equal(
      lapsed.selectedVariantIds.length,
      50,
      "never more operational variants than the limit"
    );
    for (const id of o6Sold) {
      assert.ok(
        lapsed.selectedVariantIds.includes(id),
        "the ones chosen first are the ones kept"
      );
    }
    await sell(o6, o6Sold[1] as string);
    // the choice in force can be submitted again: the organization is never stuck
    const resubmitted = await choose(o6, lapsed.selectedVariantIds);
    assert.equal(resubmitted.selectedVariantIds.length, 50);
    assert.equal(
      (await selectionRows(o6)).length,
      50,
      "the excess was dropped"
    );
    tests.push(
      "when a grant that raised the limit expires, the choice shrinks with it (the earliest chosen stay), the organization can still submit the choice in force, and the rows beyond the limit are dropped"
    );

    // ------------------------- the billing writer sets, keeps and clears the episode start
    const o4 = await createTenantFixture(admin.pool, "opsel four");
    await plainProducts(o4, 51);
    // a paid period nobody renewed, whose grace ran out two days ago
    await admin.pool.query(
      "UPDATE public.organization_billing SET state = 'grace', access_ends_at = now() - interval '2 days' WHERE organization_id = $1",
      [o4.organizationId]
    );
    const accessEnded = (
      await admin.pool.query<{ ends: Date }>(
        "SELECT access_ends_at AS ends FROM public.organization_billing WHERE organization_id = $1",
        [o4.organizationId]
      )
    ).rows[0]?.ends as Date;
    // not swept yet: the window already counts from the end of access
    const beforeSweep = await model(o4);
    assert.equal(beforeSweep.phase, "adapting");
    assert.ok(
      Math.abs(
        (beforeSweep.windowEndsAt as Date).getTime() -
          (accessEnded.getTime() + 7 * DAY_MS)
      ) < 1000,
      "a lapse the sweep has not stored yet is dated by the end of access"
    );
    const swept = await billing.sweepDue(new Date());
    assert.ok(swept.transitioned >= 1);
    const [afterSweep] = (
      await admin.pool.query<{ since: Date | null; state: string }>(
        "SELECT state, over_limit_since AS since FROM public.organization_billing WHERE organization_id = $1",
        [o4.organizationId]
      )
    ).rows;
    assert.equal(afterSweep?.state, "free_over_limit");
    assert.ok(
      afterSweep?.since &&
        Math.abs(afterSweep.since.getTime() - accessEnded.getTime()) < 1000,
      "the sweep stores the end of access, not the moment it ran"
    );
    const afterModel = await model(o4);
    assert.equal(afterModel.phase, "adapting");
    assert.equal(
      afterModel.windowEndsAt?.getTime(),
      beforeSweep.windowEndsAt?.getTime(),
      "the window does not move when the sweep stores the lapse"
    );
    // opening a trial checkout keeps the episode (abandoning it cannot restart the window)
    await billing.startTrial(o4.organizationId, o4.userId, new Date());
    const [duringSetup] = (
      await admin.pool.query<{ since: Date | null; state: string }>(
        "SELECT state, over_limit_since AS since FROM public.organization_billing WHERE organization_id = $1",
        [o4.organizationId]
      )
    ).rows;
    assert.equal(duringSetup?.state, "trial_setup");
    assert.equal(
      duringSetup?.since?.getTime(),
      afterSweep?.since?.getTime(),
      "the episode survives a trial checkout"
    );
    // Pro access again clears it
    await billing.attachProvider(o4.organizationId, "gate", "sub_gate_o4");
    const ready = await billing.recordEvent({
      fact: {
        cycleMonths: 1,
        occurredAt: new Date(),
        type: "trial_method_ready",
      },
      organizationId: o4.organizationId,
      provider: "gate",
      providerEventId: `ready-${randomUUID()}`,
      providerRef: "sub_gate_o4",
    });
    const processed = await billing.processEvent(ready.id, new Date());
    assert.equal(processed.status, "applied");
    const [onTrial] = (
      await admin.pool.query<{ since: Date | null; state: string }>(
        "SELECT state, over_limit_since AS since FROM public.organization_billing WHERE organization_id = $1",
        [o4.organizationId]
      )
    ).rows;
    assert.equal(onTrial?.state, "trialing");
    assert.equal(onTrial?.since, null, "Pro access clears the episode");
    tests.push(
      "the billing writer stores the end of the lapsed access as the episode start (the window is the same before and after the sweep), keeps it through a trial checkout, and clears it when Pro access returns"
    );

    // ------------------------------------------------------------- privileges and RLS
    for (const statement of [
      "UPDATE public.organization_billing SET over_limit_since = now()",
      "UPDATE public.operational_variant_selections SET source = 'user'",
      "UPDATE public.operational_variant_selections SET episode_started_at = now()",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: Three statements, in order.
      await expectSqlState(
        () =>
          withRuntimeSqlContext(runtimeUrl, o2, (client) =>
            client.query(statement)
          ),
        "42501",
        `the tenant cannot: ${statement}`
      );
    }
    const crossTenant = await withRuntimeSqlContext(
      runtimeUrl,
      o3,
      async (client) =>
        (
          await client.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM public.operational_variant_selections WHERE organization_id = $1",
            [o2.organizationId]
          )
        ).rows[0]?.count
    );
    assert.equal(
      crossTenant,
      "0",
      "another organization cannot see the choice"
    );
    const [foreignVariant] = await variantIds(o2);
    const foreignProduct = await productOf(o2, foreignVariant as string);
    const insertSelection = (organizationId: string) => (client: Client) =>
      client.query(
        "INSERT INTO public.operational_variant_selections (organization_id, product_id, variant_id, episode_started_at) VALUES ($1, $2, $3, now())",
        [organizationId, foreignProduct.id, foreignVariant]
      );
    // a row of another organization: row security refuses the write
    await expectSqlState(
      () =>
        withRuntimeSqlContext(
          runtimeUrl,
          o3,
          insertSelection(o2.organizationId)
        ),
      "42501",
      "a row of another organization cannot be written"
    );
    // its own row may not point at another organization's variant either
    await expectSqlState(
      () =>
        withRuntimeSqlContext(
          runtimeUrl,
          o3,
          insertSelection(o3.organizationId)
        ),
      "23503",
      "another organization's variant cannot be chosen"
    );
    tests.push(
      "the tenant cannot edit a choice or the episode start, cannot see another organization's choice, and cannot write into it"
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
    `Operational selection PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
