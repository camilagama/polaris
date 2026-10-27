import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { InventoryOccurredInFutureError } from "@polaris/domain/inventory/inventory";
import { SaleCancellationCommandConflictError } from "@polaris/domain/sales/sale-cancellation";
import { SaleReturnCommandConflictError } from "@polaris/domain/sales/sale-return";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { createDatabase } from "../src/client";
import {
  inventoryCount,
  receiveStock,
  writeOffStock,
} from "../src/inventory-repository";
import { createPaymentProfile } from "../src/payment-profile-repository";
import { deleteProduct } from "../src/product-repository";
import { cancelSale } from "../src/sale-cancellation-repository";
import { createSaleReturn } from "../src/sale-return-repository";
import {
  TENANT_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  TENANT_LOCK_TIMEOUT_MS,
  TENANT_STATEMENT_TIMEOUT_MS,
  withAuthorizedTenantTransaction,
} from "../src/tenant-transaction";
import { runClock, storeDay } from "./gate-clock";
import {
  confirmPlainSale,
  createSellableProduct,
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
 * Proves the hardening of the Gate 4 review round: instants as timestamptz
 * independent of the session time zone, the ledger/balance reconciliation and
 * ordering, compensation of sales whose product was removed, the restock
 * average rule, column-level grants, size and rate limits, the identity-table
 * role split, function hardening, per-transaction timeouts and the dated-input
 * rules of stock commands.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

type RuntimeDatabase = ReturnType<typeof createDatabase>;

async function run() {
  const branch = requiredEnvironment("POLARIS_SALES_GATE_BRANCH");
  assert.match(branch, gateBranchPattern);
  const adminUrl = requiredEnvironment("POLARIS_SALES_GATE_DATABASE_URL");
  const parsedAdminUrl = new URL(adminUrl);
  assert.match(parsedAdminUrl.hostname, disposableHostPattern);
  assert.doesNotMatch(parsedAdminUrl.hostname, poolerPattern);

  const admin = createDatabase(adminUrl, { maxConnections: 2 });
  let runtime: RuntimeDatabase | undefined;
  let concurrent: RuntimeDatabase | undefined;
  let loginRole: string | undefined;
  let loginRoleCreated = false;
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
    tests.push("disposable direct Neon connection is PostgreSQL 18");

    const migrations = await admin.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations"
    );
    assert.equal(Number(migrations.rows[0]?.count), journalMigrationCount());
    tests.push(
      "migrations 0000-0041 (and any later ones) were replayed from scratch"
    );

    const tenantA = await createTenantFixture(
      admin.pool,
      "hardening A",
      "America/Sao_Paulo"
    );
    const tenantB = await createTenantFixture(admin.pool, "hardening B");
    const loginSuffix = randomUUID().replaceAll("-", "");
    loginRole = `polaris_hardening_gate_${loginSuffix}`;
    const loginPassword = randomBytes(24).toString("hex");
    await admin.pool.query(
      `CREATE ROLE "${loginRole}" WITH LOGIN INHERIT PASSWORD '${loginPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
    );
    loginRoleCreated = true;
    await admin.pool.query(`GRANT "${runtimeRole}" TO "${loginRole}"`);
    // A session time zone that is nowhere near UTC: nothing may depend on it.
    await admin.pool.query(
      `ALTER ROLE "${loginRole}" SET timezone = 'Pacific/Kiritimati'`
    );
    const runtimeUrl = temporaryRuntimeUrl(adminUrl, loginRole, loginPassword);
    const runtimeDatabase = createDatabase(runtimeUrl, { maxConnections: 1 });
    runtime = runtimeDatabase;
    const concurrentDatabase = createDatabase(runtimeUrl, {
      maxConnections: 8,
    });
    concurrent = concurrentDatabase;
    const rt = { adminPool: admin.pool, db: runtimeDatabase.db };
    const today = storeDay(runClock);

    const balance = async (tenant: TenantFixture, variantId: string) => {
      const result = await admin.pool.query<{
        average: string | null;
        quantity: number;
      }>(
        "SELECT quantity, moving_average_cost::text AS average FROM public.inventory_balances WHERE organization_id = $1 AND variant_id = $2",
        [tenant.organizationId, variantId]
      );
      return result.rows[0] ?? { average: null, quantity: 0 };
    };
    const receive = (
      tenant: TenantFixture,
      variantId: string,
      quantity: number,
      options: { occurredOn?: string; unitCost?: string } = {},
      database: RuntimeDatabase = runtimeDatabase
    ) =>
      withTenantAs(
        database.db,
        tenant,
        "inventory:adjust",
        (transaction, identity) =>
          receiveStock(transaction, identity, {
            commandId: randomUUID(),
            commandVersion: 1,
            occurredOn: options.occurredOn ?? today,
            quantity,
            unitCost: options.unitCost ?? "5.00",
            variantId,
          })
      );

    // ----------------- 1. instants are timestamptz, whatever the session zone
    const naive = await admin.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM information_schema.columns WHERE table_schema = 'public' AND data_type = 'timestamp without time zone'"
    );
    assert.equal(naive.rows[0]?.count, "0");
    const zoneProbe = await withRuntimeSqlContext(
      runtimeUrl,
      tenantA,
      async (client) =>
        (
          await client.query<{ timezone: string }>(
            "SELECT current_setting('TimeZone') AS timezone"
          )
        ).rows[0]?.timezone
    );
    assert.equal(zoneProbe, "Pacific/Kiritimati", "the setting is in effect");
    const tokyoProduct = await createSellableProduct(rt, tenantA, "fuso", {
      cost: "10.00",
      quantity: 20,
    });
    const instantBefore = Date.now();
    const zoneSale = await confirmPlainSale(rt, tenantA, [
      { quantity: 1, variantId: tokyoProduct.variantId },
    ]);
    const instantAfter = Date.now();
    assert.ok(
      zoneSale.sale.confirmedAt.getTime() >= instantBefore - 120_000 &&
        zoneSale.sale.confirmedAt.getTime() <= instantAfter + 120_000,
      "confirmed_at is the real instant even under a +14h session zone"
    );
    const stored = await admin.pool.query<{ drift_seconds: string }>(
      "SELECT abs(extract(epoch FROM (confirmed_at - now())))::text AS drift_seconds FROM public.sales WHERE organization_id = $1 AND id = $2",
      [tenantA.organizationId, zoneSale.sale.id]
    );
    assert.ok(Number(stored.rows[0]?.drift_seconds) < 300);
    tests.push(
      "every instant column is timestamptz, and DEFAULT now()/clock_timestamp() values are the true instant even for a runtime role whose session time zone is Pacific/Kiritimati"
    );

    // ------------------------------ 2. per-transaction timeouts and isolation
    const guarded = await withAuthorizedTenantTransaction(
      runtimeDatabase.db,
      {
        authenticatedUserId: tenantA.userId,
        capability: "sale:read",
        isolationLevel: "repeatable read",
        requestedOrganizationId: tenantA.organizationId,
      },
      async (transaction) => {
        const { rows } = await transaction.execute<{
          idle: string;
          isolation: string;
          lock: string;
          statement: string;
        }>(
          sql`SELECT current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS lock, current_setting('idle_in_transaction_session_timeout') AS idle, current_setting('transaction_isolation') AS isolation`
        );
        return rows[0];
      }
    );
    assert.ok(guarded);
    assert.equal(guarded.isolation, "repeatable read");
    assert.equal(guarded.statement, `${TENANT_STATEMENT_TIMEOUT_MS / 1000}s`);
    assert.equal(guarded.lock, `${TENANT_LOCK_TIMEOUT_MS / 1000}s`);
    assert.equal(
      guarded.idle,
      `${TENANT_IDLE_IN_TRANSACTION_TIMEOUT_MS / 60_000}min`
    );
    // a lock held elsewhere makes a tenant write fail fast instead of hanging
    const holder = new Client({ connectionString: adminUrl });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        "SELECT id FROM public.products WHERE organization_id = $1 AND id = $2 FOR UPDATE",
        [tenantA.organizationId, tokyoProduct.productId]
      );
      const waitStarted = Date.now();
      await expectSqlState(
        () => receive(tenantA, tokyoProduct.variantId, 1),
        "55P03",
        "a tenant write behind a held product lock gives up at lock_timeout"
      );
      const waited = Date.now() - waitStarted;
      assert.ok(
        waited >= TENANT_LOCK_TIMEOUT_MS - 2000 &&
          waited < TENANT_LOCK_TIMEOUT_MS + 10_000,
        `waited ${waited}ms`
      );
    } finally {
      await holder.query("ROLLBACK");
      await holder.end();
    }
    tests.push(
      "tenant transactions carry statement/lock/idle-in-transaction timeouts, can ask for REPEATABLE READ, and a write blocked behind a held product lock fails at lock_timeout (55P03) instead of hanging"
    );

    // -------------------- 3. ledger order and balance = sum of movements
    const ledgerProduct = await createSellableProduct(rt, tenantA, "razao", {
      cost: "4.00",
      quantity: 10,
    });
    await Promise.all(
      Array.from({ length: 6 }, () =>
        receive(
          tenantA,
          ledgerProduct.variantId,
          1,
          { unitCost: "4.00" },
          concurrentDatabase
        )
      )
    );
    const sequence = await admin.pool.query<{ variant_sequence: string }>(
      "SELECT variant_sequence::text FROM public.stock_movements WHERE organization_id = $1 AND variant_id = $2 ORDER BY variant_sequence",
      [tenantA.organizationId, ledgerProduct.variantId]
    );
    assert.deepEqual(
      sequence.rows.map((row) => Number(row.variant_sequence)),
      [1, 2, 3, 4, 5, 6, 7],
      "movements are numbered 1..n without gaps or repeats, even under concurrency"
    );
    assert.equal(
      (await balance(tenantA, ledgerProduct.variantId)).quantity,
      16
    );
    // direct balance writes without a movement are refused at commit
    await expectSqlState(
      () =>
        withRuntimeSqlContext(runtimeUrl, tenantA, (client) =>
          client.query(
            "UPDATE public.inventory_balances SET quantity = quantity + 1 WHERE organization_id = $1 AND variant_id = $2",
            [tenantA.organizationId, ledgerProduct.variantId]
          )
        ),
      "23514",
      "a balance changed without its movement is rejected at commit",
      "inventory_balance_matches_ledger"
    );
    const rawMovement = (
      client: Client,
      quantity: number,
      options: { updateBalance: boolean }
    ) =>
      (async () => {
        await client.query(
          "INSERT INTO public.stock_movements (organization_id, command_id, command_index, command_version, occurred_on, movement_type, product_id, variant_id, quantity_delta, unit_cost) VALUES ($1, $2, 0, 1, $3, 'receipt', $4, $5, $6, '4.00')",
          [
            tenantA.organizationId,
            randomUUID(),
            today,
            ledgerProduct.productId,
            ledgerProduct.variantId,
            quantity,
          ]
        );
        if (options.updateBalance) {
          await client.query(
            "UPDATE public.inventory_balances SET quantity = quantity + $3 WHERE organization_id = $1 AND variant_id = $2",
            [tenantA.organizationId, ledgerProduct.variantId, quantity]
          );
        }
      })();
    await expectSqlState(
      () =>
        withRuntimeSqlContext(runtimeUrl, tenantA, (client) =>
          rawMovement(client, 3, { updateBalance: false })
        ),
      "23514",
      "a movement without the matching balance is rejected at commit",
      "inventory_balance_matches_ledger"
    );
    await withRuntimeSqlContext(runtimeUrl, tenantA, (client) =>
      rawMovement(client, 2, { updateBalance: true })
    );
    assert.equal(
      (await balance(tenantA, ledgerProduct.variantId)).quantity,
      18
    );
    tests.push(
      "movements get a gapless per-variant sequence under concurrent writers, and PostgreSQL refuses (at commit) a balance changed without its movement or a movement without its balance while a coherent pair commits"
    );

    // ------------------------------------- 4. restock average rule (D-2)
    const unknownCost = await createSellableProduct(rt, tenantA, "sem custo", {
      cost: null,
      quantity: 5,
    });
    const firstSale = await confirmPlainSale(rt, tenantA, [
      { quantity: 5, variantId: unknownCost.variantId },
    ]);
    await receive(tenantA, unknownCost.variantId, 3, { unitCost: "10.00" });
    await confirmPlainSale(rt, tenantA, [
      { quantity: 3, variantId: unknownCost.variantId },
    ]);
    const staleBefore = await balance(tenantA, unknownCost.variantId);
    assert.equal(staleBefore.quantity, 0);
    assert.ok(
      staleBefore.average !== null,
      "an empty balance keeps the last known average"
    );
    await withTenantAs(
      runtimeDatabase.db,
      tenantA,
      "sale:cancel",
      (transaction, identity) =>
        cancelSale(transaction, identity, {
          commandId: randomUUID(),
          commandVersion: 1,
          saleId: firstSale.sale.id,
        })
    );
    const afterRestock = await balance(tenantA, unknownCost.variantId);
    assert.equal(afterRestock.quantity, 5);
    assert.equal(
      afterRestock.average,
      null,
      "units restocked at an unknown cost into an empty balance are not valued with a stale average"
    );
    tests.push(
      "restocking units whose sale cost was unknown into an empty balance leaves the average unknown instead of reviving a stale one"
    );

    // ------ 5. compensating a sale whose product was removed afterwards (D-1)
    const liveProduct = await createSellableProduct(rt, tenantA, "vivo", {
      cost: "6.00",
      quantity: 10,
    });
    const goneProduct = await createSellableProduct(rt, tenantA, "removido", {
      cost: "2.00",
      quantity: 2,
    });
    const mixed = await confirmPlainSale(rt, tenantA, [
      { quantity: 2, variantId: liveProduct.variantId },
      { quantity: 2, variantId: goneProduct.variantId },
    ]);
    await withTenantAs(
      runtimeDatabase.db,
      tenantA,
      "product:update",
      (transaction, identity) =>
        deleteProduct(transaction, identity, {
          expectedVersion: goneProduct.version,
          id: goneProduct.productId,
        })
    );
    const mixedCancel = randomUUID();
    const cancelled = await withTenantAs(
      runtimeDatabase.db,
      tenantA,
      "sale:cancel",
      (transaction, identity) =>
        cancelSale(transaction, identity, {
          commandId: mixedCancel,
          commandVersion: 1,
          saleId: mixed.sale.id,
        })
    );
    assert.deepEqual(
      cancelled.restocked.map((line) => line.position),
      [0],
      "only the live product's item takes units back"
    );
    assert.equal((await balance(tenantA, liveProduct.variantId)).quantity, 10);
    assert.equal((await balance(tenantA, goneProduct.variantId)).quantity, 0);
    const mixedMovements = await admin.pool.query<{ command_index: number }>(
      "SELECT command_index FROM public.stock_movements WHERE organization_id = $1 AND command_id = $2 ORDER BY command_index",
      [tenantA.organizationId, mixedCancel]
    );
    assert.deepEqual(
      mixedMovements.rows.map((row) => row.command_index),
      [0]
    );
    const replayed = await withTenantAs(
      runtimeDatabase.db,
      tenantA,
      "sale:cancel",
      (transaction, identity) =>
        cancelSale(transaction, identity, {
          commandId: mixedCancel,
          commandVersion: 1,
          saleId: mixed.sale.id,
        })
    );
    assert.equal(replayed.replayed, true);
    assert.deepEqual(
      replayed.restocked.map((line) => line.position),
      [0]
    );
    // the database still demands a movement for every live item
    const liveOnly = await confirmPlainSale(rt, tenantA, [
      { quantity: 1, variantId: liveProduct.variantId },
    ]);
    await expectSqlState(
      () =>
        withRuntimeSqlContext(runtimeUrl, tenantA, (client) =>
          client.query(
            "INSERT INTO public.sale_cancellations (organization_id, sale_id, command_id, cancelled_by) VALUES ($1, $2, $3, $4)",
            [
              tenantA.organizationId,
              liveOnly.sale.id,
              randomUUID(),
              tenantA.userId,
            ]
          )
        ),
      "23514",
      "a cancellation without the movement of a live item is rejected at commit",
      "sale_cancellations_stock_complete"
    );
    tests.push(
      "a sale with a removed product's item is cancelled without a movement for that item (and restocks the live ones), replays the same way, and PostgreSQL still requires a movement for every live item"
    );

    // ------------- 6. command IDs cannot cross operations (return/cancel)
    const receiptCommand = randomUUID();
    await withTenantAs(
      runtimeDatabase.db,
      tenantA,
      "inventory:adjust",
      (transaction, identity) =>
        receiveStock(transaction, identity, {
          commandId: receiptCommand,
          commandVersion: 1,
          occurredOn: today,
          quantity: 1,
          unitCost: "6.00",
          variantId: liveProduct.variantId,
        })
    );
    const crossSale = await confirmPlainSale(rt, tenantA, [
      { quantity: 2, variantId: liveProduct.variantId },
    ]);
    await assert.rejects(
      () =>
        withTenantAs(
          runtimeDatabase.db,
          tenantA,
          "sale:return",
          (transaction, identity) =>
            createSaleReturn(transaction, identity, {
              commandId: receiptCommand,
              commandVersion: 1,
              items: [
                { position: 0, restockedQuantity: 0, returnedQuantity: 1 },
              ],
              saleId: crossSale.sale.id,
            })
        ),
      SaleReturnCommandConflictError
    );
    await assert.rejects(
      () =>
        withTenantAs(
          runtimeDatabase.db,
          tenantA,
          "sale:cancel",
          (transaction, identity) =>
            cancelSale(transaction, identity, {
              commandId: receiptCommand,
              commandVersion: 1,
              saleId: crossSale.sale.id,
            })
        ),
      SaleCancellationCommandConflictError
    );
    tests.push(
      "a return or cancellation that reuses the command ID of a stock movement is a domain conflict (not a late database error), even when it restocks nothing"
    );

    // ------------------ 7. operator-dated stock commands are never future
    const tomorrow = storeDay(runClock, 1);
    await assert.rejects(
      () =>
        receive(tenantA, liveProduct.variantId, 1, { occurredOn: tomorrow }),
      InventoryOccurredInFutureError
    );
    await assert.rejects(
      () =>
        withTenantAs(
          runtimeDatabase.db,
          tenantA,
          "inventory:adjust",
          (transaction, identity) =>
            writeOffStock(transaction, identity, {
              commandId: randomUUID(),
              commandVersion: 1,
              occurredOn: tomorrow,
              quantity: 1,
              reasonCode: "damaged",
              variantId: liveProduct.variantId,
            })
        ),
      InventoryOccurredInFutureError
    );
    await assert.rejects(
      () =>
        withTenantAs(
          runtimeDatabase.db,
          tenantA,
          "inventory:adjust",
          (transaction, identity) =>
            inventoryCount(transaction, identity, {
              commandId: randomUUID(),
              commandVersion: 1,
              expectedVersion: 0,
              occurredOn: tomorrow,
              physicalQuantity: 1,
              variantId: liveProduct.variantId,
            })
        ),
      InventoryOccurredInFutureError
    );
    await receive(tenantA, liveProduct.variantId, 1, { occurredOn: today });
    tests.push(
      "receipts, write-offs and counts dated after the organization's today are refused while today is accepted"
    );

    // ------------------------------------------ 8. column-level grants
    for (const [label, statement] of [
      ["products.created_at", "UPDATE public.products SET created_at = now()"],
      ["products.id", "UPDATE public.products SET id = gen_random_uuid()"],
      [
        "customers.created_at",
        "UPDATE public.customers SET created_at = now()",
      ],
      [
        "payment_profiles.version",
        "UPDATE public.payment_profiles SET created_at = now()",
      ],
      [
        "categories.created_at",
        "UPDATE public.categories SET created_at = now()",
      ],
      [
        "payment_profile_rules.method",
        "UPDATE public.payment_profile_rules SET method = 'cash'",
      ],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: each probe is verified before the next one starts
      await expectSqlState(
        () =>
          withRuntimeSqlContext(runtimeUrl, tenantA, (client) =>
            client.query(statement)
          ),
        "42501",
        `the tenant runtime cannot update ${label}`
      );
    }
    tests.push(
      "the tenant runtime can update only the columns the repositories set; id, created_at and rule definitions are no longer writable"
    );

    // ---------------------------------------------- 9. size and rate limits
    for (const [label, statement, constraint] of [
      [
        "customer name above 200 characters",
        "INSERT INTO public.customers (organization_id, name, phone) VALUES ($1, repeat('n', 201), '1')",
        "customers_text_limits",
      ],
      [
        "customer notes above 2000 characters",
        "INSERT INTO public.customers (organization_id, name, phone, notes) VALUES ($1, 'x', '1', repeat('n', 2001))",
        "customers_text_limits",
      ],
      [
        "product name above 200 characters",
        "INSERT INTO public.products (organization_id, name) VALUES ($1, repeat('p', 201))",
        "products_text_limits",
      ],
      [
        "organization name above 128 characters",
        "INSERT INTO public.organizations (id, name, timezone) VALUES (gen_random_uuid()::text, repeat('o', 129), 'America/Sao_Paulo') -- $1",
        "organizations_name_limit",
      ],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: each probe is verified before the next one starts
      await expectSqlState(
        () =>
          admin.pool.query(
            statement,
            statement.includes("$1") && !statement.includes("-- $1")
              ? [tenantA.organizationId]
              : []
          ),
        "23514",
        `${label} is refused by the database`,
        constraint
      );
    }
    const profile = await withTenantAs(
      runtimeDatabase.db,
      tenantA,
      "organization:manage",
      (transaction, identity) =>
        createPaymentProfile(transaction, identity, {
          name: "Limites",
          requestId: randomUUID(),
          rules: [
            {
              anticipationFee: { mode: "unknown" },
              method: "pix",
              processingFee: { mode: "percentage", percentage: "5" },
            },
          ],
        })
    );
    await expectSqlState(
      () =>
        admin.pool.query(
          "UPDATE public.payment_profile_rules SET processing_fee_percentage = 150 WHERE organization_id = $1 AND payment_profile_id = $2",
          [tenantA.organizationId, profile.id]
        ),
      "23514",
      "a fee percentage above 100 is refused by the database",
      "payment_profile_rules_rate_and_days_limits"
    );
    await expectSqlState(
      () =>
        admin.pool.query(
          "UPDATE public.payment_profile_rules SET expected_settlement_days = 4000 WHERE organization_id = $1 AND payment_profile_id = $2",
          [tenantA.organizationId, profile.id]
        ),
      "23514",
      "a settlement estimate above 3650 days is refused by the database",
      "payment_profile_rules_rate_and_days_limits"
    );
    tests.push(
      "PostgreSQL enforces the text limits (customers, products, organizations) and the 100-point rate / 3650-day settlement limits"
    );

    // ---------------------------- 10. media storage key matches its asset
    const goodKey = (orgId: string, commandId: string, hash: string) =>
      `media/v2/${orgId}/${randomUUID()}/${commandId}/${hash}/${randomUUID()}.webp`;
    const fingerprint = "a".repeat(64);
    const insertAsset = (key: string, orgId: string, commandId: string) =>
      admin.pool.query(
        "INSERT INTO public.media_assets (organization_id, storage_key, upload_command_id, input_fingerprint, content_type, byte_size, width, height) VALUES ($1, $2, $3, $4, 'image/webp', 100, 10, 10)",
        [orgId, key, commandId, fingerprint]
      );
    const assetCommand = randomUUID();
    // The deferred product-link trigger fires at commit, so the well-formed
    // key is probed inside a transaction that is rolled back: the CHECK
    // constraint (immediate) accepts it.
    const probe = await admin.pool.connect();
    try {
      await probe.query("BEGIN");
      await probe.query(
        "INSERT INTO public.media_assets (organization_id, storage_key, upload_command_id, input_fingerprint, content_type, byte_size, width, height) VALUES ($1, $2, $3, $4, 'image/webp', 100, 10, 10)",
        [
          tenantA.organizationId,
          goodKey(tenantA.organizationId, assetCommand, fingerprint),
          assetCommand,
          fingerprint,
        ]
      );
    } finally {
      await probe.query("ROLLBACK");
      probe.release();
    }
    for (const [label, key, owner] of [
      [
        "another organization's segment",
        goodKey(tenantB.organizationId, randomUUID(), fingerprint),
        tenantA.organizationId,
      ],
      [
        "a staging prefix",
        `media/staging/v1/2026/10/13/10/${randomUUID()}.json`,
        tenantA.organizationId,
      ],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: each probe is verified before the next one starts
      await expectSqlState(
        () => insertAsset(key, owner, randomUUID()),
        "23514",
        `a storage key with ${label} is refused`,
        "media_assets_storage_key_matches_asset"
      );
    }
    tests.push(
      "a media asset's storage key must be the v2 key built from its own organization, command and fingerprint, so an asset cannot point at another tenant's object"
    );

    // ----------------------------- 11. identity tables belong to the auth role
    for (const statement of [
      'SELECT id FROM public."user" LIMIT 1',
      "SELECT id FROM public.session LIMIT 1",
      "SELECT id FROM public.account LIMIT 1",
      "SELECT id FROM public.verification LIMIT 1",
      "INSERT INTO public.auth_security_audit_event (event_type, outcome, request_id) VALUES ('logout_succeeded', 'succeeded', 'gate')",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each probe is verified before the next one starts
      await expectSqlState(
        () =>
          withRuntimeSqlContext(runtimeUrl, tenantA, (client) =>
            client.query(statement)
          ),
        "42501",
        `the tenant runtime cannot run: ${statement}`
      );
    }
    const authGrants = await admin.pool.query<{
      auth_user: boolean;
      auth_session: boolean;
      auth_nologin: boolean;
      auth_nobypass: boolean;
    }>(
      "SELECT has_table_privilege('polaris_auth_runtime', 'public.\"user\"', 'SELECT,UPDATE') AS auth_user, has_table_privilege('polaris_auth_runtime', 'public.session', 'DELETE') AS auth_session, NOT rolcanlogin AS auth_nologin, NOT rolbypassrls AS auth_nobypass FROM pg_roles WHERE rolname = 'polaris_auth_runtime'"
    );
    assert.deepEqual(authGrants.rows, [
      {
        auth_nobypass: true,
        auth_nologin: true,
        auth_session: true,
        auth_user: true,
      },
    ]);
    tests.push(
      "the tenant runtime has no access to user, session, account, verification or the auth audit table; they belong to the separate NOLOGIN, NOBYPASSRLS polaris_auth_runtime"
    );

    // --------------------------------------------- 12. function hardening
    const functions = await admin.pool.query<{
      public_execute: number;
      unpinned: number;
    }>(
      `SELECT
         count(*) FILTER (WHERE has_function_privilege('public', p.oid, 'EXECUTE'))::int AS public_execute,
         count(*) FILTER (WHERE NOT p.prosecdef AND (p.proconfig IS NULL OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) AS s WHERE s LIKE 'search_path=%')))::int AS unpinned
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prokind = 'f'`
    );
    assert.deepEqual(functions.rows, [{ public_execute: 0, unpinned: 0 }]);
    const collation = await admin.pool.query<{ lowered: string }>(
      "SELECT lower('É') AS lowered"
    );
    assert.equal(
      collation.rows[0]?.lowered,
      "é",
      "case-insensitive uniqueness (lower()) works on non-ASCII letters"
    );
    tests.push(
      "no function in public is executable by PUBLIC, every non-definer function pins its search_path, and lower() folds non-ASCII letters (the case-insensitive unique indexes rely on it)"
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
    if (concurrent) {
      await concurrent.pool.end();
    }
    if (loginRole && loginRoleCreated) {
      await admin.pool.query(`REVOKE "${runtimeRole}" FROM "${loginRole}"`);
      await admin.pool.query(`DROP ROLE "${loginRole}"`);
    }
    await admin.pool.end();
  }
}

run().catch((error: unknown) => {
  console.error(
    `Review hardening PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
