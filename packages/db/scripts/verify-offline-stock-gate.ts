import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { ProductDeletedError } from "@polaris/domain/catalog/product";
import {
  InsufficientStockError,
  InventoryOccurredInFutureError,
  InventoryVariantNotFoundError,
  InventoryVersionConflictError,
} from "@polaris/domain/inventory/inventory";
import { createDatabase } from "../src/client";
import { registerDevice } from "../src/device-repository";
import {
  inventoryCount,
  receiveStock,
  writeOffStock,
} from "../src/inventory-repository";
import { issueOfflineLeaseGrant } from "../src/offline-lease-repository";
import {
  runSyncCommand,
  type SyncCommandOutcome,
  type SyncJson,
} from "../src/sync-command-repository";
import type { TenantRequestIdentity } from "../src/tenant-transaction";
import {
  eachRound,
  fulfilled,
  lockProductOfVariant,
  raceBehindLock,
  rejections,
} from "./concurrency-support";
import { runClock, storeDay } from "./gate-clock";
import {
  createProductFixture,
  createTenantFixture,
  disposableHostPattern,
  gateBranchPattern,
  journalMigrationCount,
  poolerPattern,
  redactedFailure,
  requiredEnvironment,
  runtimeRole,
  temporaryRuntimeUrl,
  withTenantAs,
} from "./sales-gate-support";

/**
 * Offline stock commands (plan PR56): receive, write-off and physical count
 * through the real `sync.push` frame on the real ledger. The domain calls are
 * the ones the web handlers make, under the same derived identity. Stock is
 * server-authoritative: nothing here lets a device push a balance below zero or
 * overwrite a balance it has not seen.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const hash = (n: number) => n.toString(16).padStart(64, "0");
// the organization's calendar (America/Sao_Paulo), not UTC's, on the clock fixed at the start of the run
const calendarDate = (offsetDays: number) => storeDay(runClock, offsetDays);

const classify = (error: unknown): string | null => {
  if (error instanceof InsufficientStockError) {
    return "insufficient_stock";
  }
  if (error instanceof InventoryVersionConflictError) {
    return "inventory_version_conflict";
  }
  if (error instanceof InventoryVariantNotFoundError) {
    return "variant_not_found";
  }
  if (error instanceof ProductDeletedError) {
    return "product_deleted";
  }
  if (error instanceof InventoryOccurredInFutureError) {
    return "inventory_date_in_future";
  }
  return null;
};

type StockCommand =
  | { kind: "receive"; quantity: number; unitCost: string }
  | { kind: "write_off"; quantity: number }
  | { baseVersion: number; kind: "count"; physicalQuantity: number };

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

    const tenantA = await createTenantFixture(admin.pool, "stock A");
    const tenantB = await createTenantFixture(admin.pool, "stock B");
    const loginSuffix = randomUUID().replaceAll("-", "");
    loginRole = `polaris_stock_gate_${loginSuffix}`;
    const loginPassword = randomBytes(24).toString("hex");
    await admin.pool.query(
      `CREATE ROLE "${loginRole}" WITH LOGIN INHERIT PASSWORD '${loginPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
    );
    await admin.pool.query(`GRANT "${runtimeRole}" TO "${loginRole}"`);
    const runtimeUrl = temporaryRuntimeUrl(adminUrl, loginRole, loginPassword);
    const runtimeDatabase = createDatabase(runtimeUrl, { maxConnections: 10 });
    runtime = runtimeDatabase;
    const { db } = runtimeDatabase;

    const device = await registerDevice(db, tenantA.userId, { label: "Caixa" });
    const issued = await withTenantAs(
      db,
      tenantA,
      "offline:manage",
      (transaction, identity) =>
        issueOfflineLeaseGrant(transaction, identity, { deviceId: device.id })
    );
    const { claims } = issued;
    assert.ok(claims.caps.includes("inventory:adjust"));
    const createdNow = () => new Date(Date.now() - 60_000);

    const { variantId } = await createProductFixture(
      db,
      tenantA,
      "offline stock"
    );

    /** The domain work of a web stock handler, in the sync frame. */
    const push = (
      command: StockCommand,
      options: {
        commandId?: string;
        occurredOn?: string;
        variant?: string;
      } = {}
    ): Promise<SyncCommandOutcome> => {
      const id = options.commandId ?? randomUUID();
      const target = options.variant ?? variantId;
      const occurredOn = options.occurredOn ?? calendarDate(-1);
      return withTenantAs(db, tenantA, "sync:push", (transaction, identity) =>
        runSyncCommand(
          transaction,
          identity,
          {
            commandId: id,
            commandType: `stock.${command.kind}`,
            createdAt: createdNow(),
            deviceId: device.id,
            leaseClaims: claims,
            payloadHash: hash(1),
          },
          async (savepoint): Promise<SyncJson> => {
            const adjusting: TenantRequestIdentity = {
              ...identity,
              capability: "inventory:adjust",
            };
            const base = {
              commandId: id,
              commandVersion: 1,
              occurredOn,
              requestId: id,
              variantId: target,
            };
            let result: Awaited<ReturnType<typeof receiveStock>>;
            if (command.kind === "receive") {
              result = await receiveStock(savepoint, adjusting, {
                ...base,
                quantity: command.quantity,
                unitCost: command.unitCost,
              });
            } else if (command.kind === "write_off") {
              result = await writeOffStock(savepoint, adjusting, {
                ...base,
                quantity: command.quantity,
                reasonCode: "damaged",
              });
            } else {
              result = await inventoryCount(savepoint, adjusting, {
                ...base,
                expectedVersion: command.baseVersion,
                physicalQuantity: command.physicalQuantity,
              });
            }
            return {
              quantity: result.balance.quantity,
              version: result.balance.version,
            };
          },
          classify
        )
      );
    };

    const balance = async (variant = variantId) =>
      (
        await admin.pool.query<{ quantity: number; version: number }>(
          "SELECT quantity, version FROM public.inventory_balances WHERE variant_id = $1",
          [variant]
        )
      ).rows[0];
    const movements = async (variant = variantId) =>
      Number(
        (
          await admin.pool.query<{ n: string }>(
            "SELECT count(*)::text AS n FROM public.stock_movements WHERE variant_id = $1",
            [variant]
          )
        ).rows[0]?.n
      );

    // ------------------------------------ 1. receive, once, replayed unchanged
    const receiveId = randomUUID();
    const received = await push(
      { kind: "receive", quantity: 10, unitCost: "4" },
      { commandId: receiveId }
    );
    assert.equal(received.status, "accepted");
    assert.deepEqual(await balance(), { quantity: 10, version: 1 });
    const replay = await push(
      { kind: "receive", quantity: 10, unitCost: "4" },
      { commandId: receiveId }
    );
    assert.deepEqual(replay, { ...received, replayed: true });
    assert.deepEqual(await balance(), { quantity: 10, version: 1 });
    assert.equal(await movements(), 1);
    tests.push(
      "a received quantity lands once with the balance at version 1; sending the command again replays the stored outcome and adds no movement"
    );

    // ------------ 2. a queue the way a device builds it: the overlay's arithmetic
    // The device shows server row + queued commands and moves the version by one
    // per movement, a count included; its count carries that predicted version.
    const queued: StockCommand[] = [
      { kind: "receive", quantity: 5, unitCost: "6" },
      { kind: "write_off", quantity: 4 },
      { baseVersion: 1 + 2, kind: "count", physicalQuantity: 9 },
    ];
    for (const command of queued) {
      // biome-ignore lint/performance/noAwaitInLoops: the queue is applied in order
      const outcome = await push(command);
      assert.equal(outcome.status, "accepted", JSON.stringify(command));
    }
    assert.deepEqual(await balance(), { quantity: 9, version: 4 });
    tests.push(
      "a queued receive, write-off and count apply in order and the count's predicted base version (server version plus one per queued movement) matches the real ledger"
    );

    // ------------------------------- 3. a write-off below zero is refused whole
    const beforeWriteOff = await movements();
    const tooMuch = await push({ kind: "write_off", quantity: 10 });
    assert.deepEqual(
      { code: tooMuch.code, status: tooMuch.status },
      { code: "insufficient_stock", status: "rejected" }
    );
    assert.deepEqual(await balance(), { quantity: 9, version: 4 });
    assert.equal(await movements(), beforeWriteOff);
    tests.push(
      "a write-off larger than the server balance is refused with insufficient_stock and leaves the balance, the version and the ledger untouched"
    );

    // ------------------ 4. a count against a stale version is refused, not forced
    const beforeCount = await movements();
    const stale = await push({
      baseVersion: 3,
      kind: "count",
      physicalQuantity: 100,
    });
    assert.deepEqual(
      { code: stale.code, status: stale.status },
      { code: "inventory_version_conflict", status: "rejected" }
    );
    assert.deepEqual(await balance(), { quantity: 9, version: 4 });
    assert.equal(await movements(), beforeCount);
    const none = await push(
      { baseVersion: 0, kind: "count", physicalQuantity: 1 },
      { variant: randomUUID() }
    );
    assert.equal(none.code, "variant_not_found");
    tests.push(
      "a count made against a balance that has moved is refused with inventory_version_conflict and overwrites nothing; an unknown variant is variant_not_found"
    );

    // --------------------------------------- 5. dates in the future are refused
    const late = await push(
      { kind: "receive", quantity: 1, unitCost: "1" },
      { occurredOn: calendarDate(3) }
    );
    assert.equal(late.code, "inventory_date_in_future");
    assert.deepEqual(await balance(), { quantity: 9, version: 4 });
    tests.push(
      "a movement dated after the organization's today is refused and changes nothing"
    );

    // The races hold the product lock first, release their racers from one start
    // barrier and fail if the database never saw them blocked on a lock
    // (concurrency-support.ts); each round repeats them on a replenished balance.
    const lockStock = [lockProductOfVariant(variantId)];
    const rounds = await eachRound(async () => {
      // -- 6. two devices race: the ledger lets one count win and the other conflict
      const baseline = await balance();
      assert.ok(baseline);
      const { results: racingResults } = await raceBehindLock({
        adminUrl,
        hold: lockStock,
        label: "two counts over the same balance version",
        racers: [20, 30].map(
          (physicalQuantity) => () =>
            push({
              baseVersion: baseline.version,
              kind: "count",
              physicalQuantity,
            })
        ),
      });
      assert.deepEqual(rejections(racingResults), []);
      const racing = fulfilled(racingResults);
      assert.equal(
        racing.filter((outcome) => outcome.status === "accepted").length,
        1
      );
      assert.equal(
        racing.filter(
          (outcome) => outcome.code === "inventory_version_conflict"
        ).length,
        1
      );
      const final = await balance();
      assert.equal(final?.version, baseline.version + 1);
      assert.ok(final?.quantity === 20 || final?.quantity === 30);

      // ---- 7. two write-offs race for the same stock: the balance never goes negative
      const before = await balance();
      assert.ok(before);
      const half = Math.floor(before.quantity / 2) + 1;
      const { results: writerResults } = await raceBehindLock({
        adminUrl,
        hold: lockStock,
        label: "two write-offs that cannot both be honoured",
        racers: [0, 1].map(
          () => () => push({ kind: "write_off", quantity: half })
        ),
      });
      assert.deepEqual(rejections(writerResults), []);
      const writers = fulfilled(writerResults);
      const statuses = writers.map((outcome) => outcome.status).sort();
      assert.deepEqual(statuses, ["accepted", "rejected"]);
      assert.ok(
        writers.some((outcome) => outcome.code === "insufficient_stock")
      );
      const after = await balance();
      assert.equal(after?.quantity, before.quantity - half);
      assert.ok((after?.quantity ?? -1) >= 0);
    });
    tests.push(
      `two counts against the same balance version racing: exactly one is accepted, the other is an inventory_version_conflict (${rounds} round(s), released from a barrier with the racers seen blocked on the lock)`
    );
    tests.push(
      "two write-offs that cannot both be honoured race: one is accepted, the other is insufficient_stock and the balance never goes negative"
    );

    // -------------------------------------- 8. another organization cannot touch it
    await withTenantAs(db, tenantB, "inventory:adjust", (tx, identity) =>
      assert.rejects(
        receiveStock(tx, identity, {
          commandId: randomUUID(),
          commandVersion: 1,
          occurredOn: calendarDate(-1),
          quantity: 1,
          unitCost: "1",
          variantId,
        }),
        InventoryVariantNotFoundError
      )
    );
    tests.push(
      "another organization cannot receive stock against this variant: it does not exist for them"
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
    `Offline stock PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
