import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readBootstrapPage } from "@polaris/db/bootstrap-repository";
import { createDatabase } from "@polaris/db/client";
import { registerDevice, revokeDevice } from "@polaris/db/device-repository";
import { receiveStock, writeOffStock } from "@polaris/db/inventory-repository";
import { issueOfflineLeaseGrant } from "@polaris/db/offline-lease-repository";
import { runSyncCommand } from "@polaris/db/sync-command-repository";
import { getSyncCursor, pullSyncChanges } from "@polaris/db/sync-repository";
import {
  type TenantRequestIdentity,
  type TenantRequestTransaction,
  withAuthorizedTenantTransaction,
} from "@polaris/db/tenant-transaction";
import { signOfflineLease } from "../src/lib/offline-lease-token";
import {
  buildAttention,
  discardAttentionItem,
  resubmitAttentionItem,
} from "../src/offline/attention";
import {
  type BootstrapSource,
  bootstrapLocalStore,
} from "../src/offline/bootstrap";
import { createOfflineCustomer } from "../src/offline/customer-create";
import { MemoryOutboxStorage } from "../src/offline/outbox/memory-storage";
import { Outbox } from "../src/offline/outbox/outbox";
import { createOfflineProduct } from "../src/offline/product-create";
import { createOfflineSale, pendingSales } from "../src/offline/sale-confirm";
import {
  countStockOffline,
  effectiveStock,
  receiveStockOffline,
  writeOffStockOffline,
} from "../src/offline/stock-commands";
import { syncOutbox } from "../src/offline/sync-runner";
import { FakeWriter } from "../src/offline/test-support";
import { pushCommands } from "../src/server/sync/push";
import { syncCommandHandlers } from "../src/server/sync/registry";

/**
 * Gate 5, end to end (plan: "Offline só é considerado pronto quando..."): the
 * real offline CLIENT (outbox, command builders, sync runner, attention) talking
 * to the real SERVER code (`sync.push` orchestration, lease verification, every
 * registered handler) over the real database, with an independent oracle for the
 * numbers. It proves, in one story, that: a device can work for a while without
 * a connection and everything lands correctly; sending twice is safe; stock
 * conflicts are refused without corrupting anything and are fixable from the
 * client; a taken SKU and a revoked access are refused whole; and the ledger
 * still explains every balance afterwards.
 *
 * It does not prove the physical device (iPhone Safari / Android Chrome): that
 * remains the manual go-live check.
 */
const neonHostPattern =
  /^ep-[a-z-]+-[a-z0-9]+\.c-2\.sa-east-1\.aws\.neon\.tech$/;
const branchPattern = /^pr\d+-[a-z0-9-]+-gate$/;
const localHostPattern = /^(localhost|127\.0\.0\.1|postgres)$/;
const poolerPattern = /pooler/i;
const runtimeRole = "polaris_pr11_runtime";
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";
const DAY = 86_400_000;
const droppedPattern = /dropped the response/;
const dateDaysAgo = (days: number) =>
  // the organization's calendar (America/Sao_Paulo), not UTC's
  new Date(Date.now() - days * DAY).toLocaleDateString("en-CA", {
    timeZone: "America/Sao_Paulo",
  });

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}.`);
  }
  return value;
}

type Database = ReturnType<typeof createDatabase>["db"];

interface Tenant {
  organizationId: string;
  userId: string;
}

async function createTenant(
  pool: ReturnType<typeof createDatabase>["pool"],
  label: string
): Promise<Tenant> {
  const userId = randomUUID();
  const organizationId = randomUUID();
  await pool.query(
    'INSERT INTO public."user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)',
    [userId, `Gate 5 ${label}`, `gate5-${userId}@example.invalid`]
  );
  await pool.query(
    "INSERT INTO public.organizations (id, name, timezone) VALUES ($1, $2, 'America/Sao_Paulo')",
    [organizationId, `Gate 5 ${label}`]
  );
  await pool.query(
    "INSERT INTO public.memberships (organization_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')",
    [organizationId, userId]
  );
  // offline writes are a Pro capability: the e2e organization is a paid one
  await pool.query(
    "INSERT INTO public.organization_billing (organization_id, state, access_ends_at) VALUES ($1, 'active', now() + interval '365 days')",
    [organizationId]
  );
  return { organizationId, userId };
}

function redactedFailure(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`.replace(
      /postgres(?:ql)?:\/\/\S+/gi,
      "[redacted]"
    );
  }
  return "unknown failure";
}

async function run() {
  const branch = requiredEnvironment("POLARIS_SALES_GATE_BRANCH");
  assert.match(branch, branchPattern);
  const adminUrl = requiredEnvironment("POLARIS_SALES_GATE_DATABASE_URL");
  const parsedAdminUrl = new URL(adminUrl);
  assert.ok(
    neonHostPattern.test(parsedAdminUrl.hostname) ||
      (process.env.CI === "true" &&
        localHostPattern.test(parsedAdminUrl.hostname))
  );
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
    tests.push(
      "disposable PostgreSQL 18 database with every migration applied"
    );

    const tenant = await createTenant(admin.pool, "offline e2e");
    const loginSuffix = randomUUID().replaceAll("-", "");
    loginRole = `polaris_e2e_gate_${loginSuffix}`;
    const loginPassword = randomBytes(24).toString("hex");
    await admin.pool.query(
      `CREATE ROLE "${loginRole}" WITH LOGIN INHERIT PASSWORD '${loginPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
    );
    await admin.pool.query(`GRANT "${runtimeRole}" TO "${loginRole}"`);
    const runtimeUrl = new URL(adminUrl);
    runtimeUrl.username = loginRole;
    runtimeUrl.password = loginPassword;
    runtime = createDatabase(runtimeUrl.toString(), { maxConnections: 10 });
    const db: Database = runtime.db;

    const asTenant = <T>(
      capability: string,
      operation: (
        transaction: TenantRequestTransaction,
        identity: TenantRequestIdentity
      ) => Promise<T>
    ) =>
      withAuthorizedTenantTransaction(
        db,
        {
          authenticatedUserId: tenant.userId,
          capability,
          requestedOrganizationId: tenant.organizationId,
        },
        operation
      );

    // ---- the server side: keys, handlers, the real push orchestration
    const key = { id: "gate", secret: randomBytes(32).toString("hex") };
    const pushDependencies = {
      handlers: syncCommandHandlers,
      keys: { signing: key, verification: [key] },
      now: () => new Date(),
      runSyncCommand,
      withTenant: <T>(
        operation: (
          transaction: TenantRequestTransaction,
          identity: TenantRequestIdentity
        ) => Promise<T>
      ) => asTenant("sync:push", operation),
    };

    // ---- a device: registered, granted, with a signed lease and a local store
    async function enroll(label: string) {
      const device = await registerDevice(db, tenant.userId, { label });
      const issued = await asTenant("offline:manage", (transaction, identity) =>
        issueOfflineLeaseGrant(transaction, identity, { deviceId: device.id })
      );
      const lease = await signOfflineLease(issued.claims, key);
      return { deviceId: device.id, lease };
    }

    const source: BootstrapSource = {
      getCursor: async () =>
        String(await asTenant("sync:read", (tx, id) => getSyncCursor(tx, id))),
      page: async (collection, request) => {
        const page = await asTenant("sync:read", (tx, id) =>
          readBootstrapPage(tx, id, {
            afterId: request.afterId ?? null,
            collection,
            ids: request.ids ?? null,
            limit: request.limit ?? 200,
          })
        );
        return {
          nextAfterId: page.nextAfterId,
          rows: page.rows,
        } as never;
      },
      pull: async (cursor, limit) => {
        const result = await asTenant("sync:read", (tx, id) =>
          pullSyncChanges(tx, id, { cursor, limit })
        );
        return {
          changes: result.changes,
          hasMore: result.hasMore,
          nextCursor: String(result.nextCursor),
        };
      },
      recentSales: () => Promise.resolve([]),
    };

    async function openDevice(label: string) {
      const { deviceId, lease } = await enroll(label);
      const outbox = new Outbox({
        deviceId,
        organizationId: tenant.organizationId,
        storage: new MemoryOutboxStorage(),
        userId: tenant.userId,
      });
      const writer = new FakeWriter();
      await bootstrapLocalStore(source, writer);
      let dropResponses = 0;
      const push = async (input: {
        commands: Parameters<typeof pushCommands>[0];
      }) => {
        const results = await pushCommands(input.commands, pushDependencies);
        if (dropResponses > 0) {
          dropResponses -= 1;
          throw new Error("the network dropped the response");
        }
        return { results };
      };
      return {
        base: {
          deviceId,
          lease,
          organizationId: tenant.organizationId,
          outbox,
          writer,
        },
        deviceId,
        dropNextResponses: (responses: number) => {
          dropResponses = responses;
        },
        lease,
        outbox,
        sync: () => syncOutbox({ outbox, pull: { source, writer }, push }),
        writer,
      };
    }

    const count = async (sql: string, ...params: unknown[]) =>
      Number(
        (await admin.pool.query<{ n: string }>(sql, params)).rows[0]?.n ?? "-1"
      );
    const stockOf = async (variantId: string) =>
      (
        await admin.pool.query<{ quantity: number; version: number }>(
          "SELECT quantity, version FROM public.inventory_balances WHERE variant_id = $1",
          [variantId]
        )
      ).rows[0];

    // ======================================================================
    // 1. A device works offline for a while, then syncs (with a lost response)
    // ======================================================================
    const d1 = await openDevice("Caixa 1");
    const ana = await createOfflineCustomer({
      ...d1.base,
      input: { name: "Ana Souza", phone: "+5511999990000" },
    });
    const shirt = await createOfflineProduct({
      ...d1.base,
      input: {
        initialStock: {
          occurredOn: dateDaysAgo(2),
          quantity: 10,
          unitCost: "20",
        },
        listPrice: "50.00",
        name: "Camiseta E2E",
        sku: "E2E-A",
      },
    });
    const sock = await createOfflineProduct({
      ...d1.base,
      input: {
        initialStock: {
          occurredOn: dateDaysAgo(2),
          quantity: 2,
          unitCost: "4",
        },
        listPrice: "10.00",
        name: "Meia E2E",
      },
    });
    const shirtVariant = shirt.rows.variant.id;
    const sockVariant = sock.rows.variant.id;
    const reader = { reader: d1.writer };
    await receiveStockOffline({
      ...d1.base,
      ...reader,
      occurredOn: dateDaysAgo(1),
      quantity: 5,
      unitCost: "30",
      variantId: shirtVariant,
    });
    const sale = await createOfflineSale({
      ...d1.base,
      ...reader,
      adjustments: [
        { kind: "freight", value: { amount: "10.00", type: "fixed" } },
      ],
      lines: [
        { chargedUnitPrice: "45.00", quantity: 3, variantId: shirtVariant },
        { quantity: 1, variantId: sockVariant },
      ],
      payment: { method: "pix" },
    });
    assert.equal(
      sale.totalDue,
      "155.00",
      "the device computes the same total as the oracle"
    );
    await writeOffStockOffline({
      ...d1.base,
      ...reader,
      occurredOn: dateDaysAgo(0),
      quantity: 1,
      reasonCode: "damaged",
      variantId: shirtVariant,
    });
    await countStockOffline({
      ...d1.base,
      ...reader,
      occurredOn: dateDaysAgo(0),
      physicalQuantity: 4,
      variantId: sockVariant,
    });

    // what the device shows before it ever reaches the server
    const predictedShirt = await effectiveStock(
      d1.outbox,
      d1.writer,
      shirtVariant
    );
    const predictedSock = await effectiveStock(
      d1.outbox,
      d1.writer,
      sockVariant
    );
    assert.deepEqual(predictedShirt, { quantity: 11, version: 4 });
    assert.deepEqual(predictedSock, { quantity: 4, version: 3 });
    assert.equal((await d1.outbox.snapshot()).commands.length, 7);

    d1.dropNextResponses(1);
    await assert.rejects(d1.sync(), droppedPattern);
    // the server did the work, the device does not know: everything is still queued
    assert.equal((await d1.outbox.snapshot()).commands.length, 7);
    const second = await d1.sync();
    assert.equal(second.accepted, 7);
    assert.equal(
      second.replayed,
      second.accepted,
      "every command was replayed, none executed twice"
    );
    assert.equal((await d1.outbox.snapshot()).commands.length, 0);
    tests.push(
      "a device queues a customer, two products with opening stock, a receipt, a sale with freight, a write-off and a count while offline; the first response is lost; the second sync replays all seven commands and executes none twice"
    );

    // the database against the oracle
    assert.deepEqual(await stockOf(shirtVariant), { quantity: 11, version: 4 });
    assert.deepEqual(await stockOf(sockVariant), { quantity: 4, version: 3 });
    assert.deepEqual(
      { quantity: predictedShirt.quantity, version: predictedShirt.version },
      await stockOf(shirtVariant),
      "what the device predicted is what the server holds"
    );
    assert.equal(
      await count(
        "SELECT count(*)::text AS n FROM public.sync_commands WHERE organization_id = $1",
        tenant.organizationId
      ),
      7,
      "one stored outcome per command"
    );
    const saleTotals = await admin.pool.query<{
      amount: string;
      items: string;
      subtotal: string;
    }>(
      `SELECT p.amount::text AS amount,
              (SELECT sum(i.charged_unit_price * i.quantity)::text FROM public.sale_items i WHERE i.sale_id = s.id) AS subtotal,
              (SELECT count(*)::text FROM public.sale_items i WHERE i.sale_id = s.id) AS items
         FROM public.sales s JOIN public.sale_payments p ON p.sale_id = s.id
        WHERE s.organization_id = $1`,
      [tenant.organizationId]
    );
    assert.equal(saleTotals.rows.length, 1);
    assert.equal(saleTotals.rows[0]?.items, "2");
    assert.equal(Number(saleTotals.rows[0]?.subtotal), 3 * 45 + 1 * 10);
    assert.equal(Number(saleTotals.rows[0]?.amount), 3 * 45 + 1 * 10 + 10);
    const reconciled = await admin.pool.query<{ ok: boolean }>(
      `SELECT bool_and(b.quantity = coalesce((SELECT sum(m.quantity_delta) FROM public.stock_movements m WHERE m.variant_id = b.variant_id), 0)) AS ok
         FROM public.inventory_balances b WHERE b.organization_id = $1`,
      [tenant.organizationId]
    );
    assert.equal(
      reconciled.rows[0]?.ok,
      true,
      "the ledger explains every balance"
    );
    assert.equal(
      await count(
        "SELECT count(*)::text AS n FROM public.stock_movements WHERE variant_id = $1",
        shirtVariant
      ),
      4
    );
    // the device converged to the server's rows
    assert.deepEqual(d1.writer.stock(shirtVariant), {
      productId: shirt.rows.product.id,
      quantity: 11,
      updatedAt: d1.writer.stock(shirtVariant)?.updatedAt,
      variantId: shirtVariant,
      version: 4,
    });
    assert.equal(d1.writer.customer(ana.customer.id)?.name, "Ana Souza");
    assert.equal(d1.writer.variant(shirtVariant)?.sku, "E2E-A");
    tests.push(
      "the database matches an independent oracle: balances 11 and 4 at the versions the device predicted, one stored outcome per command, sale subtotal and total in cents, and the ledger explains every balance"
    );

    // ======================================================================
    // 2. A stock conflict: refused without corruption, fixed from the client
    // ======================================================================
    const device = d1;
    await device.sync(); // current
    await createOfflineSale({
      ...device.base,
      ...reader,
      lines: [
        { chargedUnitPrice: "45.00", quantity: 8, variantId: shirtVariant },
      ],
      payment: { method: "pix" },
    });
    const staleCount = await countStockOffline({
      ...device.base,
      ...reader,
      occurredOn: dateDaysAgo(0),
      physicalQuantity: 5,
      variantId: shirtVariant,
    });
    // meanwhile, another device (online) writes off most of the stock
    await asTenant("inventory:adjust", (tx, identity) =>
      writeOffStock(tx, identity, {
        commandId: randomUUID(),
        commandVersion: 1,
        occurredOn: dateDaysAgo(0),
        quantity: 9,
        reasonCode: "lost",
        variantId: shirtVariant,
      })
    );
    assert.deepEqual(await stockOf(shirtVariant), { quantity: 2, version: 5 });

    const refused = await device.sync();
    assert.equal(refused.rejected, 1);
    assert.equal(refused.notProcessed, 1);
    assert.deepEqual(
      await stockOf(shirtVariant),
      { quantity: 2, version: 5 },
      "the refused sale took nothing"
    );
    assert.equal(
      await count(
        "SELECT count(*)::text AS n FROM public.sales WHERE organization_id = $1",
        tenant.organizationId
      ),
      1,
      "no second sale"
    );
    const attention = buildAttention(await device.outbox.snapshot());
    assert.equal(attention.items.length, 1);
    assert.equal(attention.items[0]?.cause, "insufficient_stock");
    assert.deepEqual(attention.items[0]?.actions, ["resubmit", "discard"]);
    assert.equal(attention.waitingBehind, 1);
    tests.push(
      "another device wrote stock off meanwhile: the offline sale is refused whole with insufficient_stock, the balance is untouched, no second sale exists and the attention model offers resubmit or discard"
    );

    // the missing stock arrives, the sale is resubmitted as a NEW command
    await asTenant("inventory:adjust", (tx, identity) =>
      receiveStock(tx, identity, {
        commandId: randomUUID(),
        commandVersion: 1,
        occurredOn: dateDaysAgo(0),
        quantity: 20,
        unitCost: "25",
        variantId: shirtVariant,
      })
    );
    const [item] = attention.items;
    assert.ok(item);
    await resubmitAttentionItem(item, {
      lease: device.lease,
      outbox: device.outbox,
    });
    // the queue now holds the count (made against the old version) and the new sale
    const afterResubmit = await device.sync();
    assert.equal(afterResubmit.rejected, 1, "the stale count is refused");
    assert.equal(
      afterResubmit.blockedBy?.rejection?.code,
      "inventory_version_conflict"
    );
    assert.deepEqual(await stockOf(shirtVariant), { quantity: 22, version: 6 });
    const [staleItem] = buildAttention(await device.outbox.snapshot()).items;
    assert.equal(staleItem?.cause, "version_conflict");
    assert.deepEqual(staleItem?.actions, ["discard"]);
    await discardAttentionItem(staleItem as never, {
      outbox: device.outbox,
      writer: device.writer,
    });
    const finished = await device.sync();
    assert.equal(finished.accepted, 1, "the resubmitted sale goes through");
    assert.deepEqual(await stockOf(shirtVariant), { quantity: 14, version: 7 });
    assert.equal(
      await count(
        "SELECT count(*)::text AS n FROM public.sales WHERE organization_id = $1",
        tenant.organizationId
      ),
      2
    );
    assert.equal(
      staleCount.command.baseVersion,
      5,
      "the count carried the version it counted against"
    );
    tests.push(
      "after the stock is received the refused sale is resubmitted as a new command; the count made against a stale balance is refused with inventory_version_conflict and discarded; the sale then confirms exactly once and the balance is 14 at version 7"
    );

    // ======================================================================
    // 3. A taken SKU refuses the whole product, with its opening stock
    // ======================================================================
    const duplicate = await createOfflineProduct({
      ...device.base,
      input: {
        initialStock: {
          occurredOn: dateDaysAgo(1),
          quantity: 3,
          unitCost: "9",
        },
        name: "Outra camiseta",
        sku: "e2e-a",
      },
    });
    const behind = await createOfflineProduct({
      ...device.base,
      input: { name: "Boné E2E" },
    });
    const skuRun = await device.sync();
    assert.equal(skuRun.blockedBy?.rejection?.code, "sku_conflict");
    assert.equal(skuRun.notProcessed, 1);
    assert.equal(
      await count(
        "SELECT count(*)::text AS n FROM public.products WHERE id = $1 OR id = $2",
        duplicate.rows.product.id,
        behind.rows.product.id
      ),
      0,
      "neither the refused product nor the one behind it exists"
    );
    assert.equal(
      await count(
        "SELECT count(*)::text AS n FROM public.stock_movements WHERE variant_id = $1",
        duplicate.rows.variant.id
      ),
      0,
      "no opening stock for the refused product"
    );
    const [skuItem] = buildAttention(await device.outbox.snapshot()).items;
    assert.equal(skuItem?.cause, "sku_conflict");
    await discardAttentionItem(skuItem as never, {
      outbox: device.outbox,
      writer: device.writer,
    });
    assert.equal(device.writer.product(duplicate.rows.product.id), undefined);
    const afterSku = await device.sync();
    assert.equal(
      afterSku.accepted,
      1,
      "the product behind it goes through once the refused one is gone"
    );
    tests.push(
      "a SKU already taken (other letter case) refuses the offline product whole, opening stock included, and holds the queue; discarding it removes its local rows and the product behind it then syncs"
    );

    // ======================================================================
    // 4. A revoked access is refused and needs the account, not the sale
    // ======================================================================
    const d2 = await openDevice("Caixa 2");
    await createOfflineSale({
      ...d2.base,
      lines: [
        { chargedUnitPrice: "45.00", quantity: 1, variantId: shirtVariant },
      ],
      payment: { method: "pix" },
      reader: d2.writer,
    });
    const salesBefore = await count(
      "SELECT count(*)::text AS n FROM public.sales WHERE organization_id = $1",
      tenant.organizationId
    );
    await revokeDevice(db, tenant.userId, d2.deviceId);
    const revoked = await d2.sync();
    assert.equal(revoked.blockedBy?.rejection?.code, "authorization_revoked");
    assert.equal(
      await count(
        "SELECT count(*)::text AS n FROM public.sales WHERE organization_id = $1",
        tenant.organizationId
      ),
      salesBefore,
      "a revoked device confirms nothing"
    );
    assert.equal((await pendingSales(d2.outbox))[0]?.state, "needs_attention");
    const [revokedItem] = buildAttention(await d2.outbox.snapshot()).items;
    assert.equal(revokedItem?.cause, "authorization_revoked");
    assert.ok(!revokedItem?.actions.includes("resubmit"));
    tests.push(
      "a device whose access was revoked has its queued sale refused with authorization_revoked, confirms nothing, and shows needs_attention with no resubmit"
    );

    // ======================================================================
    // 5. Whatever happened, the books still balance
    // ======================================================================
    const negative = await count(
      "SELECT count(*)::text AS n FROM public.inventory_balances WHERE organization_id = $1 AND quantity < 0",
      tenant.organizationId
    );
    assert.equal(negative, 0);
    const finalReconciled = await admin.pool.query<{ ok: boolean }>(
      `SELECT bool_and(b.quantity = coalesce((SELECT sum(m.quantity_delta) FROM public.stock_movements m WHERE m.variant_id = b.variant_id), 0)) AS ok
         FROM public.inventory_balances b WHERE b.organization_id = $1`,
      [tenant.organizationId]
    );
    assert.equal(finalReconciled.rows[0]?.ok, true);
    tests.push(
      "after the whole story no balance is negative and the ledger still explains every balance"
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
  console.error(`Offline end-to-end gate failed (${redactedFailure(error)})`);
  process.exitCode = 1;
});
