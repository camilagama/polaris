import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  BOOTSTRAP_COLLECTIONS,
  type BootstrapCollection,
  type BootstrapPage,
  readBootstrapPage,
} from "../src/bootstrap-repository";
import { createCategory } from "../src/category-repository";
import { createDatabase } from "../src/client";
import { createCustomer } from "../src/customer-repository";
import {
  archiveProduct,
  configureProductVariants,
  createProduct,
  setProductVariantListPrice,
} from "../src/product-repository";
import {
  createSellableProduct,
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
 * The local collections a device bootstraps from (plan PR50): keyset pages of
 * categories, products, variants, stock balances and customers, and re-reading
 * specific entities after a change. Reads are scoped to the organization and
 * carry no costs.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

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

    const tenantA = await createTenantFixture(admin.pool, "boot A");
    const tenantB = await createTenantFixture(admin.pool, "boot B");
    const loginSuffix = randomUUID().replaceAll("-", "");
    loginRole = `polaris_boot_gate_${loginSuffix}`;
    const loginPassword = randomBytes(24).toString("hex");
    await admin.pool.query(
      `CREATE ROLE "${loginRole}" WITH LOGIN INHERIT PASSWORD '${loginPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
    );
    await admin.pool.query(`GRANT "${runtimeRole}" TO "${loginRole}"`);
    const runtimeUrl = temporaryRuntimeUrl(adminUrl, loginRole, loginPassword);
    const runtimeDatabase = createDatabase(runtimeUrl, { maxConnections: 4 });
    runtime = runtimeDatabase;
    const { db } = runtimeDatabase;
    const rt = { adminPool: admin.pool, db };

    // ----------------------------------------------------------- fixtures
    for (let index = 0; index < 5; index += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: fixtures are created one after another
      await withTenantAs(
        db,
        tenantA,
        "category:create",
        (transaction, identity) =>
          createCategory(transaction, identity, {
            name: `Categoria ${index} ${randomUUID()}`,
          })
      );
    }
    const stocked = await createSellableProduct(rt, tenantA, "boot um", {
      cost: "7.00",
      quantity: 12,
    });
    const priced = await createSellableProduct(rt, tenantA, "boot dois", {
      cost: "3.00",
      quantity: 4,
    });
    const archived = await createSellableProduct(rt, tenantA, "boot tres", {
      cost: "1.00",
      quantity: 1,
    });
    await withTenantAs(
      db,
      tenantA,
      "product:update",
      async (transaction, identity) => {
        await setProductVariantListPrice(transaction, identity, {
          expectedVersion: priced.version,
          id: priced.productId,
          listPrice: "59.9",
          variantId: priced.variantId,
        });
        await archiveProduct(transaction, identity, {
          expectedVersion: archived.version,
          id: archived.productId,
        });
      }
    );
    const configurable = await withTenantAs(
      db,
      tenantA,
      "product:create",
      (transaction, identity) =>
        createProduct(transaction, identity, {
          name: `Configuravel ${randomUUID()}`,
          requestId: randomUUID(),
        })
    );
    await withTenantAs(db, tenantA, "product:update", (transaction, identity) =>
      configureProductVariants(transaction, identity, {
        expectedVersion: configurable.version,
        id: configurable.id,
        options: [
          { name: "color", values: ["Azul", "Preto"] },
          { name: "size", values: ["P"] },
        ],
        requestId: randomUUID(),
        variants: [
          { values: { color: "Azul", size: "P" } },
          { values: { color: "Preto", size: "P" } },
        ],
      })
    );
    for (const name of ["Ana", "Bia", "Caio"]) {
      // biome-ignore lint/performance/noAwaitInLoops: fixtures are created one after another
      await withTenantAs(
        db,
        tenantA,
        "customer:update",
        (transaction, identity) =>
          createCustomer(transaction, identity, {
            name,
            phone: `+55 11 9${Math.floor(Math.random() * 1e7)}`,
            requestId: randomUUID(),
          })
      );
    }
    await createSellableProduct(rt, tenantB, "outra loja", {
      cost: "2.00",
      quantity: 9,
    });

    const read = (
      tenant: typeof tenantA,
      collection: BootstrapCollection,
      options: { afterId?: string | null; ids?: string[]; limit?: number } = {}
    ): Promise<BootstrapPage> =>
      withTenantAs(db, tenant, "sync:read", (transaction, identity) =>
        readBootstrapPage(transaction, identity, { collection, ...options })
      );
    const walk = async (
      tenant: typeof tenantA,
      collection: BootstrapCollection,
      limit: number
    ) => {
      const rows: BootstrapPage["rows"][number][] = [];
      let afterId: string | null = null;
      let pages = 0;
      for (let guard = 0; guard < 100; guard += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: each page needs the previous position
        const page: BootstrapPage = await read(tenant, collection, {
          afterId,
          limit,
        });
        assert.equal(page.collection, collection);
        rows.push(...page.rows);
        pages += 1;
        afterId = page.nextAfterId;
        if (afterId === null) {
          break;
        }
      }
      return { pages, rows };
    };
    const adminIds = async (sql: string, tenant: typeof tenantA) =>
      (
        await admin.pool.query<{ id: string }>(sql, [tenant.organizationId])
      ).rows.map((row) => row.id);
    const idOf = (row: BootstrapPage["rows"][number]) =>
      "id" in row ? row.id : row.variantId;

    // --------------------------------------- 1. keyset walks cover everything
    const expectedIds: Record<BootstrapCollection, string> = {
      categories:
        "SELECT id FROM public.categories WHERE organization_id = $1 ORDER BY id",
      customers:
        "SELECT id FROM public.customers WHERE organization_id = $1 ORDER BY id",
      inventory:
        "SELECT variant_id AS id FROM public.inventory_balances WHERE organization_id = $1 ORDER BY variant_id",
      products:
        "SELECT id FROM public.products WHERE organization_id = $1 ORDER BY id",
      variants:
        "SELECT id FROM public.product_variants WHERE organization_id = $1 ORDER BY id",
    };
    for (const collection of BOOTSTRAP_COLLECTIONS) {
      // biome-ignore lint/performance/noAwaitInLoops: collections are verified one after another
      const expected = await adminIds(expectedIds[collection], tenantA);
      assert.ok(expected.length > 0, `${collection} has fixtures`);
      const { pages, rows } = await walk(tenantA, collection, 2);
      assert.deepEqual(
        rows.map(idOf),
        expected,
        `${collection}: pages of two cover every row once, in id order`
      );
      assert.equal(
        pages,
        Math.ceil(expected.length / 2),
        `${collection}: the number of pages`
      );
      const whole = await walk(tenantA, collection, 500);
      assert.equal(whole.pages, 1);
      assert.deepEqual(whole.rows.map(idOf), expected);
    }
    tests.push(
      "keyset pages (size two and size 500) of categories, customers, stock balances, products and variants cover every row exactly once in id order, and the last page has no next position"
    );

    // --------------------------------------------------- 2. what the rows carry
    const productRows = (await walk(tenantA, "products", 500)).rows;
    const archivedRow = productRows.find(
      (row) => "id" in row && row.id === archived.productId
    );
    assert.ok(archivedRow && "archivedAt" in archivedRow);
    assert.notEqual(
      archivedRow.archivedAt,
      null,
      "archived products travel too"
    );
    for (const row of productRows) {
      assert.deepEqual(
        Object.keys(row).sort(),
        [
          "archivedAt",
          "categoryId",
          "deletedAt",
          "description",
          "id",
          "name",
          "updatedAt",
          "version",
        ],
        "a product row carries no organization id and no variant marker"
      );
    }
    const variantRows = (await walk(tenantA, "variants", 500)).rows;
    const pricedVariant = variantRows.find(
      (row) => "listPrice" in row && row.id === priced.variantId
    );
    assert.ok(pricedVariant && "listPrice" in pricedVariant);
    assert.equal(pricedVariant.listPrice, "59.90");
    const combinations = variantRows.filter(
      (row) => "productId" in row && row.productId === configurable.id
    );
    assert.equal(combinations.length, 2);
    assert.deepEqual(
      combinations
        .map((row) =>
          "values" in row
            ? row.values.map(
                (value) => `${value.optionName}=${value.optionValueName}`
              )
            : []
        )
        .sort(),
      [
        ["color=Azul", "size=P"],
        ["color=Preto", "size=P"],
      ]
    );
    const inventoryRows = (await walk(tenantA, "inventory", 500)).rows;
    const stockedRow = inventoryRows.find(
      (row) => "variantId" in row && row.variantId === stocked.variantId
    );
    assert.ok(stockedRow && "quantity" in stockedRow);
    assert.equal(stockedRow.quantity, 12);
    for (const row of inventoryRows) {
      assert.deepEqual(
        Object.keys(row).sort(),
        ["productId", "quantity", "updatedAt", "variantId", "version"],
        "a stock row never carries a cost"
      );
    }
    tests.push(
      "rows carry what offline work needs (archive state, list price, option values, quantities) and never costs, organization ids or audit data"
    );

    // ----------------------------------------------- 3. re-reading by ids
    const someCategories = (await walk(tenantA, "categories", 500)).rows
      .slice(1, 3)
      .map(idOf);
    const byIds = await read(tenantA, "categories", {
      ids: [...someCategories, randomUUID()],
    });
    assert.deepEqual(byIds.rows.map(idOf).sort(), [...someCategories].sort());
    assert.equal(byIds.nextAfterId, null);
    const variantsOfProduct = await read(tenantA, "variants", {
      ids: [configurable.id, priced.productId],
    });
    assert.deepEqual(
      variantsOfProduct.rows
        .map((row) => ("productId" in row ? row.productId : ""))
        .sort(),
      [configurable.id, configurable.id, priced.productId].sort(),
      "variants are re-read by PRODUCT id"
    );
    const balancesByVariant = await read(tenantA, "inventory", {
      ids: [stocked.variantId, priced.variantId],
    });
    assert.deepEqual(
      balancesByVariant.rows.map(idOf).sort(),
      [stocked.variantId, priced.variantId].sort()
    );
    assert.deepEqual((await read(tenantA, "customers", { ids: [] })).rows, []);
    tests.push(
      "specific entities can be re-read by id (variants by product id, balances by variant id) and an unknown id is simply absent"
    );

    // ------------------------------------------------------- 4. isolation
    const strangerCategories = await read(tenantB, "categories", {
      ids: someCategories,
    });
    assert.deepEqual(
      strangerCategories.rows,
      [],
      "another organization cannot read these ids"
    );
    const bProducts = (await walk(tenantB, "products", 500)).rows;
    assert.equal(bProducts.length, 1);
    assert.ok(
      bProducts.every((row) => "id" in row && row.id !== stocked.productId)
    );
    tests.push(
      "reads are scoped to the organization: another tenant sees none of these rows, even by id"
    );

    // ------------------------------------------------------- 5. bad input
    for (const input of [
      { limit: 0 },
      { limit: 501 },
      { limit: 1.5 },
      { ids: Array.from({ length: 201 }, () => randomUUID()) },
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each probe is verified on its own
      await assert.rejects(
        () => read(tenantA, "categories", input),
        RangeError
      );
    }
    tests.push("an out-of-range page size or too many ids is refused");

    // Variants by product id: more than 40 products could be cut off silently.
    await assert.rejects(
      () =>
        read(tenantA, "variants", {
          ids: Array.from({ length: 41 }, () => randomUUID()),
        }),
      RangeError
    );
    await read(tenantA, "variants", {
      ids: Array.from({ length: 40 }, () => randomUUID()),
    });
    tests.push(
      "reading variants for more than 40 products at once is refused, so an answer is never silently cut short"
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
  console.error(`Bootstrap PostgreSQL gate failed (${redactedFailure(error)})`);
  process.exitCode = 1;
});
