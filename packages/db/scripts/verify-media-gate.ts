import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { Client } from "pg";
import { createDatabase } from "../src/client";
import {
  configureProductVariants,
  createProduct,
  deleteProduct,
} from "../src/product-repository";
import { productVariants } from "../src/schema/product";
import {
  withAuthorizedTenantTransaction,
  type TenantRequestIdentity,
  type TenantRequestTransaction,
} from "../src/tenant-transaction";

const runtimeRole = "polaris_pr11_runtime";
const expectedTables = ["media_assets", "product_media", "variant_media"];
const sqlStatePattern = /^[0-9A-Z]{5}$/;
const disposableHostPattern =
  /^ep-[a-z-]+-[a-z0-9]+\.c-2\.sa-east-1\.aws\.neon\.tech$/;

const poolerPattern = /pooler/i;

type Database = ReturnType<typeof createDatabase>["db"];
type AdminPool = ReturnType<typeof createDatabase>["pool"];

interface TenantFixture {
  organizationId: string;
  userId: string;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error("Missing PR33 media gate configuration.");
  }
  return value;
}

function sqlState(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const { code } = error as { code?: unknown };
  return typeof code === "string" && sqlStatePattern.test(code)
    ? code
    : undefined;
}

async function expectSqlState(
  operation: Promise<unknown>,
  expected: string,
  label: string
): Promise<void> {
  await assert.rejects(
    operation,
    (error: unknown) => {
      assert.equal(sqlState(error), expected, label);
      return true;
    },
    label
  );
}

async function createTenantFixture(
  adminPool: AdminPool,
  label: string
): Promise<TenantFixture> {
  const userId = randomUUID();
  const organizationId = randomUUID();
  await adminPool.query(
    'INSERT INTO public."user" (id, name, email, email_verified) ' +
      "VALUES ($1, $2, $3, true)",
    [userId, `PR33 media gate ${label}`, `pr33-${userId}@example.invalid`]
  );
  await adminPool.query(
    "INSERT INTO public.organizations (id, name, timezone) VALUES ($1, $2, $3)",
    [organizationId, `PR33 media gate ${label}`, "America/Sao_Paulo"]
  );
  await adminPool.query(
    "INSERT INTO public.memberships (organization_id, user_id, role, status) " +
      "VALUES ($1, $2, 'owner', 'active')",
    [organizationId, userId]
  );
  return { organizationId, userId };
}

async function withTenant<T>(
  database: Database,
  fixture: TenantFixture,
  capability: string,
  operation: (
    transaction: TenantRequestTransaction,
    identity: TenantRequestIdentity
  ) => Promise<T>
): Promise<T> {
  return await withAuthorizedTenantTransaction(
    database,
    {
      authenticatedUserId: fixture.userId,
      capability,
      requestedOrganizationId: fixture.organizationId,
    },
    operation
  );
}

async function createTestProduct(
  database: Database,
  fixture: TenantFixture,
  label: string
): Promise<string> {
  const product = await withTenant(
    database,
    fixture,
    "product:create",
    (transaction, identity) =>
      createProduct(transaction, identity, {
        name: `PR33 ${label} ${randomUUID()}`,
        requestId: randomUUID(),
      })
  );
  return product.id;
}

async function getDefaultVariantId(
  database: Database,
  fixture: TenantFixture,
  productId: string
): Promise<string> {
  const [variant] = await withTenant(
    database,
    fixture,
    "catalog:read",
    (transaction) =>
      transaction
        .select({ id: productVariants.id })
        .from(productVariants)
        .where(
          and(
            eq(productVariants.organizationId, fixture.organizationId),
            eq(productVariants.productId, productId),
            eq(productVariants.isDefault, true)
          )
        )
  );
  assert.ok(variant);
  return variant.id;
}

async function getConfiguredVariantIds(
  database: Database,
  fixture: TenantFixture,
  productId: string
): Promise<string[]> {
  const variants = await withTenant(
    database,
    fixture,
    "catalog:read",
    (transaction) =>
      transaction
        .select({ id: productVariants.id })
        .from(productVariants)
        .where(
          and(
            eq(productVariants.organizationId, fixture.organizationId),
            eq(productVariants.productId, productId),
            eq(productVariants.isDefault, false)
          )
        )
        .orderBy(asc(productVariants.position))
  );
  return variants.map((variant) => variant.id);
}

async function createRuntimeClient(connectionString: string): Promise<Client> {
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  const role = await client.query("SELECT current_user AS role");
  assert.equal(role.rows[0]?.role, runtimeRole);
  return client;
}

async function withTenantContext<T>(
  client: Client,
  fixture: TenantFixture,
  operation: () => Promise<T>
): Promise<T> {
  await client.query("BEGIN");
  try {
    await client.query(
      "SELECT set_config('app.organization_id', $1, true), " +
        "set_config('app.user_id', $2, true)",
      [fixture.organizationId, fixture.userId]
    );
    const result = await operation();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function assertMediaTablesPresent(adminPool: AdminPool): Promise<void> {
  const result = await adminPool.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables " +
      "WHERE table_schema = 'public' AND table_name = ANY($1::text[]) " +
      "ORDER BY table_name",
    [expectedTables]
  );
  const actual = result.rows.map((row) => row.table_name);
  assert.deepEqual(
    actual,
    expectedTables,
    `media schema missing tables: ${expectedTables.filter((name) => !actual.includes(name)).join(", ")}`
  );
}

async function main(): Promise<void> {
  const connectionString = requiredEnvironment(
    "POLARIS_MEDIA_GATE_DATABASE_URL"
  );
  const confirmation = requiredEnvironment(
    "POLARIS_MEDIA_GATE_CONFIRM_DISPOSABLE"
  );
  const expectedHostname = requiredEnvironment(
    "POLARIS_MEDIA_GATE_EXPECTED_HOSTNAME"
  );
  assert.equal(confirmation, "polaris-pr33-media-schema-gate");

  const connection = new URL(connectionString);
  const runtimeConnectionString = requiredEnvironment(
    "POLARIS_MEDIA_GATE_RUNTIME_DATABASE_URL"
  );
  const runtimeConnection = new URL(runtimeConnectionString);
  for (const candidate of [connection, runtimeConnection]) {
    assert.equal(candidate.protocol, "postgresql:");
    assert.equal(candidate.pathname, "/neondb");
    assert.equal(candidate.hostname, expectedHostname);
    assert.match(candidate.hostname, disposableHostPattern);
    assert.doesNotMatch(candidate.hostname, poolerPattern);
  }

  const { db, pool } = createDatabase(connectionString, { maxConnections: 8 });
  const runtimeClients: Client[] = [];
  try {
    const server = await pool.query<{
      server_version: string;
      server_version_num: number;
    }>(
      "SELECT current_setting('server_version') AS server_version, " +
        "current_setting('server_version_num')::integer AS server_version_num"
    );
    const [serverInfo] = server.rows;
    assert.ok(serverInfo);
    assert.equal(Math.floor(serverInfo.server_version_num / 10_000), 18);

    await assertMediaTablesPresent(pool);

    const security = await pool.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      "SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity " +
        "FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace " +
        "WHERE n.nspname = 'public' AND c.relname = ANY($1::text[]) " +
        "ORDER BY c.relname",
      [expectedTables]
    );
    assert.equal(security.rowCount, expectedTables.length);
    for (const row of security.rows) {
      assert.equal(row.relrowsecurity, true, `${row.relname} RLS enabled`);
      assert.equal(row.relforcerowsecurity, true, `${row.relname} RLS forced`);
    }

    const grants = await pool.query<{
      table_name: string;
      can_select: boolean;
      can_insert: boolean;
      can_update: boolean;
      can_delete: boolean;
    }>(
      "SELECT table_name, " +
        "has_table_privilege($1, format('public.%I', table_name), 'SELECT') AS can_select, " +
        "has_table_privilege($1, format('public.%I', table_name), 'INSERT') AS can_insert, " +
        "has_table_privilege($1, format('public.%I', table_name), 'UPDATE') AS can_update, " +
        "has_table_privilege($1, format('public.%I', table_name), 'DELETE') AS can_delete " +
        "FROM unnest($2::text[]) AS table_name ORDER BY table_name",
      [runtimeRole, expectedTables]
    );
    assert.equal(grants.rowCount, expectedTables.length);
    for (const grant of grants.rows) {
      assert.equal(grant.can_select, true, `${grant.table_name} SELECT grant`);
      assert.equal(
        grant.can_insert,
        false,
        `${grant.table_name} runtime INSERT`
      );
      assert.equal(
        grant.can_update,
        false,
        `${grant.table_name} runtime UPDATE`
      );
      assert.equal(
        grant.can_delete,
        false,
        `${grant.table_name} runtime DELETE`
      );
    }

    const tenantA = await createTenantFixture(pool, "tenant-a");
    const tenantB = await createTenantFixture(pool, "tenant-b");
    const productA = await createTestProduct(db, tenantA, "same-product");
    const productA2 = await createTestProduct(db, tenantA, "second-product");
    const productB = await createTestProduct(db, tenantB, "other-tenant");
    const variantB = await getDefaultVariantId(db, tenantB, productB);

    await withTenant(db, tenantA, "product:update", (transaction, identity) =>
      configureProductVariants(transaction, identity, {
        expectedVersion: 1,
        id: productA,
        options: [{ name: "color", values: ["red", "blue"] }],
        requestId: randomUUID(),
        variants: [{ values: { color: "red" } }, { values: { color: "blue" } }],
      })
    );
    const variantsA = await getConfiguredVariantIds(db, tenantA, productA);
    assert.equal(variantsA.length, 2);
    const [variantA1, variantA2] = variantsA;
    assert.ok(variantA1);
    assert.ok(variantA2);
    const variantA2Product = await getDefaultVariantId(db, tenantA, productA2);

    const assetA = randomUUID();
    const assetB = randomUUID();
    const assetC = randomUUID();
    const assetOrphan = randomUUID();
    await pool.query(
      "INSERT INTO public.media_assets (id, organization_id) VALUES " +
        "($1, $3), ($2, $3), ($4, $3), ($5, $6)",
      [
        assetA,
        assetB,
        tenantA.organizationId,
        assetOrphan,
        assetC,
        tenantB.organizationId,
      ]
    );
    await pool.query(
      "INSERT INTO public.product_media " +
        "(organization_id, product_id, media_asset_id, position) " +
        "VALUES ($1, $2, $3, 0), ($1, $2, $4, 1), ($5, $6, $7, 0)",
      [
        tenantA.organizationId,
        productA,
        assetA,
        assetB,
        tenantB.organizationId,
        productB,
        assetC,
      ]
    );

    await pool.query(
      "INSERT INTO public.variant_media " +
        "(organization_id, product_id, variant_id, media_asset_id, position) " +
        "VALUES ($1, $2, $3, $4, 0), ($1, $2, $5, $4, 0), " +
        "($1, $2, $5, $6, 1), ($7, $8, $9, $10, 0)",
      [
        tenantA.organizationId,
        productA,
        variantA1,
        assetA,
        variantA2,
        assetB,
        tenantB.organizationId,
        productB,
        variantB,
        assetC,
      ]
    );

    await expectSqlState(
      pool.query(
        "INSERT INTO public.product_media " +
          "(organization_id, product_id, media_asset_id, position) " +
          "VALUES ($1, $2, $3, 0)",
        [tenantA.organizationId, productA, assetOrphan]
      ),
      "23505",
      "product media position must be unique"
    );
    await expectSqlState(
      pool.query(
        "INSERT INTO public.product_media " +
          "(organization_id, product_id, media_asset_id, position) " +
          "VALUES ($1, $2, $3, -1)",
        [tenantA.organizationId, productA, assetOrphan]
      ),
      "23514",
      "product media position must be nonnegative"
    );
    await expectSqlState(
      pool.query(
        "INSERT INTO public.product_media " +
          "(organization_id, product_id, media_asset_id, position) " +
          "VALUES ($1, $2, $3, 2)",
        [tenantA.organizationId, productA2, assetA]
      ),
      "23505",
      "one asset cannot belong to two products in one organization"
    );
    await expectSqlState(
      pool.query(
        "INSERT INTO public.product_media " +
          "(organization_id, product_id, media_asset_id, position) " +
          "VALUES ($1, $2, $3, 1)",
        [tenantB.organizationId, productB, assetA]
      ),
      "23503",
      "asset and product must belong to the same organization"
    );
    await expectSqlState(
      pool.query(
        "INSERT INTO public.variant_media " +
          "(organization_id, product_id, variant_id, media_asset_id, position) " +
          "VALUES ($1, $2, $3, $4, 1)",
        [tenantA.organizationId, productA2, variantA2Product, assetA]
      ),
      "23503",
      "variant media must reference an asset linked to its product"
    );
    await expectSqlState(
      pool.query(
        "INSERT INTO public.variant_media " +
          "(organization_id, product_id, variant_id, media_asset_id, position) " +
          "VALUES ($1, $2, $3, $4, 0)",
        [tenantA.organizationId, productA, variantA1, assetB]
      ),
      "23505",
      "variant media position must be unique per variant"
    );
    await expectSqlState(
      pool.query(
        "DELETE FROM public.media_assets WHERE organization_id = $1 AND id = $2",
        [tenantA.organizationId, assetA]
      ),
      "23001",
      "linked assets cannot be hard-deleted"
    );

    const runtimeA = await createRuntimeClient(runtimeConnectionString);
    const runtimeB = await createRuntimeClient(runtimeConnectionString);
    runtimeClients.push(runtimeA, runtimeB);

    const unscopedAssets = await runtimeA.query(
      "SELECT id FROM public.media_assets"
    );
    const unscopedProductMedia = await runtimeA.query(
      "SELECT media_asset_id FROM public.product_media"
    );
    const unscopedVariantMedia = await runtimeA.query(
      "SELECT media_asset_id FROM public.variant_media"
    );
    assert.equal(unscopedAssets.rowCount, 0);
    assert.equal(unscopedProductMedia.rowCount, 0);
    assert.equal(unscopedVariantMedia.rowCount, 0);

    const visibleA = await withTenantContext(runtimeA, tenantA, () =>
      runtimeA.query<{ id: string }>(
        "SELECT id FROM public.media_assets ORDER BY id"
      )
    );
    assert.deepEqual(
      visibleA.rows.map((row) => row.id).sort(),
      [assetA, assetB, assetOrphan].sort()
    );
    const visibleProductMediaA = await withTenantContext(
      runtimeA,
      tenantA,
      () =>
        runtimeA.query<{ media_asset_id: string }>(
          "SELECT media_asset_id FROM public.product_media ORDER BY position"
        )
    );
    assert.deepEqual(
      visibleProductMediaA.rows.map((row) => row.media_asset_id),
      [assetA, assetB]
    );
    const visibleVariantMediaA = await withTenantContext(
      runtimeA,
      tenantA,
      () =>
        runtimeA.query<{ media_asset_id: string }>(
          "SELECT media_asset_id FROM public.variant_media WHERE product_id = $1 ORDER BY variant_id, position",
          [productA]
        )
    );
    assert.deepEqual(
      visibleVariantMediaA.rows.map((row) => row.media_asset_id),
      [assetA, assetA, assetB]
    );

    const visibleB = await withTenantContext(runtimeB, tenantB, () =>
      runtimeB.query<{ id: string }>(
        "SELECT id FROM public.media_assets ORDER BY id"
      )
    );
    assert.deepEqual(
      visibleB.rows.map((row) => row.id),
      [assetC]
    );
    const visibleProductMediaB = await withTenantContext(
      runtimeB,
      tenantB,
      () =>
        runtimeB.query<{ media_asset_id: string }>(
          "SELECT media_asset_id FROM public.product_media"
        )
    );
    assert.deepEqual(
      visibleProductMediaB.rows.map((row) => row.media_asset_id),
      [assetC]
    );
    const visibleVariantMediaB = await withTenantContext(
      runtimeB,
      tenantB,
      () =>
        runtimeB.query<{ media_asset_id: string }>(
          "SELECT media_asset_id FROM public.variant_media"
        )
    );
    assert.deepEqual(
      visibleVariantMediaB.rows.map((row) => row.media_asset_id),
      [assetC]
    );

    const beforeTombstone = await pool.query<{
      product_media: string;
      variant_media: string;
    }>(
      "SELECT " +
        "(SELECT count(*)::text FROM public.product_media WHERE organization_id = $1 AND product_id = $2) AS product_media, " +
        "(SELECT count(*)::text FROM public.variant_media WHERE organization_id = $1 AND product_id = $2) AS variant_media",
      [tenantA.organizationId, productA]
    );
    assert.equal(beforeTombstone.rows[0]?.product_media, "2");
    assert.equal(beforeTombstone.rows[0]?.variant_media, "3");

    await withTenant(db, tenantA, "product:update", (transaction, identity) =>
      deleteProduct(transaction, identity, {
        expectedVersion: 2,
        id: productA,
        requestId: randomUUID(),
      })
    );

    const afterTombstone = await pool.query<{
      product_media: string;
      variant_media: string;
    }>(
      "SELECT " +
        "(SELECT count(*)::text FROM public.product_media WHERE organization_id = $1 AND product_id = $2) AS product_media, " +
        "(SELECT count(*)::text FROM public.variant_media WHERE organization_id = $1 AND product_id = $2) AS variant_media",
      [tenantA.organizationId, productA]
    );
    assert.deepEqual(afterTombstone.rows[0], {
      product_media: "2",
      variant_media: "3",
    });
    const historicalVariantMedia = await withTenantContext(
      runtimeA,
      tenantA,
      () =>
        runtimeA.query<{ media_asset_id: string }>(
          "SELECT media_asset_id FROM public.variant_media WHERE product_id = $1 ORDER BY variant_id, position",
          [productA]
        )
    );
    assert.deepEqual(
      historicalVariantMedia.rows.map((row) => row.media_asset_id),
      [assetA, assetA, assetB]
    );
    await expectSqlState(
      pool.query(
        "INSERT INTO public.product_media " +
          "(organization_id, product_id, media_asset_id, position) " +
          "VALUES ($1, $2, $3, 2)",
        [tenantA.organizationId, productA, assetOrphan]
      ),
      "23514",
      "database blocks new product media links after tombstone"
    );
    await expectSqlState(
      pool.query(
        "UPDATE public.product_media SET position = 5 " +
          "WHERE organization_id = $1 AND product_id = $2 AND media_asset_id = $3",
        [tenantA.organizationId, productA, assetB]
      ),
      "23514",
      "database blocks reordering product media after tombstone"
    );
    await expectSqlState(
      pool.query(
        "DELETE FROM public.variant_media " +
          "WHERE organization_id = $1 AND product_id = $2 AND variant_id = $3 AND media_asset_id = $4",
        [tenantA.organizationId, productA, variantA1, assetA]
      ),
      "23514",
      "database preserves variant media links after tombstone"
    );

    const report = {
      branch: "pr33-media-schema-gate",
      database: "neondb",
      serverVersion: serverInfo.server_version,
      status: "passed",
      tests: [
        "media tables are protected by FORCE RLS and runtime grants are read-only",
        "asset can be reused across variants of its owning product without duplication",
        "product and variant media positions are nonnegative and unique per parent",
        "an asset cannot link to another product or organization",
        "variant media must reference the same product's media asset",
        "tenant-scoped reads hide assets and associations belonging to other organizations",
        "linked assets cannot be hard-deleted",
        "tombstone preserves readable media links and blocks direct SQL mutations",
      ],
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await Promise.all(runtimeClients.map((client) => client.end()));
    await pool.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown error";
  console.error("PR33 media gate failed:", message);
  process.exitCode = 1;
});
