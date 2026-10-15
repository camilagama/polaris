import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EntitlementLimitReachedError } from "@polaris/domain/billing/entitlements";
import {
  InvalidMediaOrderError,
  MediaUploadCommandConflictError,
} from "@polaris/domain/catalog/media";
import {
  ProductDeletedError,
  ProductNotFoundError,
} from "@polaris/domain/catalog/product";
import { Client } from "pg";
import { createDatabase } from "../src/client";
import {
  type CreateProductMediaAssetInput,
  createProductMediaAsset,
  getMediaAssetForDelivery,
  listProductMedia,
  removeProductMedia,
  reorderProductMedia,
} from "../src/media-repository";
import {
  configureProductVariants,
  createProduct,
  deleteProduct,
  getProductVariants,
} from "../src/product-repository";
import {
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
 * Removing and reordering the images of a product (plan: before Phase 7) on a
 * real PostgreSQL 18: the link goes and the asset stays, a removal frees the
 * place for the plan at once and is safe to repeat, the order is exactly the
 * current images, another organization or a deleted product cannot be touched,
 * and concurrent commands leave a consistent order.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

type ErrorClass = abstract new (...args: never[]) => Error;

async function expectRejects(
  operation: () => Promise<unknown>,
  expected: ErrorClass,
  label: string
) {
  await assert.rejects(
    operation,
    (error: unknown) => {
      assert.ok(error instanceof expected, `${label}: got ${String(error)}`);
      return true;
    },
    label
  );
}

function mediaInput(
  organizationId: string,
  productId: string,
  variantIds: string[] = [],
  uploadCommandId: string = randomUUID()
): CreateProductMediaAssetInput {
  const fingerprint = createHash("sha256").update(randomUUID()).digest("hex");
  return {
    byteSize: 2048,
    height: 480,
    inputFingerprint: fingerprint,
    productId,
    requestId: randomUUID(),
    // The v2 key the database requires: the asset's own organization, command and fingerprint.
    storageKey: `media/v2/${organizationId}/${productId}/${uploadCommandId}/${fingerprint}/${randomUUID()}.webp`,
    uploadCommandId,
    variantIds,
    width: 640,
  };
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
  let cleanupLoginRole: string | undefined;
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

    loginRole = `polaris_media_commands_gate_${randomUUID().replaceAll("-", "")}`;
    const loginPassword = randomBytes(24).toString("hex");
    await admin.pool.query(
      `CREATE ROLE "${loginRole}" WITH LOGIN INHERIT PASSWORD '${loginPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
    );
    await admin.pool.query(`GRANT "${runtimeRole}" TO "${loginRole}"`);
    const runtimeUrl = temporaryRuntimeUrl(adminUrl, loginRole, loginPassword);
    const runtimeDatabase = createDatabase(runtimeUrl, { maxConnections: 10 });
    runtime = runtimeDatabase;
    const { db } = runtimeDatabase;
    const as = <T>(
      tenant: TenantFixture,
      operation: Parameters<typeof withTenantAs<T>>[3]
    ) => withTenantAs(db, tenant, "product:update", operation);

    const tenantA = await createTenantFixture(admin.pool, "media commands A");
    const tenantB = await createTenantFixture(admin.pool, "media commands B");
    const newProduct = (tenant: TenantFixture) =>
      as(tenant, (tx, identity) =>
        createProduct(tx, identity, { name: `P ${randomUUID()}` })
      );
    const upload = (
      tenant: TenantFixture,
      productId: string,
      variantIds: string[] = []
    ) =>
      as(tenant, (tx, identity) =>
        createProductMediaAsset(
          tx,
          identity,
          mediaInput(tenant.organizationId, productId, variantIds)
        )
      );
    const list = (tenant: TenantFixture, productId: string) =>
      as(tenant, (tx) =>
        listProductMedia(tx, tenant.organizationId, productId)
      );
    const remove = (
      tenant: TenantFixture,
      productId: string,
      assetId: string
    ) =>
      as(tenant, (tx, identity) =>
        removeProductMedia(tx, identity, {
          assetId,
          productId,
          requestId: randomUUID(),
        })
      );
    const reorder = (
      tenant: TenantFixture,
      productId: string,
      assetIds: string[]
    ) =>
      as(tenant, (tx, identity) =>
        reorderProductMedia(tx, identity, {
          assetIds,
          productId,
          requestId: randomUUID(),
        })
      );
    const auditCount = async (tenant: TenantFixture, eventType: string) =>
      Number(
        (
          await admin.pool.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM public.tenant_audit_event WHERE organization_id = $1 AND event_type = $2",
            [tenant.organizationId, eventType]
          )
        ).rows[0]?.count
      );

    // -------------------------------------------- 1. removing an image
    const product = await newProduct(tenantA);
    // a product with two variants, so an image can be linked to one of them
    const configured = await as(tenantA, (tx, identity) =>
      configureProductVariants(tx, identity, {
        expectedVersion: product.version,
        id: product.id,
        options: [{ name: "color", values: ["Azul", "Preto"] }],
        requestId: randomUUID(),
        variants: [
          { values: { color: "Azul" } },
          { values: { color: "Preto" } },
        ],
      })
    );
    const variantId = configured.configuration.variants[0]?.id as string;
    assert.ok(variantId);
    const first = await upload(tenantA, product.id);
    const second = await upload(tenantA, product.id, [variantId]);
    const third = await upload(tenantA, product.id);
    assert.deepEqual(
      (await list(tenantA, product.id)).map((asset) => asset.position),
      [0, 1, 2]
    );

    const removal = await remove(tenantA, product.id, second.asset.assetId);
    assert.equal(removal.removed, true);
    const afterRemoval = await list(tenantA, product.id);
    assert.deepEqual(
      afterRemoval.map((asset) => asset.assetId),
      [first.asset.assetId, third.asset.assetId]
    );
    const links = await admin.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM public.variant_media WHERE organization_id = $1 AND media_asset_id = $2",
      [tenantA.organizationId, second.asset.assetId]
    );
    assert.equal(Number(links.rows[0]?.count), 0, "the variant link went too");
    const keptAsset = await admin.pool.query<{ storage_key: string }>(
      "SELECT storage_key FROM public.media_assets WHERE id = $1",
      [second.asset.assetId]
    );
    assert.equal(keptAsset.rows.length, 1, "the asset row stays");
    assert.equal(
      await as(tenantA, (tx) =>
        getMediaAssetForDelivery(
          tx,
          tenantA.organizationId,
          second.asset.assetId
        )
      ),
      null,
      "a removed image is no longer served"
    );
    const otherProduct = await newProduct(tenantA);
    const wrongProduct = await remove(
      tenantA,
      otherProduct.id,
      first.asset.assetId
    );
    assert.equal(
      wrongProduct.removed,
      false,
      "an image is only removed through its own product"
    );
    assert.equal((await list(tenantA, product.id)).length, 2);
    const again = await remove(tenantA, product.id, second.asset.assetId);
    assert.equal(again.removed, false, "removing it again changes nothing");
    assert.equal(await auditCount(tenantA, "product.media_removed"), 1);
    tests.push(
      "removing an image drops its product and variant links and keeps the asset, stops serving it, is safe to repeat and leaves one audit event"
    );

    // ----------------------------------------------- 2. the order
    const fourth = await upload(tenantA, product.id);
    // positions have a gap now (0, 2, 3): the order is still exactly the current images
    const desired = [
      fourth.asset.assetId,
      first.asset.assetId,
      third.asset.assetId,
    ];
    const reordered = await reorder(tenantA, product.id, desired);
    assert.deepEqual(
      reordered.map((asset) => asset.assetId),
      desired
    );
    assert.deepEqual(
      reordered.map((asset) => asset.position),
      [0, 1, 2],
      "the positions are tidy after a reorder"
    );
    assert.equal(await auditCount(tenantA, "product.media_reordered"), 1);
    await reorder(tenantA, product.id, desired);
    assert.equal(
      await auditCount(tenantA, "product.media_reordered"),
      1,
      "the same order again is not a change"
    );
    await Promise.all(
      [
        desired.slice(0, 2),
        [...desired, second.asset.assetId],
        [desired[0] as string, desired[0] as string, desired[1] as string],
        [],
      ].map((bad) =>
        expectRejects(
          () => reorder(tenantA, product.id, bad),
          InvalidMediaOrderError,
          "an order that is not exactly the current images"
        )
      )
    );
    assert.deepEqual(
      (await list(tenantA, product.id)).map((asset) => asset.assetId),
      desired,
      "a refused order changed nothing"
    );
    const next = await upload(tenantA, product.id);
    assert.equal(next.asset.position, 3, "a new image goes last");
    tests.push(
      "the order is exactly the current images (a stale or repeated list is refused), positions are tidy afterwards, the same order is not a change and a new image goes last"
    );

    // an image linked to a variant keeps its link through a reorder
    const linked = await upload(tenantA, product.id, [variantId]);
    const withLinked = (await list(tenantA, product.id))
      .map((asset) => asset.assetId)
      .reverse();
    const afterLinked = await reorder(tenantA, product.id, withLinked);
    assert.deepEqual(
      afterLinked.find((asset) => asset.assetId === linked.asset.assetId)
        ?.variantIds,
      [variantId],
      "the variant link survives a reorder"
    );
    // the same order with gaps in the positions is still tidied
    await remove(tenantA, product.id, linked.asset.assetId);
    const tidied = await reorder(
      tenantA,
      product.id,
      (await list(tenantA, product.id)).map((asset) => asset.assetId)
    );
    assert.deepEqual(
      tidied.map((asset) => asset.position),
      tidied.map((_, index) => index),
      "an unchanged order with gaps is tidied"
    );

    // ----------------------------------- 3. the plan sees the freed place
    const free = await createTenantFixture(
      admin.pool,
      "media commands free",
      "America/Sao_Paulo",
      "free"
    );
    const freeProduct = await newProduct(free);
    const only = await upload(free, freeProduct.id);
    await assert.rejects(
      () => upload(free, freeProduct.id),
      (error: unknown) =>
        error instanceof EntitlementLimitReachedError &&
        error.key === "images.per_product.max"
    );
    await remove(free, freeProduct.id, only.asset.assetId);
    const replacement = await upload(free, freeProduct.id);
    assert.equal(replacement.replayed, false);
    assert.deepEqual(
      (await list(free, freeProduct.id)).map((asset) => asset.assetId),
      [replacement.asset.assetId]
    );
    tests.push(
      "a Free product at its one image can remove it and upload another at once"
    );

    // ---------------------------------------------- 4. isolation
    await expectRejects(
      () => remove(tenantB, product.id, first.asset.assetId),
      ProductNotFoundError,
      "another organization cannot remove an image of this product"
    );
    await expectRejects(
      () => reorder(tenantB, product.id, desired),
      ProductNotFoundError,
      "another organization cannot reorder this product"
    );
    assert.equal(
      (await list(tenantA, product.id)).length,
      4,
      "nothing was touched"
    );
    tests.push(
      "another organization can neither remove nor reorder the images of a product it does not own"
    );

    // ------------------------------------------ 5. a deleted product
    const doomed = await newProduct(tenantA);
    const doomedImage = await upload(tenantA, doomed.id);
    await as(tenantA, (tx, identity) =>
      deleteProduct(tx, identity, {
        expectedVersion: doomed.version,
        id: doomed.id,
        requestId: randomUUID(),
      })
    );
    await expectRejects(
      () => remove(tenantA, doomed.id, doomedImage.asset.assetId),
      ProductDeletedError,
      "a deleted product keeps its images"
    );
    await expectRejects(
      () => reorder(tenantA, doomed.id, [doomedImage.asset.assetId]),
      ProductDeletedError,
      "a deleted product keeps its order"
    );
    const stillLinked = await withRuntimeSqlContext(
      runtimeUrl,
      tenantA,
      async (client) => {
        const result = await client.query(
          "DELETE FROM public.product_media WHERE product_id = $1",
          [doomed.id]
        );
        return result.rowCount;
      }
    );
    assert.equal(stillLinked, 0, "the database refuses the removal too");
    tests.push(
      "the images of a deleted product cannot be removed or reordered, by command or by plain SQL"
    );

    // the tombstone trigger refuses even a connection that bypasses row security
    await expectSqlState(
      () =>
        admin.pool.query(
          "DELETE FROM public.product_media WHERE product_id = $1",
          [doomed.id]
        ),
      "23514",
      "the tombstone guard refuses removal on a deleted product",
      "media_product_tombstone_guard"
    );
    await expectSqlState(
      () =>
        admin.pool.query(
          "UPDATE public.product_media SET position = position + 1 WHERE product_id = $1",
          [doomed.id]
        ),
      "23514",
      "the tombstone guard refuses a reorder on a deleted product",
      "media_product_tombstone_guard"
    );
    // plain SQL from another organization sees and changes nothing
    const crossTenant = await withRuntimeSqlContext(
      runtimeUrl,
      tenantB,
      async (client) => {
        const removed = await client.query(
          "DELETE FROM public.product_media WHERE product_id = $1",
          [product.id]
        );
        const moved = await client.query(
          "UPDATE public.product_media SET position = position + 1 WHERE product_id = $1",
          [product.id]
        );
        const variantLinks = await client.query(
          "DELETE FROM public.variant_media WHERE product_id = $1",
          [product.id]
        );
        return [removed.rowCount, moved.rowCount, variantLinks.rowCount];
      }
    );
    assert.deepEqual(crossTenant, [0, 0, 0]);
    // a replayed upload command of a removed image is a conflict, never a second image
    const removedCommand = (
      await admin.pool.query<{ upload_command_id: string }>(
        "SELECT upload_command_id FROM public.media_assets WHERE id = $1",
        [second.asset.assetId]
      )
    ).rows[0]?.upload_command_id as string;
    await expectRejects(
      () =>
        as(tenantA, (tx, identity) =>
          createProductMediaAsset(
            tx,
            identity,
            mediaInput(tenantA.organizationId, product.id, [], removedCommand)
          )
        ),
      MediaUploadCommandConflictError,
      "the upload command of a removed image cannot be replayed"
    );

    // ---------------------------------- 6. what the runtime still cannot do
    await expectSqlState(
      () =>
        withRuntimeSqlContext(runtimeUrl, tenantA, (client) =>
          client.query("DELETE FROM public.media_assets")
        ),
      "42501",
      "an asset itself cannot be deleted"
    );
    await expectSqlState(
      () =>
        withRuntimeSqlContext(runtimeUrl, tenantA, (client) =>
          client.query(
            "UPDATE public.product_media SET created_at = now() WHERE product_id = $1",
            [product.id]
          )
        ),
      "42501",
      "only the position of a link can change"
    );
    await expectSqlState(
      () =>
        withRuntimeSqlContext(runtimeUrl, tenantA, (client) =>
          client.query(
            "UPDATE public.product_media SET media_asset_id = media_asset_id WHERE product_id = $1",
            [product.id]
          )
        ),
      "42501",
      "a link cannot be moved to another asset"
    );
    tests.push(
      "the runtime still cannot delete an asset or change anything of a link but its position"
    );

    // ----------------------------------------------- 7. concurrency
    const racingProduct = await newProduct(tenantA);
    const racingImages = await Promise.all(
      Array.from({ length: 4 }, () => upload(tenantA, racingProduct.id))
    );
    const ids = racingImages.map((image) => image.asset.assetId);
    const removals = await Promise.all(
      Array.from({ length: 6 }, () =>
        remove(tenantA, racingProduct.id, ids[0] as string)
      )
    );
    assert.equal(
      removals.filter((result) => result.removed).length,
      1,
      "exactly one of six concurrent removals removed it"
    );
    const remaining = (await list(tenantA, racingProduct.id)).map(
      (asset) => asset.assetId
    );
    assert.equal(remaining.length, 3);
    const orderA = [...remaining].reverse();
    const orderB = [...remaining].sort();
    const raced = await Promise.all([
      reorder(tenantA, racingProduct.id, orderA),
      reorder(tenantA, racingProduct.id, orderB),
    ]);
    assert.equal(raced.length, 2);
    const final = await list(tenantA, racingProduct.id);
    assert.deepEqual(
      final.map((asset) => asset.position),
      [0, 1, 2],
      "two concurrent reorders leave tidy positions"
    );
    const finalIds = final.map((asset) => asset.assetId);
    assert.ok(
      JSON.stringify(finalIds) === JSON.stringify(orderA) ||
        JSON.stringify(finalIds) === JSON.stringify(orderB),
      "and one of the two orders, whole"
    );
    // the variants of the product are untouched by all of this
    assert.ok(
      (
        await as(tenantA, (tx, identity) =>
          getProductVariants(tx, identity, product.id)
        )
      ).configured
    );
    tests.push(
      "of six concurrent removals exactly one removes, and two concurrent reorders leave tidy positions in one of the two orders"
    );

    // ------------------- 8. reclaiming the objects of removed images
    cleanupLoginRole = `polaris_media_cleanup_gate_${randomUUID().replaceAll("-", "")}`;
    const cleanupPassword = randomBytes(24).toString("hex");
    await admin.pool.query(
      `CREATE ROLE "${cleanupLoginRole}" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${cleanupPassword}'`
    );
    await admin.pool.query(
      `GRANT polaris_media_cleanup_runtime TO "${cleanupLoginRole}"`
    );
    const cleanupUrl = temporaryRuntimeUrl(
      adminUrl,
      cleanupLoginRole,
      cleanupPassword
    );
    const asCleanup = async <T>(
      operation: (client: Client) => Promise<T>
    ): Promise<T> => {
      const client = new Client({
        connectionString: cleanupUrl,
        connectionTimeoutMillis: 5000,
      });
      await client.connect();
      try {
        return await operation(client);
      } finally {
        await client.end();
      }
    };
    const unlinked = (minAge: string) =>
      asCleanup(async (client) => {
        const result = await client.query<{
          asset_id: string;
          storage_key: string;
        }>(
          "SELECT asset_id, storage_key FROM public.list_unlinked_media_for_cleanup(500, $1::interval, ARRAY[]::uuid[])",
          [minAge]
        );
        return result.rows;
      });
    const finalize = (assetId: string) =>
      asCleanup(async (client) => {
        const result = await client.query<{ finalized: boolean }>(
          "SELECT public.finalize_unlinked_media_cleanup($1::uuid) AS finalized",
          [assetId]
        );
        return result.rows[0]?.finalized;
      });

    const removedId = second.asset.assetId;
    const removedKeyRow = await admin.pool.query<{ storage_key: string }>(
      "SELECT storage_key FROM public.media_assets WHERE id = $1",
      [removedId]
    );
    const removedStorageKey = removedKeyRow.rows[0]?.storage_key as string;
    const listed = await unlinked("0 seconds");
    assert.ok(
      listed.some((row) => row.asset_id === removedId),
      "a removed image is listed for cleanup"
    );
    const linkedNow = new Set(
      (
        await admin.pool.query<{ media_asset_id: string }>(
          "SELECT media_asset_id FROM public.product_media"
        )
      ).rows.map((row) => row.media_asset_id)
    );
    assert.ok(
      listed.every((row) => !linkedNow.has(row.asset_id)),
      "an image that is still linked is never listed (a deleted product keeps its images)"
    );
    assert.equal(
      (await unlinked("1 hour")).some((row) => row.asset_id === removedId),
      false,
      "a young asset waits out the retention"
    );

    assert.equal(
      await finalize(first.asset.assetId),
      false,
      "an image that is still linked is not finalized"
    );
    assert.equal(
      await finalize(removedId),
      true,
      "a removed image is finalized"
    );
    const afterFinalize = await admin.pool.query<{
      assets: string;
      claims: string;
    }>(
      `SELECT (SELECT count(*) FROM public.media_assets WHERE id = $1)::text AS assets,
              (SELECT count(*) FROM public.media_cleanup_claims WHERE storage_key = $2)::text AS claims`,
      [removedId, removedStorageKey]
    );
    assert.deepEqual(
      [afterFinalize.rows[0]?.assets, afterFinalize.rows[0]?.claims],
      ["0", "1"],
      "the asset row is gone and its key is tombstoned"
    );
    assert.equal(
      await finalize(removedId),
      false,
      "finalizing twice changes nothing"
    );
    await expectSqlState(
      () =>
        admin.pool.query(
          `INSERT INTO public.media_assets (byte_size, content_type, height, input_fingerprint, organization_id, storage_key, upload_command_id, width)
           VALUES (1, 'image/webp', 1, $1, $2, $3, $4, 1)`,
          [
            "a".repeat(64),
            tenantA.organizationId,
            removedStorageKey,
            randomUUID(),
          ]
        ),
      "23514",
      "a reclaimed key can never be reused by a new asset",
      "media_assets_storage_key_cleanup_claimed"
    );
    // an asset listed as failed in this run is left out of the next listing
    const stillUnlinked = await unlinked("0 seconds");
    const [firstUnlinked] = stillUnlinked;
    if (firstUnlinked) {
      const without = await asCleanup(async (client) => {
        const result = await client.query<{ asset_id: string }>(
          "SELECT asset_id FROM public.list_unlinked_media_for_cleanup(500, interval '0 seconds', $1::uuid[])",
          [[firstUnlinked.asset_id]]
        );
        return result.rows.map((row) => row.asset_id);
      });
      assert.equal(without.includes(firstUnlinked.asset_id), false);
      assert.equal(without.length, stillUnlinked.length - 1);
    }
    // the invariant the cleanup relies on: a link only for an asset created in the same
    // transaction. A removed (unlinked) asset cannot be linked again, by any role.
    const [removedUnlinked] = (await unlinked("0 seconds")).filter(
      (row) => row.asset_id === ids[0]
    );
    assert.ok(removedUnlinked, "the race gate left an unlinked asset to try");
    const relinkSql =
      "INSERT INTO public.product_media (organization_id, product_id, media_asset_id, position) VALUES ($1, $2, $3, 99)";
    const relinkParams = [tenantA.organizationId, racingProduct.id, ids[0]];
    await expectSqlState(
      () =>
        withRuntimeSqlContext(runtimeUrl, tenantA, (client) =>
          client.query(relinkSql, relinkParams)
        ),
      "23514",
      "an existing asset cannot be linked again (tenant role)",
      "product_media_new_asset_only"
    );
    await expectSqlState(
      () => admin.pool.query(relinkSql, relinkParams),
      "23514",
      "an existing asset cannot be linked again (even bypassing row security)",
      "product_media_new_asset_only"
    );

    // what the cleanup role and the tenant role may not do
    await Promise.all([
      ...[
        "SELECT 1 FROM public.media_assets",
        "SELECT 1 FROM public.product_media",
        "DELETE FROM public.media_assets",
        "SELECT 1 FROM public.media_cleanup_claims",
      ].map((statement) =>
        expectSqlState(
          () => asCleanup((client) => client.query(statement)),
          "42501",
          `the cleanup login cannot reach the tables directly: ${statement}`
        )
      ),
      ...[
        "SELECT * FROM public.list_unlinked_media_for_cleanup(10, interval '0 seconds', ARRAY[]::uuid[])",
        `SELECT public.finalize_unlinked_media_cleanup('${randomUUID()}'::uuid)`,
      ].map((statement) =>
        expectSqlState(
          () =>
            withRuntimeSqlContext(runtimeUrl, tenantA, (client) =>
              client.query(statement)
            ),
          "42501",
          `the tenant role cannot run the cleanup functions: ${statement.slice(0, 50)}`
        )
      ),
      ...(
        [
          [0, "0 seconds"],
          [501, "0 seconds"],
          [10, "-1 hour"],
        ] as const
      ).map(([limit, age]) =>
        expectSqlState(
          () =>
            asCleanup((client) =>
              client.query(
                "SELECT * FROM public.list_unlinked_media_for_cleanup($1, $2::interval, ARRAY[]::uuid[])",
                [limit, age]
              )
            ),
          "22023",
          `invalid cleanup arguments: ${limit} ${age}`
        )
      ),
    ]);
    tests.push(
      "the cleanup role lists the images nothing links to (never a linked one, never before the retention) and finalizes only those: the asset row goes, its key is tombstoned and can never be reused, finalizing twice changes nothing, and neither the cleanup login nor the tenant role can reach the tables or the other's functions"
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
    if (cleanupLoginRole) {
      await admin.pool.query(
        `REVOKE polaris_media_cleanup_runtime FROM "${cleanupLoginRole}"`
      );
      await admin.pool.query(`DROP ROLE IF EXISTS "${cleanupLoginRole}"`);
    }
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
    `Media commands PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
