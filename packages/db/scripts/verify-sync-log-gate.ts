import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createCategory } from "../src/category-repository";
import { createDatabase } from "../src/client";
import { createCustomer } from "../src/customer-repository";
import { updateProduct } from "../src/product-repository";
import { cancelSale } from "../src/sale-cancellation-repository";
import { changeSaleCustomerLink } from "../src/sale-customer-link-repository";
import { createSaleReturn } from "../src/sale-return-repository";
import {
  getSyncCursor,
  InvalidSyncCursorError,
  parseSyncCursor,
  pullSyncChanges,
  type SyncChange,
} from "../src/sync-repository";
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
  temporaryRuntimeUrl,
  withRuntimeSqlContext,
  withTenantAs,
} from "./sales-gate-support";

/**
 * The sync change log (plan PR51): every domain write leaves a change in its own
 * transaction, sequences are assigned per organization at commit in commit
 * order (gapless, never skipped by a reader), rolled back work leaves nothing,
 * and the runtime can read the log but never write it.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const rollbackPattern = /intentional rollback/;

type Tenant = Awaited<ReturnType<typeof createTenantFixture>>;

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

    const tenantA = await createTenantFixture(admin.pool, "sync A");
    const tenantB = await createTenantFixture(admin.pool, "sync B");
    const loginSuffix = randomUUID().replaceAll("-", "");
    loginRole = `polaris_sync_gate_${loginSuffix}`;
    const loginPassword = randomBytes(24).toString("hex");
    await admin.pool.query(
      `CREATE ROLE "${loginRole}" WITH LOGIN INHERIT PASSWORD '${loginPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
    );
    await admin.pool.query(`GRANT "${runtimeRole}" TO "${loginRole}"`);
    const runtimeUrl = temporaryRuntimeUrl(adminUrl, loginRole, loginPassword);
    const runtimeDatabase = createDatabase(runtimeUrl, { maxConnections: 10 });
    runtime = runtimeDatabase;
    const { db } = runtimeDatabase;
    const rt = { adminPool: admin.pool, db };

    const pull = (
      tenant: Tenant,
      cursor: string | number | null,
      limit = 500
    ) =>
      withTenantAs(db, tenant, "sync:read", (transaction, identity) =>
        pullSyncChanges(transaction, identity, { cursor, limit })
      );
    const cursorOf = (tenant: Tenant) =>
      withTenantAs(db, tenant, "sync:read", (transaction, identity) =>
        getSyncCursor(transaction, identity)
      );
    const seqs = async (tenant: Tenant) =>
      (
        await admin.pool.query<{ seq_text: string }>(
          "SELECT seq::text AS seq_text FROM public.sync_changes WHERE organization_id = $1 ORDER BY seq",
          [tenant.organizationId]
        )
      ).rows.map((row) => Number(row.seq_text));
    const keys = (changes: SyncChange[]) =>
      changes.map((change) => `${change.entityType}:${change.entityId}`);

    // ------------------------------------------- 1. privileges and the guards
    const privileges = await admin.pool.query<{
      table_name: string;
      forced: boolean;
      can_select: boolean;
      can_insert: boolean;
      can_update: boolean;
      can_delete: boolean;
      public_select: boolean;
    }>(
      `SELECT c.relname AS table_name, c.relforcerowsecurity AS forced,
              has_table_privilege($1, c.oid, 'SELECT') AS can_select,
              has_any_column_privilege($1, c.oid, 'INSERT') AS can_insert,
              has_any_column_privilege($1, c.oid, 'UPDATE') AS can_update,
              has_table_privilege($1, c.oid, 'DELETE') AS can_delete,
              has_table_privilege('public', c.oid, 'SELECT') AS public_select
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname IN ('sync_changes', 'sync_cursors')
        ORDER BY c.relname`,
      [runtimeRole]
    );
    assert.deepEqual(privileges.rows, [
      {
        can_delete: false,
        can_insert: false,
        can_select: true,
        can_update: false,
        forced: true,
        public_select: false,
        table_name: "sync_changes",
      },
      {
        can_delete: false,
        can_insert: false,
        can_select: false,
        can_update: false,
        forced: true,
        public_select: false,
        table_name: "sync_cursors",
      },
    ]);
    const functions = await admin.pool.query<{
      proname: string;
      prosecdef: boolean;
      pinned: boolean;
      public_exec: boolean;
    }>(
      `SELECT p.proname, p.prosecdef,
              coalesce(p.proconfig::text LIKE '%search_path=pg_catalog, public%', false) AS pinned,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
         FROM pg_proc p
        WHERE p.proname IN ('record_sync_change', 'assign_sync_change_sequence', 'guard_sync_change_update')
        ORDER BY p.proname`
    );
    assert.deepEqual(functions.rows, [
      {
        pinned: true,
        proname: "assign_sync_change_sequence",
        prosecdef: true,
        public_exec: false,
      },
      {
        pinned: true,
        proname: "guard_sync_change_update",
        prosecdef: false,
        public_exec: false,
      },
      {
        pinned: true,
        proname: "record_sync_change",
        prosecdef: true,
        public_exec: false,
      },
    ]);
    tests.push(
      "the runtime can only SELECT the change log (never write it, never touch the cursor counters); the trigger functions are pinned, not executable by PUBLIC, and the writers are SECURITY DEFINER"
    );

    // ---------------------------------------------- 2. every write leaves a change
    assert.equal(
      await cursorOf(tenantA),
      0,
      "a fresh organization starts at 0"
    );
    assert.deepEqual(await pull(tenantA, null), {
      changes: [],
      hasMore: false,
      nextCursor: 0,
    });

    const category = await withTenantAs(
      db,
      tenantA,
      "category:create",
      (transaction, identity) =>
        createCategory(transaction, identity, { name: `Cat ${randomUUID()}` })
    );
    const product = await createSellableProduct(rt, tenantA, "sync", {
      cost: "2.00",
      quantity: 10,
    });
    const customer = await withTenantAs(
      db,
      tenantA,
      "customer:update",
      (transaction, identity) =>
        createCustomer(transaction, identity, {
          name: "Cliente Sync",
          phone: "+55 11 97777-0001",
          requestId: randomUUID(),
        })
    );
    const sale = await confirmPlainSale(rt, tenantA, [
      { quantity: 2, variantId: product.variantId },
    ]);
    await withTenantAs(
      db,
      tenantA,
      "sale:assign_customer",
      (transaction, identity) =>
        changeSaleCustomerLink(transaction, identity, {
          action: "assign",
          customerId: customer.id,
          expectedVersion: 0,
          saleId: sale.sale.id,
        })
    );
    await withTenantAs(db, tenantA, "sale:return", (transaction, identity) =>
      createSaleReturn(transaction, identity, {
        commandId: randomUUID(),
        commandVersion: 1,
        items: [{ position: 0, restockedQuantity: 1, returnedQuantity: 1 }],
        saleId: sale.sale.id,
      })
    );
    const secondSale = await confirmPlainSale(rt, tenantA, [
      { quantity: 1, variantId: product.variantId },
    ]);
    await withTenantAs(db, tenantA, "sale:cancel", (transaction, identity) =>
      cancelSale(transaction, identity, {
        commandId: randomUUID(),
        commandVersion: 1,
        saleId: secondSale.sale.id,
      })
    );

    const everything = await pull(tenantA, null);
    const seen = new Set(keys(everything.changes));
    for (const expected of [
      `category:${category.id}`,
      `product:${product.productId}`,
      `inventory_balance:${product.variantId}`,
      `customer:${customer.id}`,
      `sale:${sale.sale.id}`,
      `sale:${secondSale.sale.id}`,
    ]) {
      assert.ok(seen.has(expected), `a change was recorded for ${expected}`);
    }
    assert.equal(everything.hasMore, false);
    // variant rows never appear as their own entity: they belong to the product
    assert.ok(
      [...seen].every((key) =>
        [
          "category",
          "customer",
          "inventory_balance",
          "payment_profile",
          "product",
          "sale",
        ].includes(key.split(":")[0] ?? "")
      )
    );
    tests.push(
      "writing a category, product (with its variants), stock balance, customer, sale, customer link, return and cancellation each leaves a change for the right entity in the same transaction"
    );

    // --------------------------------------------------- 3. gapless sequences
    const all = await seqs(tenantA);
    assert.deepEqual(
      all,
      all.map((_, index) => index + 1),
      "sequences start at 1 and have no gaps"
    );
    assert.equal(await cursorOf(tenantA), all.length);
    assert.equal(
      (await seqs(tenantB)).length,
      0,
      "another organization has its own log"
    );
    await withTenantAs(
      db,
      tenantB,
      "category:create",
      (transaction, identity) =>
        createCategory(transaction, identity, { name: `Cat ${randomUUID()}` })
    );
    assert.deepEqual(await seqs(tenantB), [1], "and its own counter from 1");
    assert.deepEqual(
      (await pull(tenantB, null)).changes.map((change) => change.entityType),
      ["category"],
      "organizations never see each other's changes"
    );
    tests.push(
      "sequences are per organization, start at 1 and have no gaps; organizations never see each other's changes"
    );

    // ------------------------------------------------ 4. rollback leaves nothing
    const beforeRollback = await cursorOf(tenantA);
    await assert.rejects(
      () =>
        withTenantAs(
          db,
          tenantA,
          "category:create",
          async (transaction, identity) => {
            await createCategory(transaction, identity, {
              name: `Cat ${randomUUID()}`,
            });
            throw new Error("intentional rollback");
          }
        ),
      rollbackPattern
    );
    assert.equal(await cursorOf(tenantA), beforeRollback);
    await withTenantAs(
      db,
      tenantA,
      "category:create",
      (transaction, identity) =>
        createCategory(transaction, identity, { name: `Cat ${randomUUID()}` })
    );
    assert.equal(
      await cursorOf(tenantA),
      beforeRollback + 1,
      "a rolled back write consumed no sequence number"
    );
    const afterRollback = await seqs(tenantA);
    assert.deepEqual(
      afterRollback,
      afterRollback.map((_, index) => index + 1)
    );
    tests.push(
      "a rolled back transaction leaves no change and consumes no sequence number"
    );

    // ----------------------------------- 5. pull: dedupe, pages and the cursor
    const start = await cursorOf(tenantA);
    for (const name of ["Um", "Dois", "Tres"]) {
      // biome-ignore lint/performance/noAwaitInLoops: three sequential commits on purpose
      const current = await admin.pool.query<{ version: number }>(
        "SELECT version FROM public.products WHERE id = $1",
        [product.productId]
      );
      await withTenantAs(
        db,
        tenantA,
        "product:update",
        (transaction, identity) =>
          updateProduct(transaction, identity, {
            categoryId: null,
            description: null,
            expectedVersion: Number(current.rows[0]?.version),
            id: product.productId,
            name: `Produto ${name} ${product.productId.slice(0, 4)}`,
            requestId: randomUUID(),
          })
      );
    }
    const afterUpdates = await pull(tenantA, start);
    const productChanges = afterUpdates.changes.filter(
      (change) => change.entityType === "product"
    );
    assert.equal(
      productChanges.length,
      1,
      "an entity changed three times in a page appears once"
    );
    assert.equal(
      productChanges[0]?.seq,
      afterUpdates.nextCursor,
      "at its latest sequence"
    );

    // pages of two continue exactly where the previous one stopped
    let walkCursor: string | number = 0;
    const walked: number[] = [];
    for (let page = 0; page < 200; page += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each page needs the previous cursor
      const result: Awaited<ReturnType<typeof pull>> = await pull(
        tenantA,
        walkCursor,
        2
      );
      if (result.changes.length === 0) {
        break;
      }
      assert.ok(result.nextCursor > Number(walkCursor));
      walked.push(...result.changes.map((change) => change.seq));
      walkCursor = result.nextCursor;
      if (!result.hasMore) {
        break;
      }
    }
    assert.equal(
      walkCursor,
      await cursorOf(tenantA),
      "the walk ends at the cursor"
    );
    assert.deepEqual(
      [...walked].sort((left, right) => left - right),
      [...new Set(walked)].sort((left, right) => left - right),
      "no change is delivered twice across pages when its entity is unique in them"
    );
    assert.deepEqual(await pull(tenantA, walkCursor), {
      changes: [],
      hasMore: false,
      nextCursor: Number(walkCursor),
    });
    for (const bad of ["abc", "-1", "1.5", "1e3", "12345678901234567"]) {
      // biome-ignore lint/performance/noAwaitInLoops: each probe is verified on its own
      await assert.rejects(() => pull(tenantA, bad), InvalidSyncCursorError);
    }
    assert.throws(() => parseSyncCursor(Number.MAX_SAFE_INTEGER + 10));
    assert.equal(parseSyncCursor(null), 0);
    assert.equal(parseSyncCursor("0"), 0);
    tests.push(
      "pull returns an entity changed several times once at its latest sequence, pages continue exactly where the previous stopped, an empty pull keeps the cursor, and malformed cursors are refused"
    );

    // ---------------------------------------------- 6. the runtime cannot write
    for (const [statement, label] of [
      [
        "INSERT INTO public.sync_changes (organization_id, entity_type, entity_id) VALUES ($1, 'product', gen_random_uuid())",
        "forge a change",
      ],
      [
        "UPDATE public.sync_changes SET seq = seq + 1 WHERE organization_id = $1",
        "edit a change",
      ],
      [
        "DELETE FROM public.sync_changes WHERE organization_id = $1",
        "delete a change",
      ],
      [
        "SELECT * FROM public.sync_cursors WHERE organization_id = $1",
        "read the counters",
      ],
      [
        "UPDATE public.sync_cursors SET last_seq = 0 WHERE organization_id = $1",
        "reset the counters",
      ],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: each probe is verified before the next one starts
      await expectSqlState(
        () =>
          withRuntimeSqlContext(runtimeUrl, tenantA, (client) =>
            client.query(statement, [tenantA.organizationId])
          ),
        "42501",
        `the tenant runtime cannot ${label}`
      );
    }
    await expectSqlState(
      () =>
        admin.pool.query(
          "UPDATE public.sync_changes SET entity_type = 'sale' WHERE organization_id = $1",
          [tenantA.organizationId]
        ),
      "23514",
      "even the owner cannot edit a change (append-only trigger)",
      "sync_changes_append_only"
    );
    const wrongScope = await withRuntimeSqlContext(
      runtimeUrl,
      tenantB,
      (client) =>
        client.query(
          "SELECT count(*)::int AS count FROM public.sync_changes WHERE organization_id = $1",
          [tenantA.organizationId]
        )
    );
    assert.equal(
      wrongScope.rows[0]?.count,
      0,
      "row security hides another organization's log even when asked for by id"
    );
    tests.push(
      "the runtime cannot forge, edit or delete a change or read the counters; the owner cannot edit one either; row security hides another organization's log"
    );

    // ------------------------------- 7. writes outside the repositories count too
    const beforeRaw = await cursorOf(tenantA);
    await admin.pool.query(
      "UPDATE public.customers SET notes = 'raw' WHERE id = $1",
      [customer.id]
    );
    const rawPull = await pull(tenantA, beforeRaw);
    assert.deepEqual(keys(rawPull.changes), [`customer:${customer.id}`]);
    tests.push(
      "a write that bypasses the repositories (raw SQL) is logged just the same, because the triggers live on the tables"
    );

    // ----------------------- 8. concurrent writers and a poller never lose a change
    const racingTenant = await createTenantFixture(admin.pool, "sync race");
    const writers = 6;
    const perWriter = 6;
    const observed: number[] = [];
    let pollCursor = 0;
    const polling = { stop: false };
    const isStopped = () => polling.stop;
    let contiguityBreaks = 0;
    const poller = (async () => {
      // biome-ignore lint/suspicious/noUnnecessaryConditions: the flag is flipped by the code that awaits this poller.
      while (!isStopped()) {
        // biome-ignore lint/performance/noAwaitInLoops: a poller is sequential by definition
        const page = await pull(racingTenant, pollCursor, 500);
        const pageSeqs = page.changes.map((change) => change.seq);
        pageSeqs.forEach((seq, index) => {
          if (seq !== pollCursor + index + 1) {
            contiguityBreaks += 1;
          }
        });
        observed.push(...pageSeqs);
        pollCursor = page.nextCursor;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    })();
    await Promise.all(
      Array.from({ length: writers }, () =>
        withTenantAs(
          db,
          racingTenant,
          "category:create",
          async (transaction, identity) => {
            for (let index = 0; index < perWriter; index += 1) {
              // biome-ignore lint/performance/noAwaitInLoops: rows of one transaction are written in order
              await createCategory(transaction, identity, {
                name: `Cat ${randomUUID()}`,
              });
            }
          }
        )
      )
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    polling.stop = true;
    await poller;
    const finalPage = await pull(racingTenant, pollCursor, 500);
    observed.push(...finalPage.changes.map((change) => change.seq));
    const total = writers * perWriter;
    assert.deepEqual(
      [...observed].sort((left, right) => left - right),
      Array.from({ length: total }, (_, index) => index + 1),
      "the poller saw every change exactly once"
    );
    assert.equal(
      contiguityBreaks,
      0,
      "every page continued exactly at the cursor: no reader ever skipped ahead"
    );
    assert.deepEqual(
      await seqs(racingTenant),
      Array.from({ length: total }, (_, index) => index + 1)
    );
    tests.push(
      "with concurrent writers and a polling reader, sequences stay gapless in commit order and no page ever skips a change that commits later"
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
  console.error(`Sync log PostgreSQL gate failed (${redactedFailure(error)})`);
  process.exitCode = 1;
});
