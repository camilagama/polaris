import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  InsufficientStockError,
  InventoryVariantNotFoundError,
} from "@polaris/domain/inventory/inventory";
import {
  SaleOccurredInFutureError,
  SaleProductUnavailableError,
} from "@polaris/domain/sales/confirm-sale";
import { SaleOccurredTooOldError } from "@polaris/domain/sales/sale-dates";
import { createDatabase } from "../src/client";
import { registerDevice } from "../src/device-repository";
import { receiveStock } from "../src/inventory-repository";
import { issueOfflineLeaseGrant } from "../src/offline-lease-repository";
import { confirmSale } from "../src/sale-repository";
import {
  runSyncCommand,
  type SyncCommandOutcome,
  type SyncJson,
} from "../src/sync-command-repository";
import type { TenantRequestIdentity } from "../src/tenant-transaction";
import {
  createSellableProduct,
  createTenantFixture,
  disposableHostPattern,
  gateBranchPattern,
  journalMigrationCount,
  poolerPattern,
  recentInstant,
  redactedFailure,
  requiredEnvironment,
  runtimeRole,
  temporaryRuntimeUrl,
  withTenantAs,
} from "./sales-gate-support";

/**
 * A sale made offline (plan PR57), through the real `sync.push` frame and the
 * real `confirmSale`. The server is the stock authority: a sale that does not
 * fit is refused whole and leaves no trace; a device resubmits it as a NEW
 * command once the cause is fixed.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const DAY = 86_400_000;
const hash = (n: number) => n.toString(16).padStart(64, "0");
const instantDaysAgo = (days: number) =>
  new Date(Date.now() - days * DAY).toISOString();

const classify = (error: unknown): string | null => {
  if (error instanceof InsufficientStockError) {
    return "insufficient_stock";
  }
  if (error instanceof SaleProductUnavailableError) {
    return "sale_product_unavailable";
  }
  if (error instanceof InventoryVariantNotFoundError) {
    return "variant_not_found";
  }
  if (error instanceof SaleOccurredTooOldError) {
    return "sale_occurred_too_old";
  }
  if (error instanceof SaleOccurredInFutureError) {
    return "sale_occurred_in_future";
  }
  return null;
};

interface Line {
  chargedUnitPrice?: string;
  quantity: number;
  variantId: string;
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

    const tenantA = await createTenantFixture(admin.pool, "sale A");
    const tenantB = await createTenantFixture(admin.pool, "sale B");
    const loginSuffix = randomUUID().replaceAll("-", "");
    loginRole = `polaris_sale_gate_${loginSuffix}`;
    const loginPassword = randomBytes(24).toString("hex");
    await admin.pool.query(
      `CREATE ROLE "${loginRole}" WITH LOGIN INHERIT PASSWORD '${loginPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
    );
    await admin.pool.query(`GRANT "${runtimeRole}" TO "${loginRole}"`);
    const runtimeUrl = temporaryRuntimeUrl(adminUrl, loginRole, loginPassword);
    const runtimeDatabase = createDatabase(runtimeUrl, { maxConnections: 10 });
    runtime = runtimeDatabase;
    const { db } = runtimeDatabase;
    const gateRuntime = { adminPool: admin.pool, db };

    const device = await registerDevice(db, tenantA.userId, { label: "Caixa" });
    const issued = await withTenantAs(
      db,
      tenantA,
      "offline:manage",
      (transaction, identity) =>
        issueOfflineLeaseGrant(transaction, identity, { deviceId: device.id })
    );
    const { claims } = issued;
    assert.ok(claims.caps.includes("sale:create"));
    const createdNow = () => new Date(Date.now() - 60_000);

    /** What the web `sale.confirm` handler does, in the sync frame. */
    const pushSale = (
      id: string,
      lines: Line[],
      options: { occurredAt?: string; recordedAt?: string } = {}
    ): Promise<SyncCommandOutcome> =>
      withTenantAs(db, tenantA, "sync:push", (transaction, identity) =>
        runSyncCommand(
          transaction,
          identity,
          {
            commandId: id,
            commandType: "sale.confirm",
            createdAt: createdNow(),
            deviceId: device.id,
            leaseClaims: claims,
            payloadHash: hash(1),
          },
          async (savepoint): Promise<SyncJson> => {
            const selling: TenantRequestIdentity = {
              ...identity,
              capability: "sale:create",
            };
            const occurredAt = options.occurredAt ?? recentInstant(2);
            const result = await confirmSale(savepoint, selling, {
              adjustments: [],
              commandId: id,
              commandVersion: 1,
              items: lines.map((line) => ({
                chargedUnitPrice: line.chargedUnitPrice ?? "19.90",
                listedUnitPrice: "20.00",
                quantity: line.quantity,
                variantId: line.variantId,
              })),
              occurredAt,
              payment: { anticipationRequested: false, method: "pix" },
              paymentProfile: null,
              recordedAt: options.recordedAt ?? recentInstant(1),
              requestId: id,
            });
            return {
              saleId: result.sale.id,
              totalDue: result.totals.totalDue,
            };
          },
          classify
        )
      );

    const balance = async (variantId: string) =>
      (
        await admin.pool.query<{ quantity: number; version: number }>(
          "SELECT quantity, version FROM public.inventory_balances WHERE variant_id = $1",
          [variantId]
        )
      ).rows[0];
    const count = async (sql: string, ...params: unknown[]) =>
      Number(
        (await admin.pool.query<{ n: string }>(sql, params)).rows[0]?.n ?? "-1"
      );
    const salesOf = (commandId: string) =>
      count(
        "SELECT count(*)::text AS n FROM public.sales WHERE organization_id = $1 AND command_id = $2",
        tenantA.organizationId,
        commandId
      );
    const saleMovements = (variantId: string) =>
      count(
        "SELECT count(*)::text AS n FROM public.stock_movements WHERE variant_id = $1 AND movement_type = 'sale'",
        variantId
      );

    const shirt = await createSellableProduct(gateRuntime, tenantA, "camisa", {
      cost: "8.00",
      quantity: 5,
    });
    const sock = await createSellableProduct(gateRuntime, tenantA, "meia", {
      cost: "2.00",
      quantity: 20,
    });
    // balances after the opening receipt: version 1 each

    // -------------- 1. confirmed once, evidence kept, replayed unchanged
    const firstId = randomUUID();
    const recorded = Date.now();
    const first = await pushSale(firstId, [
      { quantity: 2, variantId: shirt.variantId },
      { quantity: 3, variantId: sock.variantId },
    ]);
    assert.equal(first.status, "accepted");
    assert.deepEqual(await balance(shirt.variantId), {
      quantity: 3,
      version: 2,
    });
    assert.deepEqual(await balance(sock.variantId), {
      quantity: 17,
      version: 2,
    });
    const saved = await admin.pool.query<{
      recorded_at: Date;
      occurred_at: Date;
    }>(
      "SELECT recorded_at, occurred_at FROM public.sales WHERE organization_id = $1 AND command_id = $2",
      [tenantA.organizationId, firstId]
    );
    assert.equal(saved.rows.length, 1);
    assert.ok(
      saved.rows[0]?.recorded_at,
      "the device's recordedAt is kept as evidence"
    );
    assert.ok(
      (saved.rows[0]?.occurred_at.getTime() ?? Number.NaN) < recorded,
      "the commercial time is the sale's, not the sync's"
    );
    const replay = await pushSale(firstId, [
      { quantity: 2, variantId: shirt.variantId },
      { quantity: 3, variantId: sock.variantId },
    ]);
    assert.deepEqual(replay, { ...first, replayed: true });
    assert.equal(await salesOf(firstId), 1);
    assert.deepEqual(await balance(shirt.variantId), {
      quantity: 3,
      version: 2,
    });
    tests.push(
      "an offline sale is confirmed once with the device's recordedAt as evidence and its own commercial time; sending it again replays the outcome and takes no more stock"
    );

    // -------------- 1b. the SAME sale sent directly first, then kept on the device
    // The web screen can lose the answer of a direct send and then keep the sale
    // on the device. Both paths use `confirmSale` with the same command ID and the
    // same content, so the device's copy must be recognized, not recorded twice.
    const pants = await createSellableProduct(gateRuntime, tenantA, "calca", {
      cost: "5.00",
      quantity: 4,
    });
    const crossId = randomUUID();
    const crossOccurredAt = recentInstant(2);
    const direct = await withTenantAs(
      db,
      tenantA,
      "sale:create",
      (transaction, identity) =>
        confirmSale(transaction, identity, {
          adjustments: [],
          commandId: crossId,
          commandVersion: 1,
          items: [
            {
              chargedUnitPrice: "19.90",
              listedUnitPrice: "20.00",
              quantity: 1,
              variantId: pants.variantId,
            },
          ],
          // no typed date: the instant of the attempt is both times
          occurredAt: crossOccurredAt,
          payment: { anticipationRequested: false, method: "pix" },
          paymentProfile: null,
          recordedAt: crossOccurredAt,
          requestId: randomUUID(),
        })
    );
    assert.equal(direct.replayed, false);
    const afterDirect = await balance(pants.variantId);
    const viaDevice = await pushSale(
      crossId,
      [{ quantity: 1, variantId: pants.variantId }],
      { occurredAt: crossOccurredAt, recordedAt: crossOccurredAt }
    );
    assert.equal(viaDevice.status, "accepted");
    assert.equal(
      (viaDevice as { result?: { saleId?: string } }).result?.saleId,
      direct.sale.id,
      "the device's copy is the sale the direct send already recorded"
    );
    assert.equal(await salesOf(crossId), 1);
    assert.deepEqual(
      await balance(pants.variantId),
      afterDirect,
      "no second movement of stock"
    );
    tests.push(
      "a sale first sent directly (answer lost) and then sent from the device with the same command ID and content is recognized as the same sale: one sale, one movement per line"
    );

    // ---- 2. the overlay's arithmetic: one version step per line, repeated lines included
    const beforeShirt = await balance(shirt.variantId);
    assert.ok(beforeShirt);
    const twoLines = await pushSale(randomUUID(), [
      { quantity: 1, variantId: shirt.variantId },
      { quantity: 1, variantId: shirt.variantId },
    ]);
    assert.equal(twoLines.status, "accepted");
    assert.deepEqual(await balance(shirt.variantId), {
      quantity: beforeShirt.quantity - 2,
      version: beforeShirt.version + 2,
    });
    tests.push(
      "each sale line is one stock movement: the balance version moves one step per line, repeated lines of a variant included, which is what a device's shown stock assumes"
    );

    // ------- 3. stock the sale does not fit: refused whole, no trace
    const sockBefore = await balance(sock.variantId);
    const shirtBefore = await balance(shirt.variantId);
    const tooMuchId = randomUUID();
    const refused = await pushSale(tooMuchId, [
      { quantity: 2, variantId: sock.variantId },
      { quantity: 50, variantId: shirt.variantId },
    ]);
    assert.deepEqual(
      { code: refused.code, status: refused.status },
      { code: "insufficient_stock", status: "rejected" }
    );
    assert.equal(await salesOf(tooMuchId), 0);
    assert.deepEqual(await balance(sock.variantId), sockBefore);
    assert.deepEqual(await balance(shirt.variantId), shirtBefore);
    assert.equal(
      await count(
        "SELECT count(*)::text AS n FROM public.stock_movements WHERE command_id = $1",
        tooMuchId
      ),
      0
    );
    assert.equal(
      await count(
        "SELECT count(*)::text AS n FROM public.sale_payments p JOIN public.sales s ON s.id = p.sale_id WHERE s.command_id = $1",
        tooMuchId
      ),
      0
    );
    tests.push(
      "a sale whose second line does not fit is insufficient_stock: no sale, no payment, no movement, and the first line's stock was never taken"
    );

    // --- 4. the rejection is final for that command; a new command resubmits
    const replayedRefusal = await pushSale(tooMuchId, [
      { quantity: 2, variantId: sock.variantId },
      { quantity: 50, variantId: shirt.variantId },
    ]);
    assert.deepEqual(replayedRefusal, { ...refused, replayed: true });
    // the missing stock arrives, the device resubmits the same sale as a new command
    await withTenantAs(
      db,
      tenantA,
      "inventory:adjust",
      async (transaction, identity) => {
        await receiveStock(transaction, identity, {
          commandId: randomUUID(),
          commandVersion: 1,
          occurredOn: new Date(Date.now() - 2 * DAY).toISOString().slice(0, 10),
          quantity: 60,
          unitCost: "8.00",
          variantId: shirt.variantId,
        });
      }
    );
    const resubmitted = await pushSale(randomUUID(), [
      { quantity: 2, variantId: sock.variantId },
      { quantity: 50, variantId: shirt.variantId },
    ]);
    assert.equal(resubmitted.status, "accepted");
    tests.push(
      "the refusal is stored and replayed for its command ID (sending it again cannot succeed); once the stock arrives, the same sale sent as a new command is confirmed, exactly once"
    );

    // ------------------------------------------- 5. commercial dates
    const stale = await pushSale(
      randomUUID(),
      [{ quantity: 1, variantId: sock.variantId }],
      { occurredAt: instantDaysAgo(90) }
    );
    assert.equal(stale.code, "sale_occurred_too_old");
    const future = await pushSale(
      randomUUID(),
      [{ quantity: 1, variantId: sock.variantId }],
      { occurredAt: new Date(Date.now() + DAY).toISOString() }
    );
    assert.equal(future.code, "sale_occurred_in_future");
    tests.push(
      "a sale older than the organization's retroactive window is sale_occurred_too_old and one dated ahead of the server clock is sale_occurred_in_future, both without effect"
    );

    // --------------- 6. two devices race for the last units
    const scarce = await createSellableProduct(gateRuntime, tenantA, "rara", {
      cost: "5.00",
      quantity: 3,
    });
    const race = await Promise.all([
      pushSale(randomUUID(), [{ quantity: 2, variantId: scarce.variantId }]),
      pushSale(randomUUID(), [{ quantity: 2, variantId: scarce.variantId }]),
    ]);
    assert.deepEqual(race.map((outcome) => outcome.status).sort(), [
      "accepted",
      "rejected",
    ]);
    assert.ok(race.some((outcome) => outcome.code === "insufficient_stock"));
    const left = await balance(scarce.variantId);
    assert.equal(left?.quantity, 1);
    assert.equal(await saleMovements(scarce.variantId), 1);
    tests.push(
      "two sales racing for the same last units: one is confirmed, the other is insufficient_stock, and stock never goes negative"
    );

    // ----------------------- 7. another organization cannot sell this variant
    await assert.rejects(
      withTenantAs(db, tenantB, "sale:create", (transaction, identity) =>
        confirmSale(transaction, identity, {
          adjustments: [],
          commandId: randomUUID(),
          commandVersion: 1,
          items: [
            {
              chargedUnitPrice: "19.90",
              listedUnitPrice: "20.00",
              quantity: 1,
              variantId: sock.variantId,
            },
          ],
          occurredAt: recentInstant(2),
          payment: { anticipationRequested: false, method: "pix" },
          paymentProfile: null,
        })
      )
    );
    tests.push(
      "another organization cannot sell this variant: it does not exist for them"
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
    `Offline sale PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
