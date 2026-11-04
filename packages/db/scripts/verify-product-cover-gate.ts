import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { readBootstrapPage } from "../src/bootstrap-repository";
import { createDatabase } from "../src/client";
import {
  type CreateProductMediaAssetInput,
  createProductMediaAsset,
  removeProductMedia,
  reorderProductMedia,
} from "../src/media-repository";
import {
  createProduct,
  listProducts,
  productListQuery,
  updateProduct,
} from "../src/product-repository";
import { pullSyncChanges } from "../src/sync-repository";
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
  withRuntimeSqlContext,
  withTenantAs,
} from "./sales-gate-support";

/**
 * The cover of a product (`coverAssetId`, the image of lowest position) on a real PostgreSQL 18: what the list, the
 * bootstrap and the re-reading by ids of the pull carry with 0, 1 and 3 images, after a reorder and after a removal;
 * one `product` change in the sync log per upload, reorder and removal, with `products.version` untouched, so an
 * offline edit made before still applies; a cover never of another organization; the trigger function's owner; and
 * the plan of the list of 1,248 products, which reads the cover through the index `(organization_id, product_id,
 * position)`.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";
const SYNC_OWNER = "polaris_sync_owner";
const LIST_SIZE = 1248;
const COVER_INDEX = "product_media_product_position_unique";
const rolledBackSavepoint = /roll back the savepoint/;
const seqScanOfMedia = /Seq Scan on product_media/;
const coverIndexScan = new RegExp(
  `Index (Only )?Scan using ${COVER_INDEX} on product_media`
);

function mediaInput(
  organizationId: string,
  productId: string
): CreateProductMediaAssetInput {
  const uploadCommandId = randomUUID();
  const fingerprint = createHash("sha256").update(randomUUID()).digest("hex");
  return {
    byteSize: 2048,
    height: 480,
    inputFingerprint: fingerprint,
    productId,
    requestId: randomUUID(),
    storageKey: `media/v2/${organizationId}/${productId}/${uploadCommandId}/${fingerprint}/${randomUUID()}.webp`,
    uploadCommandId,
    variantIds: [],
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
  const tests: string[] = [];

  try {
    const server = await admin.pool.query<{
      database_name: string;
      server_version_num: string;
    }>(
      "SELECT current_database() AS database_name, current_setting('server_version_num') AS server_version_num"
    );
    assert.equal(server.rows[0]?.database_name, expectedDatabase);
    assert.ok(Number(server.rows[0]?.server_version_num) >= 180_000);
    const migrations = await admin.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations"
    );
    assert.equal(Number(migrations.rows[0]?.count), journalMigrationCount());
    const migrator = (
      await admin.pool.query<{ owner: string }>(
        "SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = current_database()"
      )
    ).rows[0]?.owner;
    assert.ok(migrator);
    tests.push(
      "disposable direct connection is PostgreSQL 18 with every migration replayed from scratch"
    );

    // ------------------------------------------- 1. the trigger and its function
    const fn = await admin.pool.query<{
      config: string[];
      executors: string[];
      owner: string;
      public_exec: boolean;
      secdef: boolean;
    }>(
      `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS secdef, p.proconfig AS config,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
              ARRAY(SELECT pg_get_userbyid(x.grantee)::text FROM aclexplode(p.proacl) x
                     WHERE x.privilege_type = 'EXECUTE' ORDER BY 1) AS executors
         FROM pg_proc p WHERE p.oid = 'public.record_product_media_sync_change()'::regprocedure`
    );
    assert.deepEqual(fn.rows, [
      {
        config: ["search_path=pg_catalog, public, pg_temp"],
        executors: [migrator, SYNC_OWNER].sort(),
        owner: SYNC_OWNER,
        public_exec: false,
        secdef: true,
      },
    ]);
    const triggers = await admin.pool.query<{ definition: string }>(
      `SELECT pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t
        WHERE t.tgrelid = 'public.product_media'::regclass AND t.tgname LIKE 'sync\\_%'
        ORDER BY t.tgname`
    );
    assert.deepEqual(
      triggers.rows.map((row) => row.definition),
      [
        "CREATE TRIGGER sync_record_product_media_delete AFTER DELETE ON public.product_media REFERENCING OLD TABLE AS deleted_media FOR EACH STATEMENT EXECUTE FUNCTION record_product_media_sync_change()",
        "CREATE TRIGGER sync_record_product_media_insert AFTER INSERT ON public.product_media REFERENCING NEW TABLE AS inserted_media FOR EACH STATEMENT EXECUTE FUNCTION record_product_media_sync_change()",
        "CREATE TRIGGER sync_record_product_media_update AFTER UPDATE ON public.product_media REFERENCING OLD TABLE AS unmoved_media NEW TABLE AS moved_media FOR EACH STATEMENT EXECUTE FUNCTION record_product_media_sync_change()",
      ]
    );
    tests.push(
      `record_product_media_sync_change belongs to ${SYNC_OWNER}, is SECURITY DEFINER with a pinned search_path, EXECUTE only for its owner and the migrator; product_media fires it once per INSERT, UPDATE and DELETE statement, with the transition tables`
    );

    // ------------------------------------------------------------ fixtures
    loginRole = `polaris_cover_gate_${randomUUID().replaceAll("-", "")}`;
    const loginPassword = randomBytes(24).toString("hex");
    await admin.pool.query(
      `CREATE ROLE "${loginRole}" WITH LOGIN INHERIT PASSWORD '${loginPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
    );
    await admin.pool.query(`GRANT "${runtimeRole}" TO "${loginRole}"`);
    const runtimeUrl = temporaryRuntimeUrl(adminUrl, loginRole, loginPassword);
    const runtimeDatabase = createDatabase(runtimeUrl, { maxConnections: 4 });
    runtime = runtimeDatabase;
    const { db } = runtimeDatabase;
    const as = <T>(
      tenant: TenantFixture,
      operation: Parameters<typeof withTenantAs<T>>[3]
    ) => withTenantAs(db, tenant, "product:update", operation);

    const tenantA = await createTenantFixture(admin.pool, "cover A");
    const tenantB = await createTenantFixture(admin.pool, "cover B");
    const newProduct = (tenant: TenantFixture, label: string) =>
      as(tenant, (tx, identity) =>
        createProduct(tx, identity, {
          name: `Capa ${label} ${randomUUID()}`,
          requestId: randomUUID(),
        })
      );
    const upload = async (tenant: TenantFixture, productId: string) =>
      (
        await as(tenant, (tx, identity) =>
          createProductMediaAsset(
            tx,
            identity,
            mediaInput(tenant.organizationId, productId)
          )
        )
      ).asset.assetId;
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
    const listCovers = async (tenant: TenantFixture) =>
      new Map(
        (
          await as(tenant, (tx, identity) =>
            listProducts(tx, identity, { status: "all" })
          )
        ).map((row) => [row.id, row.coverAssetId])
      );
    const bootstrapCovers = async (tenant: TenantFixture, ids?: string[]) => {
      const page = await as(tenant, (tx, identity) =>
        readBootstrapPage(tx, identity, {
          collection: "products",
          limit: 500,
          ...(ids ? { ids } : {}),
        })
      );
      assert.equal(page.collection, "products");
      return new Map(
        page.rows.map((row) => {
          assert.ok("coverAssetId" in row);
          return [row.id, row.coverAssetId];
        })
      );
    };
    // the three reads agree: the list, the bootstrap page and the re-reading by ids of a pull
    const coverOf = async (tenant: TenantFixture, productId: string) => {
      const listed = (await listCovers(tenant)).get(productId);
      const booted = (await bootstrapCovers(tenant)).get(productId);
      const reread = (await bootstrapCovers(tenant, [productId])).get(
        productId
      );
      assert.equal(booted, listed, "the bootstrap and the list agree");
      assert.equal(reread, listed, "the re-reading by ids and the list agree");
      assert.notEqual(listed, undefined, "the product is read");
      return listed;
    };
    const productChanges = async (tenant: TenantFixture, productId: string) =>
      Number(
        (
          await admin.pool.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM public.sync_changes WHERE organization_id = $1 AND entity_type = 'product' AND entity_id = $2",
            [tenant.organizationId, productId]
          )
        ).rows[0]?.count
      );
    const versionOf = async (productId: string) =>
      Number(
        (
          await admin.pool.query<{ version: number }>(
            "SELECT version FROM public.products WHERE id = $1",
            [productId]
          )
        ).rows[0]?.version
      );
    // one operation: exactly one new `product` change of that product, and the product's version untouched
    const oneChange = async <T>(
      tenant: TenantFixture,
      productId: string,
      label: string,
      operation: () => Promise<T>
    ): Promise<T> => {
      const changes = await productChanges(tenant, productId);
      const version = await versionOf(productId);
      const result = await operation();
      assert.equal(
        await productChanges(tenant, productId),
        changes + 1,
        `${label}: exactly one product change`
      );
      assert.equal(
        await versionOf(productId),
        version,
        `${label}: the product's version does not move`
      );
      return result;
    };

    // ----------------------------------------- 2. the cover with 0, 1 and 3 images
    const none = await newProduct(tenantA, "sem imagem");
    const single = await newProduct(tenantA, "uma imagem");
    const triple = await newProduct(tenantA, "tres imagens");
    assert.equal(await coverOf(tenantA, none.id), null, "no image, no cover");
    assert.equal(await coverOf(tenantA, single.id), null);
    const only = await oneChange(tenantA, single.id, "upload", () =>
      upload(tenantA, single.id)
    );
    assert.equal(await coverOf(tenantA, single.id), only);
    const first = await oneChange(tenantA, triple.id, "upload", () =>
      upload(tenantA, triple.id)
    );
    const second = await oneChange(tenantA, triple.id, "upload", () =>
      upload(tenantA, triple.id)
    );
    const third = await oneChange(tenantA, triple.id, "upload", () =>
      upload(tenantA, triple.id)
    );
    assert.equal(
      await coverOf(tenantA, triple.id),
      first,
      "the first image sent is the cover"
    );
    assert.equal(await coverOf(tenantA, none.id), null);
    tests.push(
      "the list, the bootstrap page and the re-reading by ids carry the same coverAssetId: null with no image, the only image with one, the image of position 0 with three; each upload leaves exactly one product change and the version untouched"
    );

    // ------------------------------------------ 3. reorder and removal move the cover
    await oneChange(tenantA, triple.id, "reorder", () =>
      reorder(tenantA, triple.id, [third, first, second])
    );
    assert.equal(
      await coverOf(tenantA, triple.id),
      third,
      "the image moved to the front is the cover"
    );
    // a reorder that leaves the cover in place still tells the device once
    await oneChange(tenantA, triple.id, "reorder behind the cover", () =>
      reorder(tenantA, triple.id, [third, second, first])
    );
    assert.equal(await coverOf(tenantA, triple.id), third);
    await oneChange(tenantA, triple.id, "remove the cover", () =>
      remove(tenantA, triple.id, third)
    );
    assert.equal(
      await coverOf(tenantA, triple.id),
      second,
      "removing the cover promotes the next one, even with a gap in the positions"
    );
    await oneChange(tenantA, triple.id, "remove another", () =>
      remove(tenantA, triple.id, first)
    );
    assert.equal(await coverOf(tenantA, triple.id), second);
    await oneChange(tenantA, single.id, "remove the last", () =>
      remove(tenantA, single.id, only)
    );
    assert.equal(
      await coverOf(tenantA, single.id),
      null,
      "removing the last image leaves no cover"
    );
    const repeated = await productChanges(tenantA, single.id);
    assert.equal((await remove(tenantA, single.id, only)).removed, false);
    assert.equal(
      await productChanges(tenantA, single.id),
      repeated,
      "a removal that removes nothing writes no change"
    );
    tests.push(
      "a reorder (two UPDATEs over every image) and a removal (variant links, then the product link) each leave exactly one product change and the version untouched; the image moved to the front becomes the cover, removing the cover promotes the next, removing the last gives null, and a removal of nothing writes nothing"
    );

    // ----------------------------- 4. a SAVEPOINT rolled back does not hide the change
    const rolled = await productChanges(tenantA, triple.id);
    await as(tenantA, async (tx, identity) => {
      await tx
        .transaction(async (savepoint) => {
          await reorderProductMedia(savepoint, identity, {
            assetIds: [second],
            productId: triple.id,
            requestId: randomUUID(),
          });
          await savepoint.execute(sql`SELECT 1`);
          throw new Error("roll back the savepoint");
        })
        .catch((error: unknown) => {
          assert.match(String(error), rolledBackSavepoint);
        });
      await removeProductMedia(tx, identity, {
        assetId: second,
        productId: triple.id,
        requestId: randomUUID(),
      });
    });
    assert.equal(
      await productChanges(tenantA, triple.id),
      rolled + 1,
      "the change of a rolled back savepoint is gone, and the next write records its own"
    );
    assert.equal(await coverOf(tenantA, triple.id), null);
    tests.push(
      "a change written inside a SAVEPOINT that rolls back is gone with it, and the next write of the same transaction records exactly one"
    );

    // --------------------- 5. the pull brings the product; an offline edit does not conflict
    const edited = await newProduct(tenantA, "edicao offline");
    const versionBefore = edited.version;
    const cursor = await as(tenantA, (tx, identity) =>
      pullSyncChanges(tx, identity, { cursor: null, limit: 500 })
    );
    const media = await upload(tenantA, edited.id);
    const extra = await upload(tenantA, edited.id);
    await reorder(tenantA, edited.id, [extra, media]);
    const pulled = await as(tenantA, (tx, identity) =>
      pullSyncChanges(tx, identity, {
        cursor: cursor.nextCursor,
        limit: 500,
      })
    );
    assert.deepEqual(
      pulled.changes.map((change) => [change.entityType, change.entityId]),
      [["product", edited.id]],
      "the pull after the uploads and the reorder names the product, once"
    );
    assert.equal(
      (await bootstrapCovers(tenantA, [edited.id])).get(edited.id),
      extra,
      "re-reading it brings the new cover"
    );
    // the device edited the product offline before the images changed: its expected version still holds
    const update = await as(tenantA, (tx, identity) =>
      updateProduct(tx, identity, {
        categoryId: null,
        description: "editado sem conexão",
        expectedVersion: versionBefore,
        id: edited.id,
        name: `Editado ${randomUUID()}`,
        requestId: randomUUID(),
      })
    );
    assert.equal(update.changed, true);
    assert.equal(update.product.version, versionBefore + 1);
    tests.push(
      "after two uploads and a reorder the pull names the product once and re-reading it brings the new cover; an edit made offline with the version from before the images changed applies without a version conflict"
    );

    // any other UPDATE of positions, outside the commands, still tells the device once
    await oneChange(tenantA, edited.id, "a plain UPDATE", () =>
      withRuntimeSqlContext(runtimeUrl, tenantA, (client) =>
        client.query(
          "UPDATE public.product_media SET position = position + 10 WHERE product_id = $1",
          [edited.id]
        )
      )
    );
    assert.equal(await coverOf(tenantA, edited.id), extra);
    // only a statement whose new positions are all at the move-aside offset writes nothing
    const aside = await productChanges(tenantA, edited.id);
    // two transactions here, so the count between them reads what the first committed
    await withRuntimeSqlContext(runtimeUrl, tenantA, (client) =>
      client.query(
        "UPDATE public.product_media SET position = position + 1000000 WHERE product_id = $1",
        [edited.id]
      )
    );
    assert.equal(
      await productChanges(tenantA, edited.id),
      aside,
      "the move aside writes nothing"
    );
    await withRuntimeSqlContext(runtimeUrl, tenantA, (client) =>
      client.query(
        "UPDATE public.product_media SET position = position - 1000000 WHERE product_id = $1",
        [edited.id]
      )
    );
    assert.equal(
      await productChanges(tenantA, edited.id),
      aside + 1,
      "the statement that settles it writes the change"
    );
    tests.push(
      "a plain UPDATE of positions outside the commands writes one change; a statement that only moves the images aside (every position at or above the reorder offset) writes none, and the one that settles them writes one"
    );

    // ------------------------------------- 6. a cover is never of another organization
    const otherProduct = await newProduct(tenantB, "outra loja");
    const otherCover = await upload(tenantB, otherProduct.id);
    const coversA = await listCovers(tenantA);
    assert.equal(coversA.has(otherProduct.id), false);
    assert.equal(
      [...coversA.values()].includes(otherCover),
      false,
      "the other organization's image is no cover here"
    );
    assert.equal(
      (await bootstrapCovers(tenantA, [otherProduct.id])).size,
      0,
      "re-reading another organization's product by id reads nothing"
    );
    assert.equal(await coverOf(tenantB, otherProduct.id), otherCover);
    const foreign = await admin.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.product_media pm
        WHERE pm.organization_id = $1 AND pm.product_id = ANY($2::uuid[])`,
      [tenantB.organizationId, [...coversA.keys()]]
    );
    assert.equal(Number(foreign.rows[0]?.count), 0);
    // the runtime with the context of A, reading the cover of B's product directly, sees nothing
    const crossRead = await withRuntimeSqlContext(
      runtimeUrl,
      tenantA,
      async (client) =>
        (
          await client.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM public.product_media WHERE product_id = $1",
            [otherProduct.id]
          )
        ).rows[0]?.count
    );
    assert.equal(crossRead, "0");
    const ownership = await admin.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.media_assets
        WHERE id = ANY($1::uuid[]) AND organization_id <> $2`,
      [
        [...coversA.values()].filter((value) => value !== null),
        tenantA.organizationId,
      ]
    );
    assert.equal(
      Number(ownership.rows[0]?.count),
      0,
      "every cover read by A is an asset of A"
    );
    tests.push(
      "row security: A's list and bootstrap never carry B's product or image as a cover, re-reading B's product by id from A reads nothing, and every cover A reads is one of A's assets"
    );

    // ------------------------------------------ 7. the plan of a list of 1,248 products
    const tenantC = await createTenantFixture(admin.pool, "cover list");
    const seeder = await admin.pool.connect();
    try {
      await seeder.query("BEGIN");
      await seeder.query(
        `WITH created AS (
           INSERT INTO public.products (organization_id, name)
           SELECT $1, 'Produto ' || lpad(g::text, 4, '0') FROM generate_series(1, $2::int) AS g
           RETURNING id, organization_id
         )
         INSERT INTO public.product_variants (organization_id, product_id, is_default)
         SELECT organization_id, id, true FROM created`,
        [tenantC.organizationId, LIST_SIZE]
      );
      // one product in two with one to three images; the asset and its link in the same transaction
      await seeder.query(
        `WITH listed AS (
           SELECT id, row_number() OVER (ORDER BY name) AS n FROM public.products WHERE organization_id = $1
         ), wanted AS (
           SELECT listed.id AS product_id, slot.position, gen_random_uuid() AS command_id,
                  md5(listed.id::text || slot.position) || md5(slot.position || listed.id::text) AS fingerprint
             FROM listed CROSS JOIN LATERAL generate_series(0, (listed.n % 3)::int) AS slot(position)
            WHERE listed.n % 2 = 0
         ), keyed AS (
           SELECT wanted.*, 'media/v2/' || $1 || '/' || product_id || '/' || command_id || '/' || fingerprint || '/'
                  || gen_random_uuid() || '.webp' AS storage_key
             FROM wanted
         ), assets AS (
           INSERT INTO public.media_assets
             (organization_id, storage_key, content_type, byte_size, width, height, input_fingerprint, upload_command_id)
           SELECT $1, storage_key, 'image/webp', 2048, 640, 480, fingerprint, command_id FROM keyed
           RETURNING id, storage_key
         )
         INSERT INTO public.product_media (organization_id, product_id, media_asset_id, position)
         SELECT $1, keyed.product_id, assets.id, keyed.position
           FROM keyed JOIN assets ON assets.storage_key = keyed.storage_key`,
        [tenantC.organizationId]
      );
      await seeder.query("COMMIT");
    } catch (error) {
      await seeder.query("ROLLBACK");
      throw error;
    } finally {
      seeder.release();
    }
    await admin.pool.query("ANALYZE public.products");
    await admin.pool.query("ANALYZE public.product_media");
    const plan = await withTenantAs(
      db,
      tenantC,
      "catalog:read",
      async (tx, identity) => {
        const query = productListQuery(tx, identity, { status: "active" });
        const rows = await query;
        const explained = await tx.execute<{ "QUERY PLAN": string }>(
          sql`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY ON) ${query.getSQL()}`
        );
        return {
          lines: explained.rows.map((row) => row["QUERY PLAN"]),
          rows,
        };
      }
    );
    assert.equal(plan.rows.length, LIST_SIZE);
    const withCover = plan.rows.filter((row) => row.coverAssetId !== null);
    assert.equal(withCover.length, LIST_SIZE / 2);
    const expectedCovers = await admin.pool.query<{
      id: string;
      media_asset_id: string;
    }>(
      `SELECT DISTINCT ON (product_id) product_id AS id, media_asset_id FROM public.product_media
        WHERE organization_id = $1 ORDER BY product_id, position`,
      [tenantC.organizationId]
    );
    const expectedById = new Map(
      expectedCovers.rows.map((row) => [row.id, row.media_asset_id])
    );
    for (const row of withCover) {
      assert.equal(row.coverAssetId, expectedById.get(row.id));
    }
    const text = plan.lines.join("\n");
    for (const line of plan.lines) {
      console.log(`explain: ${line}`);
    }
    assert.match(
      text,
      coverIndexScan,
      "the cover is read through the index (organization_id, product_id, position)"
    );
    assert.doesNotMatch(text, seqScanOfMedia, "no product_media is read whole");
    tests.push(
      `the list of ${LIST_SIZE} products (half with one to three images) is one query whose cover comes from ${COVER_INDEX} (LIMIT 1 per product, no Seq Scan on product_media), and each cover is the image of lowest position`
    );

    console.log(JSON.stringify({ passed: true, tests }, null, 2));
  } catch (error) {
    console.error(redactedFailure(error));
    console.log(JSON.stringify({ passed: false, tests }, null, 2));
    process.exitCode = 1;
  } finally {
    await runtime?.pool.end();
    if (loginRole) {
      await admin.pool
        .query(`DROP ROLE IF EXISTS "${loginRole}"`)
        .catch(() => undefined);
    }
    await admin.pool.end();
  }
}

await run();
