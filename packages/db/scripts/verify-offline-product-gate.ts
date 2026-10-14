import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  InvalidProductIdError,
  ProductCategoryUnavailableError,
  ProductIdConflictError,
  ProductVariantSkuConflictError,
} from "@polaris/domain/catalog/product";
import { InventoryOccurredInFutureError } from "@polaris/domain/inventory/inventory";
import { createDatabase } from "../src/client";
import { registerDevice } from "../src/device-repository";
import { receiveStock } from "../src/inventory-repository";
import { issueOfflineLeaseGrant } from "../src/offline-lease-repository";
import { createProduct } from "../src/product-repository";
import {
  runSyncCommand,
  type SyncCommandOutcome,
} from "../src/sync-command-repository";
import { TenantAuthorizationError } from "../src/tenant-transaction";
import {
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
 * `product.create` offline (plan PR55): the device names the product and its
 * default variant, optionally sends the SKU, the list price and the opening
 * stock, and the server creates all of it in ONE command or none of it. The
 * domain work here is exactly what the web handler does, run through the real
 * `sync.push` frame (`runSyncCommand`) on the real schema.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const DAY = 86_400_000;
const hash = (n: number) => n.toString(16).padStart(64, "0");
const calendarDate = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

const classify = (error: unknown): string | null => {
  if (error instanceof ProductIdConflictError) {
    return "product_id_conflict";
  }
  if (error instanceof ProductVariantSkuConflictError) {
    return "sku_conflict";
  }
  if (error instanceof ProductCategoryUnavailableError) {
    return "category_unavailable";
  }
  if (error instanceof InventoryOccurredInFutureError) {
    return "inventory_date_in_future";
  }
  return null;
};

type Tenant = Awaited<ReturnType<typeof createTenantFixture>>;

interface ProductPayload {
  categoryId?: string | null;
  initialStock?: { occurredOn: string; quantity: number; unitCost: string };
  listPrice?: string | null;
  name?: string;
  productId?: string;
  sku?: string | null;
  variantId?: string;
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

    const tenantA = await createTenantFixture(admin.pool, "product A");
    const tenantB = await createTenantFixture(admin.pool, "product B");
    const loginSuffix = randomUUID().replaceAll("-", "");
    loginRole = `polaris_product_gate_${loginSuffix}`;
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
    assert.ok(claims.caps.includes("product:create"));
    assert.ok(claims.caps.includes("inventory:adjust"));
    const createdNow = () => new Date(Date.now() - 60_000);

    /** The domain work of the web handler, in the sync frame, as the router runs it. */
    const pushProduct = (
      id: string,
      payload: ProductPayload,
      tenant: Tenant = tenantA
    ): Promise<SyncCommandOutcome> =>
      withTenantAs(db, tenant, "sync:push", (transaction, identity) =>
        runSyncCommand(
          transaction,
          identity,
          {
            commandId: id,
            commandType: "product.create",
            createdAt: createdNow(),
            deviceId: device.id,
            leaseClaims: claims,
            payloadHash: hash(1),
          },
          async (savepoint) => {
            const newProductId = payload.productId ?? randomUUID();
            const newVariantId = payload.variantId ?? randomUUID();
            const product = await createProduct(savepoint, identity, {
              categoryId: payload.categoryId ?? null,
              defaultVariantId: newVariantId,
              id: newProductId,
              listPrice: payload.listPrice ?? null,
              name: payload.name ?? `Produto ${newProductId}`,
              requestId: id,
              sku: payload.sku ?? null,
            });
            if (payload.initialStock) {
              await receiveStock(
                savepoint,
                { ...identity, capability: "inventory:adjust" },
                {
                  commandId: id,
                  commandVersion: 1,
                  occurredOn: payload.initialStock.occurredOn,
                  quantity: payload.initialStock.quantity,
                  requestId: id,
                  unitCost: payload.initialStock.unitCost,
                  variantId: newVariantId,
                }
              );
            }
            return { productId: product.id, variantId: newVariantId };
          },
          classify
        )
      );

    const count = async (sql: string, ...params: unknown[]) =>
      Number(
        (await admin.pool.query<{ n: string }>(sql, params)).rows[0]?.n ?? "-1"
      );
    const footprint = async (pid: string, vid: string) => ({
      audit: await count(
        "SELECT count(*)::text AS n FROM public.tenant_audit_event WHERE entity_id = $1",
        pid
      ),
      balance: await count(
        "SELECT count(*)::text AS n FROM public.inventory_balances WHERE variant_id = $1",
        vid
      ),
      movements: await count(
        "SELECT count(*)::text AS n FROM public.stock_movements WHERE variant_id = $1",
        vid
      ),
      product: await count(
        "SELECT count(*)::text AS n FROM public.products WHERE id = $1",
        pid
      ),
      variant: await count(
        "SELECT count(*)::text AS n FROM public.product_variants WHERE id = $1",
        vid
      ),
    });
    const nothing = {
      audit: 0,
      balance: 0,
      movements: 0,
      product: 0,
      variant: 0,
    };

    // -------------------- 1. the device's IDs, SKU, price and stock are kept
    const productId = randomUUID();
    const variantId = randomUUID();
    const commandId = randomUUID();
    const created = await pushProduct(commandId, {
      initialStock: {
        occurredOn: calendarDate(-2),
        quantity: 12,
        unitCost: "8.5",
      },
      listPrice: "49.90",
      name: "Camiseta offline",
      productId,
      sku: "CAM-OFF-01",
      variantId,
    });
    assert.equal(created.status, "accepted");
    assert.deepEqual(created.result, { productId, variantId });
    const stored = await admin.pool.query<{
      is_default: boolean;
      list_price: string;
      moving_average_cost: string;
      organization_id: string;
      quantity: number;
      sku: string;
    }>(
      `SELECT v.is_default, v.list_price::text AS list_price, v.sku, v.organization_id,
              b.quantity, b.moving_average_cost::text AS moving_average_cost
         FROM public.product_variants v
         JOIN public.inventory_balances b ON b.variant_id = v.id
        WHERE v.id = $1 AND v.product_id = $2`,
      [variantId, productId]
    );
    assert.deepEqual(stored.rows, [
      {
        is_default: true,
        list_price: "49.90",
        moving_average_cost: "8.500000",
        organization_id: tenantA.organizationId,
        quantity: 12,
        sku: "CAM-OFF-01",
      },
    ]);
    const receipt = await admin.pool.query<{
      movement_type: string;
      quantity_delta: number;
    }>(
      "SELECT movement_type, quantity_delta FROM public.stock_movements WHERE variant_id = $1",
      [variantId]
    );
    assert.deepEqual(receipt.rows, [
      { movement_type: "receipt", quantity_delta: 12 },
    ]);
    tests.push(
      "the product and default variant keep the device's IDs, SKU and list price, and the opening stock lands as one receipt with its cost"
    );

    // -------------------------- 2. the change log tells the other devices
    const changes = await admin.pool.query<{
      entity_id: string;
      entity_type: string;
    }>(
      "SELECT entity_type, entity_id::text FROM public.sync_changes WHERE organization_id = $1 AND entity_id = ANY($2::uuid[]) ORDER BY seq",
      [tenantA.organizationId, [productId, variantId]]
    );
    const kinds = new Set(
      changes.rows.map((row) => `${row.entity_type}:${row.entity_id}`)
    );
    assert.ok(kinds.has(`product:${productId}`));
    assert.ok(kinds.has(`inventory_balance:${variantId}`));
    tests.push(
      "the change log records the product and the stock balance so every device pulls them"
    );

    // ------------------------------------ 3. sending it twice creates it once
    const replay = await pushProduct(commandId, {
      initialStock: {
        occurredOn: calendarDate(-2),
        quantity: 12,
        unitCost: "8.5",
      },
      listPrice: "49.90",
      name: "Camiseta offline",
      productId,
      sku: "CAM-OFF-01",
      variantId,
    });
    assert.deepEqual(replay, { ...created, replayed: true });
    assert.deepEqual(await footprint(productId, variantId), {
      audit: 1,
      balance: 1,
      movements: 1,
      product: 1,
      variant: 1,
    });
    tests.push(
      "the same command sent again replays the stored outcome: one product, one variant, one balance, one receipt, one audit event"
    );

    // ---------- 4. a taken SKU refuses the whole command, whatever the letter case
    const skuProduct = randomUUID();
    const skuVariant = randomUUID();
    const skuRefused = await pushProduct(randomUUID(), {
      initialStock: {
        occurredOn: calendarDate(-2),
        quantity: 5,
        unitCost: "1",
      },
      productId: skuProduct,
      sku: "cam-off-01",
      variantId: skuVariant,
    });
    assert.deepEqual(
      { code: skuRefused.code, status: skuRefused.status },
      { code: "sku_conflict", status: "rejected" }
    );
    assert.deepEqual(await footprint(skuProduct, skuVariant), nothing);
    // the SKU is unique per organization, not global
    await withTenantAs(db, tenantB, "product:create", async (tx, identity) => {
      const sameSkuElsewhere = await createProduct(tx, identity, {
        name: "Mesmo SKU em outra organização",
        sku: "CAM-OFF-01",
      });
      assert.ok(sameSkuElsewhere.id);
    });
    tests.push(
      "a SKU already used in the organization (any letter case) refuses the whole command and leaves no product, variant, stock, receipt or audit event"
    );

    // ------- 5. a taken product or variant ID is a conflict, here and across tenants
    const sameProductId = await pushProduct(randomUUID(), { productId });
    assert.equal(sameProductId.code, "product_id_conflict");
    const sameVariantId = await pushProduct(randomUUID(), { variantId });
    assert.equal(sameVariantId.code, "product_id_conflict");
    await withTenantAs(db, tenantB, "product:create", async (tx, identity) => {
      await assert.rejects(
        createProduct(tx, identity, {
          id: productId,
          name: "Outro tenant mesmo id",
        }),
        ProductIdConflictError
      );
      // the failed insert did not abort the caller's transaction
      const ok = await createProduct(tx, identity, { name: "Segue valendo" });
      assert.ok(ok.id);
    });
    await withTenantAs(db, tenantA, "product:create", (tx, identity) =>
      assert.rejects(
        createProduct(tx, identity, { id: "not-a-uuid", name: "Id inválido" }),
        InvalidProductIdError
      )
    );
    tests.push(
      "a taken product or variant ID (same or another organization) is a clean product_id_conflict that does not abort the transaction, and a non-UUID ID never reaches the database"
    );

    // ------------ 6. atomic: when the stock fails the product is not left behind
    const lateProduct = randomUUID();
    const lateVariant = randomUUID();
    const late = await pushProduct(randomUUID(), {
      initialStock: {
        occurredOn: calendarDate(3),
        quantity: 4,
        unitCost: "2",
      },
      productId: lateProduct,
      variantId: lateVariant,
    });
    assert.equal(late.code, "inventory_date_in_future");
    assert.deepEqual(await footprint(lateProduct, lateVariant), nothing);
    const noCategory = randomUUID();
    const noCategoryVariant = randomUUID();
    const missingCategory = await pushProduct(randomUUID(), {
      categoryId: randomUUID(),
      productId: noCategory,
      variantId: noCategoryVariant,
    });
    assert.equal(missingCategory.code, "category_unavailable");
    assert.deepEqual(await footprint(noCategory, noCategoryVariant), nothing);
    tests.push(
      "the command is atomic: opening stock refused after the product was inserted (future date) or an unavailable category leaves no product, variant, balance or audit event, and the rejection replays"
    );

    // --------- 7. opening stock needs inventory:adjust, which the handler asks for
    await withTenantAs(db, tenantA, "sync:push", (tx, identity) =>
      assert.rejects(
        receiveStock(tx, identity, {
          commandId: randomUUID(),
          commandVersion: 1,
          occurredOn: calendarDate(-1),
          quantity: 1,
          unitCost: "1",
          variantId,
        }),
        TenantAuthorizationError
      )
    );
    tests.push(
      "stock cannot be received under the sync:push capability alone: the handler declares inventory:adjust and the lease must carry it"
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
    `Offline product PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
