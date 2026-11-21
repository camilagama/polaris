// biome-ignore-all lint/performance/noAwaitInLoops: a gate runs its probes strictly one at a time, for a clear failure
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  PRODUCT_DELETE_LIMIT_PER_HOUR,
  ProductDeleteRateLimitedError,
  ProductLifecycleError,
  ProductStockNotEmptyError,
  ProductVersionConflictError,
} from "@polaris/domain/catalog/product";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/client";
import { inventoryCount } from "../src/inventory-repository";
import {
  archiveProduct,
  countOrganizationVariants,
  createProduct,
  deleteProduct,
} from "../src/product-repository";
import { withAuthorizedTenantTransaction } from "../src/tenant-transaction";
import {
  advisoryLock,
  eachRound,
  fulfilled,
  raceBehindLock,
  raceRounds,
  rejections,
} from "./concurrency-support";
import { archiveThenDeleteProduct } from "./product-lifecycle-support";
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
} from "./sales-gate-support";

/**
 * `product.delete` on a real PostgreSQL 18 (the corte "excluir produto arquivado", item 1):
 *   1. only an archived product is deleted: an active one is refused with `product_lifecycle_conflict` and nothing is
 *      written or audited; an archived one with zero stock is deleted, audited, and gives its variants back to the
 *      plan; a positive balance is refused with `product_stock_not_empty`; repeating a deletion changes nothing;
 *   2. `deleted_at` is the database's `now()`;
 *   3. at most `PRODUCT_DELETE_LIMIT_PER_HOUR` completed deletions per organization in the last hour: the 50th passes
 *      and the 51st is refused with the limit and the seconds until the next place opens; only a completed deletion
 *      spends the quota (a refusal for version, stock, lifecycle or the cap itself spends nothing); another
 *      organization is not affected; after the hour the deletion works again;
 *   4. with 49 deletions done, two simultaneous deletions of different products commit exactly one (the advisory lock
 *      is taken after the row lock, and READ COMMITTED lets the second see the first);
 *   5. the deletion refuses to run in REPEATABLE READ, where the second of two would not see the first.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const HOUR_SECONDS = 3600;
const readCommittedRefusal = /product_delete_requires_read_committed/;

async function run() {
  const branch = requiredEnvironment("POLARIS_SALES_GATE_BRANCH");
  assert.match(branch, gateBranchPattern);
  const adminUrl = requiredEnvironment("POLARIS_SALES_GATE_DATABASE_URL");
  const parsedAdminUrl = new URL(adminUrl);
  assert.match(parsedAdminUrl.hostname, disposableHostPattern);
  assert.doesNotMatch(parsedAdminUrl.hostname, poolerPattern);

  const owner = createDatabase(adminUrl, { maxConnections: 4 });
  const logins: string[] = [];
  const tests: string[] = [];
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

    const role = `polaris_product_delete_${randomUUID().replaceAll("-", "")}`;
    const password = randomBytes(24).toString("hex");
    await owner.pool.query(
      `CREATE ROLE "${role}" WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`
    );
    await owner.pool.query(`GRANT "${runtimeRole}" TO "${role}"`);
    logins.push(role);
    runtime = createDatabase(temporaryRuntimeUrl(adminUrl, role, password), {
      maxConnections: 8,
    });
    const { db } = runtime;
    const suffix = randomUUID().slice(0, 8);

    const newShop = (label: string) =>
      createTenantFixture(owner.pool, `product delete ${label} ${suffix}`);
    const create = async (shop: TenantFixture, label: string) => {
      const product = await withTenantAs(
        db,
        shop,
        "product:create",
        (transaction, identity) =>
          createProduct(transaction, identity, {
            name: `Produto ${label} ${randomUUID()}`,
            requestId: randomUUID(),
          })
      );
      return { id: product.id, version: product.version };
    };
    const archived = async (shop: TenantFixture, label: string) => {
      const product = await create(shop, label);
      const result = await withTenantAs(
        db,
        shop,
        "product:update",
        (transaction, identity) =>
          archiveProduct(transaction, identity, {
            expectedVersion: product.version,
            id: product.id,
            requestId: randomUUID(),
          })
      );
      return { id: product.id, version: result.product.version };
    };
    const remove = (
      shop: TenantFixture,
      product: { id: string; version: number }
    ) =>
      withTenantAs(db, shop, "product:update", (transaction, identity) =>
        deleteProduct(transaction, identity, {
          expectedVersion: product.version,
          id: product.id,
          requestId: randomUUID(),
        })
      );
    const seedDeleted = async (shop: TenantFixture, count: number) => {
      const ids: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const product = await create(shop, "seed");
        await withTenantAs(
          db,
          shop,
          "product:update",
          (transaction, identity) =>
            archiveThenDeleteProduct(transaction, identity, {
              expectedVersion: product.version,
              id: product.id,
              requestId: randomUUID(),
            })
        );
        ids.push(product.id);
      }
      return ids;
    };
    const row = async (shop: TenantFixture, id: string) => {
      const result = await owner.pool.query<{
        deleted: boolean;
        version: number;
      }>(
        "SELECT deleted_at IS NOT NULL AS deleted, version FROM public.products WHERE organization_id = $1 AND id = $2",
        [shop.organizationId, id]
      );
      assert.ok(result.rows[0]);
      return result.rows[0];
    };
    const deletedLastHour = async (shop: TenantFixture) =>
      Number(
        (
          await owner.pool.query<{ total: string }>(
            "SELECT count(*)::text AS total FROM public.products WHERE organization_id = $1 AND deleted_at > now() - interval '1 hour'",
            [shop.organizationId]
          )
        ).rows[0]?.total
      );
    const deletionAudits = async (shop: TenantFixture) =>
      Number(
        (
          await owner.pool.query<{ total: string }>(
            "SELECT count(*)::text AS total FROM public.tenant_audit_event WHERE organization_id = $1 AND event_type = 'product.deleted'",
            [shop.organizationId]
          )
        ).rows[0]?.total
      );
    const variants = (shop: TenantFixture) =>
      withTenantAs(db, shop, "catalog:read", (transaction) =>
        countOrganizationVariants(transaction, shop.organizationId)
      );
    // a tombstone is immutable: moving one in time, or stamping one without the cap, needs the guard off for one statement
    const withGuardOff = async (statement: string, params: unknown[]) => {
      const client = await owner.pool.connect();
      try {
        await client.query(
          "ALTER TABLE public.products DISABLE TRIGGER products_tombstone_guard"
        );
        await client.query(statement, params);
      } finally {
        await client.query(
          "ALTER TABLE public.products ENABLE TRIGGER products_tombstone_guard"
        );
        client.release();
      }
    };
    const moveDeletion = (id: string, secondsEarlier: number) =>
      withGuardOff(
        "UPDATE public.products SET deleted_at = deleted_at - make_interval(secs => $2::int) WHERE id = $1",
        [id, secondsEarlier]
      );
    const stampDeletion = (id: string) =>
      withGuardOff(
        "UPDATE public.products SET deleted_at = now(), version = version + 1 WHERE id = $1",
        [id]
      );

    // ------------------------------------------------ 1. only archived, zero stock, audited, replay
    const lifecycle = await newShop("lifecycle");
    const active = await create(lifecycle, "ativo");
    const auditsBefore = await deletionAudits(lifecycle);
    await assert.rejects(
      remove(lifecycle, active),
      (error: unknown) =>
        error instanceof ProductLifecycleError &&
        error.code === "product_lifecycle_conflict"
    );
    assert.deepEqual(await row(lifecycle, active.id), {
      deleted: false,
      version: active.version,
    });
    assert.equal(
      await deletionAudits(lifecycle),
      auditsBefore,
      "a refused deletion leaves no audit"
    );
    tests.push(
      "deleting an active product is refused with product_lifecycle_conflict, writes nothing and audits nothing"
    );

    const toDelete = await archived(lifecycle, "arquivado");
    const variantsBefore = await variants(lifecycle);
    const outcome = await withTenantAs(
      db,
      lifecycle,
      "product:update",
      async (transaction, identity) => {
        const result = await deleteProduct(transaction, identity, {
          expectedVersion: toDelete.version,
          id: toDelete.id,
          requestId: randomUUID(),
        });
        const clock = await transaction.execute(
          sql`SELECT (deleted_at = now()) AS same FROM public.products WHERE id = ${toDelete.id}`
        );
        return { clock: clock.rows[0] as { same: boolean }, result };
      }
    );
    assert.equal(outcome.result.changed, true);
    assert.ok(outcome.result.product.deletedAt instanceof Date);
    assert.equal(
      outcome.clock.same,
      true,
      "deleted_at is the database's now(), read in the same transaction"
    );
    assert.equal(await deletionAudits(lifecycle), auditsBefore + 1);
    assert.equal(
      await variants(lifecycle),
      variantsBefore - 1,
      "the deleted product gives its place back to the plan"
    );
    tests.push(
      "an archived product with zero stock is deleted as a tombstone with deleted_at from the database clock, audited once, and its variant stops counting"
    );

    const spentBefore = await deletedLastHour(lifecycle);
    const replay = await remove(lifecycle, toDelete);
    assert.equal(replay.changed, false);
    assert.equal(await deletedLastHour(lifecycle), spentBefore);
    assert.equal(await deletionAudits(lifecycle), auditsBefore + 1);
    tests.push(
      "repeating the deletion of a deleted product answers no change, audits nothing and spends no quota"
    );

    const stocked = await archived(lifecycle, "com saldo");
    const [stockedVariant] = (
      await owner.pool.query<{ id: string }>(
        "SELECT id FROM public.product_variants WHERE organization_id = $1 AND product_id = $2",
        [lifecycle.organizationId, stocked.id]
      )
    ).rows;
    assert.ok(stockedVariant);
    await withTenantAs(
      db,
      lifecycle,
      "inventory:adjust",
      (transaction, identity) =>
        inventoryCount(transaction, identity, {
          commandId: randomUUID(),
          commandVersion: 1,
          expectedVersion: 0,
          occurredOn: "2026-10-01",
          physicalQuantity: 3,
          valuationUnitCost: null,
          variantId: stockedVariant.id,
        })
    );
    const stockedAfterCount = await row(lifecycle, stocked.id);
    await assert.rejects(
      remove(lifecycle, { id: stocked.id, version: stockedAfterCount.version }),
      ProductStockNotEmptyError
    );
    assert.equal((await row(lifecycle, stocked.id)).deleted, false);
    tests.push(
      "an archived product with a positive balance is refused with product_stock_not_empty"
    );

    // ------------------------------------------------ 2. the cap: 50 pass, 51 are refused, only completed deletions count
    assert.equal(PRODUCT_DELETE_LIMIT_PER_HOUR, 50);
    const capped = await newShop("cap");
    const cappedStocked = await archived(capped, "com saldo");
    const [cappedVariant] = (
      await owner.pool.query<{ id: string }>(
        "SELECT id FROM public.product_variants WHERE organization_id = $1 AND product_id = $2",
        [capped.organizationId, cappedStocked.id]
      )
    ).rows;
    assert.ok(cappedVariant);
    await withTenantAs(
      db,
      capped,
      "inventory:adjust",
      (transaction, identity) =>
        inventoryCount(transaction, identity, {
          commandId: randomUUID(),
          commandVersion: 1,
          expectedVersion: 0,
          occurredOn: "2026-10-01",
          physicalQuantity: 2,
          valuationUnitCost: null,
          variantId: cappedVariant.id,
        })
    );
    const cappedStockedVersion = (await row(capped, cappedStocked.id)).version;
    const done = await seedDeleted(capped, 49);
    assert.equal(await deletedLastHour(capped), 49);
    const fiftieth = await archived(capped, "quinquagésimo");
    const fiftyFirst = await archived(capped, "quinquagésimo primeiro");
    const cappedActive = await create(capped, "ativo");
    await remove(capped, fiftieth);
    assert.equal(
      await deletedLastHour(capped),
      PRODUCT_DELETE_LIMIT_PER_HOUR,
      "the 50th deletion of the hour passes"
    );
    const cappedAudits = await deletionAudits(capped);

    const refused = await remove(capped, fiftyFirst).then(
      () => null,
      (error: unknown) => error
    );
    assert.ok(refused instanceof ProductDeleteRateLimitedError);
    assert.equal(refused.code, "product_delete_rate_limited");
    assert.equal(refused.limit, 50);
    assert.ok(
      refused.retryAfterSeconds > HOUR_SECONDS - 120 &&
        refused.retryAfterSeconds <= HOUR_SECONDS,
      `the next place opens in about an hour (${refused.retryAfterSeconds}s)`
    );
    tests.push(
      "the 50th deletion of the hour passes and the 51st is refused with the limit and the seconds until a place opens"
    );

    await assert.rejects(
      remove(capped, { id: fiftyFirst.id, version: fiftyFirst.version + 7 }),
      ProductVersionConflictError
    );
    await assert.rejects(
      remove(capped, {
        id: cappedStocked.id,
        version: cappedStockedVersion,
      }),
      ProductStockNotEmptyError
    );
    await assert.rejects(remove(capped, cappedActive), ProductLifecycleError);
    assert.equal(
      await deletedLastHour(capped),
      PRODUCT_DELETE_LIMIT_PER_HOUR,
      "no refusal spends quota"
    );
    assert.equal(await deletionAudits(capped), cappedAudits);
    assert.equal((await row(capped, fiftyFirst.id)).deleted, false);
    tests.push(
      "with the window full a stale version, a positive balance and an active product keep their own refusals (stock before the cap) and nothing spends quota"
    );

    const other = await newShop("other store");
    const otherProduct = await archived(other, "outra loja");
    assert.equal((await remove(other, otherProduct)).changed, true);
    tests.push("the cap is per organization: another store deletes freely");

    const [oldest, second] = done;
    assert.ok(oldest && second);
    await moveDeletion(oldest, HOUR_SECONDS - 600);
    const nearlyFree = await remove(capped, fiftyFirst).then(
      () => null,
      (error: unknown) => error
    );
    assert.ok(nearlyFree instanceof ProductDeleteRateLimitedError);
    assert.ok(
      nearlyFree.retryAfterSeconds >= 1 && nearlyFree.retryAfterSeconds <= 600,
      `the place opens when the oldest deletion leaves the window (${nearlyFree.retryAfterSeconds}s)`
    );

    // 51 in the window (only reachable by planting one): the place opens when the 2nd oldest leaves, not the oldest
    const planted = await archived(capped, "fora do teto");
    await stampDeletion(planted.id);
    await moveDeletion(second, HOUR_SECONDS - 1800);
    assert.equal(await deletedLastHour(capped), 51);
    const overfull = await remove(capped, fiftyFirst).then(
      () => null,
      (error: unknown) => error
    );
    assert.ok(overfull instanceof ProductDeleteRateLimitedError);
    assert.ok(
      overfull.retryAfterSeconds > 1200 && overfull.retryAfterSeconds <= 1800,
      `with 51 in the window the next place opens when the 2nd oldest leaves (${overfull.retryAfterSeconds}s)`
    );

    await moveDeletion(oldest, HOUR_SECONDS);
    await moveDeletion(second, HOUR_SECONDS);
    assert.equal(await deletedLastHour(capped), 49);
    assert.equal((await remove(capped, fiftyFirst)).changed, true);
    assert.equal(await deletedLastHour(capped), 50);
    tests.push(
      "retryAfterSeconds is when the limit-th newest deletion of the window leaves it (the oldest with 50, the second oldest with 51), and once it leaves a deletion works again"
    );

    // ------------------------------------------------ 3. isolation: REPEATABLE READ is refused
    const snapshot = await archived(lifecycle, "snapshot");
    await assert.rejects(
      withAuthorizedTenantTransaction(
        db,
        {
          authenticatedUserId: lifecycle.userId,
          capability: "product:update",
          isolationLevel: "repeatable read",
          requestedOrganizationId: lifecycle.organizationId,
          requireLegalAcceptance: false,
        },
        (transaction, identity) =>
          deleteProduct(transaction, identity, {
            expectedVersion: snapshot.version,
            id: snapshot.id,
            requestId: randomUUID(),
          })
      ),
      readCommittedRefusal
    );
    assert.equal((await row(lifecycle, snapshot.id)).deleted, false);
    tests.push(
      "the deletion refuses to run in REPEATABLE READ and writes nothing"
    );

    // ------------------------------------------------ 4. two simultaneous deletions with 49 done: exactly one
    const rounds = await eachRound(async (round) => {
      const racing = await newShop(`race ${round}`);
      await seedDeleted(racing, 49);
      const racerA = await archived(racing, "corrida a");
      const racerB = await archived(racing, "corrida b");
      const { results } = await raceBehindLock({
        adminUrl,
        hold: [advisoryLock(`polaris.product.delete:${racing.organizationId}`)],
        label: "two deletions into the last place of the hourly cap",
        racers: [racerA, racerB].map(
          (product) => () => remove(racing, product)
        ),
      });
      assert.equal(fulfilled(results).length, 1, "exactly one is accepted");
      const refusals = rejections(results);
      assert.equal(refusals.length, 1);
      assert.ok(refusals[0] instanceof ProductDeleteRateLimitedError);
      assert.equal(
        await deletedLastHour(racing),
        PRODUCT_DELETE_LIMIT_PER_HOUR,
        "never past the cap"
      );
    });
    assert.equal(rounds, raceRounds());
    tests.push(
      `with 49 deletions done, two simultaneous deletions of different products commit exactly one and refuse the other with product_delete_rate_limited (${rounds} round(s), released from a barrier with both seen blocked on the store's lock)`
    );

    assert.equal(tests.length, 11);
    console.log(`gate-note: ${tests.length} cases passed`);
    for (const test of tests) {
      console.log(`ok - ${test}`);
    }
  } finally {
    await runtime?.pool.end().catch(() => undefined);
    for (const role of logins) {
      await owner.pool
        .query(`DROP ROLE IF EXISTS "${role}"`)
        .catch(() => undefined);
    }
    await owner.pool.end();
  }
}

run().catch((error: unknown) => {
  console.error(
    `Product delete PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
