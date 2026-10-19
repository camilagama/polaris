import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { MediaUploadCommandConflictError } from "@polaris/domain/catalog/media";
import { ProductDeletedError } from "@polaris/domain/catalog/product";
import { and, asc, eq } from "drizzle-orm";
import { Client } from "pg";
import { createDatabase } from "../src/client";
import {
  type CreateProductMediaAssetInput,
  createProductMediaAsset,
  listProductMedia,
} from "../src/media-repository";
import {
  configureProductVariants,
  createProduct,
  deleteProduct,
} from "../src/product-repository";
import { productVariants } from "../src/schema/product";
import {
  type TenantRequestIdentity,
  type TenantRequestTransaction,
  withAuthorizedTenantTransaction,
} from "../src/tenant-transaction";
import {
  assertAllowedGateUrl,
  disposableHostPattern,
  isLocalGateHost,
} from "./gate-hosts";

const gateDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const expectedBranch =
  process.env.POLARIS_GATE_BRANCH ?? "pr34-media-upload-gate";
const runtimeRole = "polaris_pr11_runtime";
const mediaTables = ["media_assets", "product_media", "variant_media"];
const expectedChecks = [
  "media_assets_byte_size_valid",
  "media_assets_content_type_webp",
  "media_assets_dimensions_valid",
  "media_assets_input_fingerprint_sha256",
  "media_assets_product_link_required",
];
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
    throw new Error("Missing PR34 media upload gate configuration.");
  }
  return value;
}

function sqlState(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const { code } = error as { code?: unknown };
  return typeof code === "string" ? code : undefined;
}

async function expectSqlState(
  operation: () => Promise<unknown>,
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
    [
      userId,
      `PR34 media upload gate ${label}`,
      `pr34-${userId}@example.invalid`,
    ]
  );
  await adminPool.query(
    "INSERT INTO public.organizations (id, name, timezone) VALUES ($1, $2, $3)",
    [organizationId, `PR34 media upload gate ${label}`, "America/Sao_Paulo"]
  );
  await adminPool.query(
    "INSERT INTO public.memberships (organization_id, user_id, role, status) " +
      "VALUES ($1, $2, 'owner', 'active')",
    [organizationId, userId]
  );
  // these gates exercise the media pipeline, which the plan limits: a paid organization
  await adminPool.query(
    "INSERT INTO public.organization_billing (organization_id, state, access_ends_at) VALUES ($1, 'active', now() + interval '365 days')",
    [organizationId]
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
        name: `PR34 ${label} ${randomUUID()}`,
        requestId: randomUUID(),
      })
  );
  return product.id;
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

function createAssetInput(input: {
  organizationId: string;
  productId: string;
  uploadCommandId?: string;
  fingerprint?: string;
  variantIds?: string[];
}): CreateProductMediaAssetInput {
  const uploadCommandId = input.uploadCommandId ?? randomUUID();
  const inputFingerprint =
    input.fingerprint ??
    createHash("sha256").update(randomUUID()).digest("hex");
  return {
    byteSize: 2048,
    height: 480,
    inputFingerprint,
    productId: input.productId,
    requestId: randomUUID(),
    // The v2 key built from the asset's own organization, command and fingerprint
    // (the database refuses any other shape).
    storageKey: `media/v2/${input.organizationId}/${input.productId}/${uploadCommandId}/${inputFingerprint}/${randomUUID()}.webp`,
    uploadCommandId,
    variantIds: input.variantIds ?? [],
    width: 640,
  };
}

async function createRuntimeClient(connectionString: string): Promise<Client> {
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  if (process.env.POLARIS_GATE_RUNTIME_LOGIN) {
    // The unified gate runner connects through a temporary login that is a member of the runtime role.
    await client.query(`SET ROLE ${runtimeRole}`);
  }
  const role = await client.query<{ role: string }>(
    "SELECT current_user AS role"
  );
  assert.equal(role.rows[0]?.role, runtimeRole);
  return client;
}

async function withRuntimeTenant<T>(
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

async function insertRawAsset(
  client: Client,
  organizationId: string,
  input: {
    byteSize?: number;
    contentType?: string;
    height?: number;
    uploadCommandId?: string;
    fingerprint?: string;
    storageKey?: string;
    width?: number;
  } = {}
): Promise<string> {
  const uploadCommandId = input.uploadCommandId ?? randomUUID();
  const fingerprint =
    input.fingerprint ??
    createHash("sha256").update(randomUUID()).digest("hex");
  const result = await client.query<{ id: string }>(
    "INSERT INTO public.media_assets " +
      "(organization_id, byte_size, content_type, height, input_fingerprint, storage_key, upload_command_id, width) " +
      "VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id",
    [
      organizationId,
      input.byteSize ?? 2048,
      input.contentType ?? "image/webp",
      input.height ?? 480,
      fingerprint,
      input.storageKey ??
        `media/v2/${organizationId}/${randomUUID()}/${uploadCommandId}/${fingerprint}/${randomUUID()}.webp`,
      uploadCommandId,
      input.width ?? 640,
    ]
  );
  const [row] = result.rows;
  assert.ok(row);
  return row.id;
}

async function main(): Promise<void> {
  const connectionString = requiredEnvironment(
    "POLARIS_MEDIA_UPLOAD_GATE_DATABASE_URL"
  );
  const runtimeConnectionString = requiredEnvironment(
    "POLARIS_MEDIA_UPLOAD_GATE_RUNTIME_DATABASE_URL"
  );
  const confirmation = requiredEnvironment(
    "POLARIS_MEDIA_UPLOAD_GATE_CONFIRM_DISPOSABLE"
  );
  const expectedHostname = requiredEnvironment(
    "POLARIS_MEDIA_UPLOAD_GATE_EXPECTED_HOSTNAME"
  );

  assert.equal(confirmation, expectedBranch);
  const connection = assertAllowedGateUrl(connectionString);
  const runtimeConnection = assertAllowedGateUrl(runtimeConnectionString);
  for (const candidate of [connection, runtimeConnection]) {
    assert.equal(candidate.protocol, "postgresql:");
    assert.equal(candidate.hostname, expectedHostname);
    assert.match(candidate.hostname, disposableHostPattern);
    assert.equal(candidate.pathname, `/${gateDatabase}`);
    // the job's own Postgres has no TLS; every Neon endpoint is verified
    if (!isLocalGateHost(candidate.hostname)) {
      assert.equal(candidate.searchParams.get("sslmode"), "verify-full");
    }
    assert.doesNotMatch(candidate.hostname, poolerPattern);
  }
  assert.equal(
    decodeURIComponent(runtimeConnection.username),
    process.env.POLARIS_GATE_RUNTIME_LOGIN ?? runtimeRole
  );

  const admin = createDatabase(connectionString, { maxConnections: 8 });
  const runtimeDatabase = createDatabase(runtimeConnectionString, {
    maxConnections: 8,
  });
  const runtimeClients: Client[] = [];
  try {
    const server = await admin.pool.query<{
      server_version: string;
      server_version_num: number;
    }>(
      "SELECT current_setting('server_version') AS server_version, " +
        "current_setting('server_version_num')::integer AS server_version_num"
    );
    const [serverInfo] = server.rows;
    assert.ok(serverInfo);
    assert.equal(Math.floor(serverInfo.server_version_num / 10_000), 18);

    const columnRows = await admin.pool.query<{ attname: string }>(
      "SELECT attname FROM pg_attribute " +
        "WHERE attrelid = 'public.media_assets'::regclass " +
        "AND attnum > 0 AND NOT attisdropped"
    );
    const columns = new Set(columnRows.rows.map((column) => column.attname));
    for (const name of [
      "storage_key",
      "content_type",
      "byte_size",
      "width",
      "height",
      "upload_command_id",
      "input_fingerprint",
    ]) {
      assert.ok(columns.has(name), `media_assets.${name} is missing`);
    }

    const rls = await admin.pool.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      "SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity " +
        "FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace " +
        "WHERE n.nspname = 'public' AND c.relname = ANY($1::text[]) ORDER BY c.relname",
      [mediaTables]
    );
    assert.equal(rls.rowCount, mediaTables.length);
    for (const table of rls.rows) {
      assert.equal(table.relrowsecurity, true, `${table.relname} RLS enabled`);
      assert.equal(
        table.relforcerowsecurity,
        true,
        `${table.relname} FORCE RLS enabled`
      );
    }

    const grants = await admin.pool.query<{
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
      [runtimeRole, mediaTables]
    );
    assert.equal(grants.rowCount, mediaTables.length);
    for (const grant of grants.rows) {
      assert.equal(grant.can_select, true, `${grant.table_name} SELECT grant`);
      assert.equal(grant.can_insert, true, `${grant.table_name} INSERT grant`);
      assert.equal(
        grant.can_update,
        false,
        `${grant.table_name} UPDATE denied`
      );
      // Links can be removed since migration 0051 (an image is removed from a product);
      // the asset itself never can. Only the position of a product link can change
      // (a column grant: table-level UPDATE stays false).
      const linkTable = grant.table_name !== "media_assets";
      assert.equal(
        grant.can_delete,
        linkTable,
        `${grant.table_name} DELETE ${linkTable ? "granted" : "denied"}`
      );
    }

    const constraints = await admin.pool.query<{ conname: string }>(
      "SELECT conname FROM pg_constraint " +
        "WHERE conrelid = 'public.media_assets'::regclass AND conname = ANY($1::text[])",
      [expectedChecks]
    );
    assert.deepEqual(
      constraints.rows.map((row) => row.conname).sort(),
      [...expectedChecks].sort()
    );

    const tenantA = await createTenantFixture(admin.pool, "tenant-a");
    const tenantB = await createTenantFixture(admin.pool, "tenant-b");
    const productA = await createTestProduct(admin.db, tenantA, "tenant-a");
    const productA2 = await createTestProduct(
      admin.db,
      tenantA,
      "tenant-a-second-product"
    );
    await withTenant(
      admin.db,
      tenantA,
      "product:update",
      (transaction, identity) =>
        configureProductVariants(transaction, identity, {
          expectedVersion: 1,
          id: productA,
          options: [{ name: "color", values: ["blue", "green"] }],
          requestId: randomUUID(),
          variants: [
            { values: { color: "blue" } },
            { values: { color: "green" } },
          ],
        })
    );
    const variantIds = await getConfiguredVariantIds(
      admin.db,
      tenantA,
      productA
    );
    assert.equal(variantIds.length, 2);
    const [firstVariantId] = variantIds;
    assert.ok(firstVariantId);
    const runtimeA = await createRuntimeClient(runtimeConnectionString);
    const runtimeB = await createRuntimeClient(runtimeConnectionString);
    runtimeClients.push(runtimeA, runtimeB);

    const firstInput = createAssetInput({
      organizationId: tenantA.organizationId,
      productId: productA,
      variantIds,
    });
    const first = await withTenant(
      runtimeDatabase.db,
      tenantA,
      "product:update",
      (transaction, identity) =>
        createProductMediaAsset(transaction, identity, firstInput)
    );
    assert.equal(first.replayed, false);
    assert.deepEqual(
      [...first.asset.variantIds].sort(),
      [...variantIds].sort()
    );
    assert.equal(first.asset.position, 0);

    await expectSqlState(
      () =>
        admin.pool.query(
          "INSERT INTO public.product_media " +
            "(organization_id, product_id, media_asset_id, position) VALUES ($1, $2, $3, 0)",
          [tenantA.organizationId, productA2, first.asset.assetId]
        ),
      "23505",
      "one asset cannot be associated with a second product"
    );

    const replay = await withTenant(
      runtimeDatabase.db,
      tenantA,
      "product:update",
      (transaction, identity) =>
        createProductMediaAsset(transaction, identity, firstInput)
    );
    assert.equal(replay.replayed, true);
    assert.equal(replay.asset.assetId, first.asset.assetId);
    await assert.rejects(
      withTenant(
        runtimeDatabase.db,
        tenantA,
        "product:update",
        (transaction, identity) =>
          createProductMediaAsset(
            transaction,
            identity,
            createAssetInput({
              fingerprint: "a".repeat(64),
              organizationId: tenantA.organizationId,
              productId: productA,
              uploadCommandId: firstInput.uploadCommandId,
              variantIds,
            })
          )
      ),
      (error: unknown) => error instanceof MediaUploadCommandConflictError
    );

    const second = await withTenant(
      runtimeDatabase.db,
      tenantA,
      "product:update",
      (transaction, identity) =>
        createProductMediaAsset(
          transaction,
          identity,
          createAssetInput({
            organizationId: tenantA.organizationId,
            productId: productA,
          })
        )
    );
    assert.equal(second.asset.position, 1);
    const listed = await withTenant(
      runtimeDatabase.db,
      tenantA,
      "catalog:read",
      (transaction) =>
        listProductMedia(transaction, tenantA.organizationId, productA)
    );
    assert.equal(listed.length, 2);
    assert.deepEqual(
      [...(listed[0]?.variantIds ?? [])].sort(),
      [...variantIds].sort()
    );
    const variantAssociations = await admin.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM public.variant_media " +
        "WHERE organization_id = $1 AND product_id = $2 AND media_asset_id = $3",
      [tenantA.organizationId, productA, first.asset.assetId]
    );
    assert.equal(variantAssociations.rows[0]?.count, "2");
    assert.deepEqual(
      listed.map((asset) => asset.position),
      [0, 1]
    );

    const audit = await admin.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM public.tenant_audit_event " +
        "WHERE organization_id = $1 AND entity_id = $2 AND event_type = 'product.media_uploaded'",
      [tenantA.organizationId, productA]
    );
    assert.equal(audit.rows[0]?.count, "2");

    const unscoped = await runtimeA.query("SELECT id FROM public.media_assets");
    assert.equal(unscoped.rowCount, 0);
    const crossTenantReads = await withRuntimeTenant(
      runtimeB,
      tenantB,
      async () => {
        const assets = await runtimeB.query(
          "SELECT id FROM public.media_assets WHERE organization_id = $1",
          [tenantA.organizationId]
        );
        const links = await runtimeB.query(
          "SELECT media_asset_id FROM public.product_media WHERE organization_id = $1",
          [tenantA.organizationId]
        );
        const variantLinks = await runtimeB.query(
          "SELECT media_asset_id FROM public.variant_media WHERE organization_id = $1",
          [tenantA.organizationId]
        );
        return {
          assetCount: assets.rowCount,
          linkCount: links.rowCount,
          variantLinkCount: variantLinks.rowCount,
        };
      }
    );
    assert.deepEqual(crossTenantReads, {
      assetCount: 0,
      linkCount: 0,
      variantLinkCount: 0,
    });

    await expectSqlState(
      () =>
        withRuntimeTenant(runtimeB, tenantB, () =>
          insertRawAsset(runtimeB, tenantA.organizationId)
        ),
      "42501",
      "runtime must not insert an asset into another tenant"
    );

    await expectSqlState(
      () =>
        withRuntimeTenant(runtimeB, tenantB, () =>
          runtimeB.query(
            "INSERT INTO public.variant_media " +
              "(organization_id, product_id, variant_id, media_asset_id, position) VALUES ($1, $2, $3, $4, 1)",
            [
              tenantA.organizationId,
              productA,
              firstVariantId,
              first.asset.assetId,
            ]
          )
        ),
      "42501",
      "runtime must not create a cross-tenant variant association"
    );

    await expectSqlState(
      () =>
        withRuntimeTenant(runtimeA, tenantA, () =>
          insertRawAsset(runtimeA, tenantA.organizationId, {
            byteSize: 20_000_001,
          })
        ),
      "23514",
      "database must reject assets above the input byte ceiling"
    );

    await expectSqlState(
      () =>
        withRuntimeTenant(runtimeA, tenantA, () =>
          insertRawAsset(runtimeA, tenantA.organizationId, {
            contentType: "image/png",
          })
        ),
      "23514",
      "database only permits normalized WebP output"
    );

    await expectSqlState(
      () =>
        withRuntimeTenant(runtimeA, tenantA, () =>
          insertRawAsset(runtimeA, tenantA.organizationId, {
            width: 1201,
          })
        ),
      "23514",
      "database must reject output dimensions above 1200 pixels"
    );

    await expectSqlState(
      () =>
        withRuntimeTenant(runtimeA, tenantA, () =>
          insertRawAsset(runtimeA, tenantA.organizationId, {
            fingerprint: "not-a-sha256",
          })
        ),
      "23514",
      "database must reject malformed input fingerprints"
    );

    await expectSqlState(
      () =>
        withRuntimeTenant(runtimeA, tenantA, () =>
          insertRawAsset(runtimeA, tenantA.organizationId)
        ),
      "23514",
      "deferred constraint must reject an asset without a product association"
    );

    const productRow = await admin.pool.query<{ version: number }>(
      "SELECT version FROM public.products WHERE organization_id = $1 AND id = $2",
      [tenantA.organizationId, productA]
    );
    const productVersion = productRow.rows[0]?.version;
    assert.ok(productVersion);
    await withTenant(
      admin.db,
      tenantA,
      "product:update",
      (transaction, identity) =>
        deleteProduct(transaction, identity, {
          expectedVersion: productVersion,
          id: productA,
          requestId: randomUUID(),
        })
    );

    const historicalMedia = await withTenant(
      runtimeDatabase.db,
      tenantA,
      "catalog:read",
      (transaction) =>
        listProductMedia(transaction, tenantA.organizationId, productA)
    );
    assert.equal(historicalMedia.length, 2);

    await assert.rejects(
      withTenant(
        runtimeDatabase.db,
        tenantA,
        "product:update",
        (transaction, identity) =>
          createProductMediaAsset(
            transaction,
            identity,
            createAssetInput({
              organizationId: tenantA.organizationId,
              productId: productA,
            })
          )
      ),
      (error: unknown) => error instanceof ProductDeletedError
    );

    await expectSqlState(
      () =>
        withRuntimeTenant(runtimeA, tenantA, async () => {
          const mediaAssetId = await insertRawAsset(
            runtimeA,
            tenantA.organizationId
          );
          await runtimeA.query(
            "INSERT INTO public.product_media " +
              "(organization_id, product_id, media_asset_id, position) VALUES ($1, $2, $3, 2)",
            [tenantA.organizationId, productA, mediaAssetId]
          );
        }),
      "23514",
      "database guard must block direct media associations after product tombstone"
    );

    await expectSqlState(
      () =>
        runtimeA.query(
          "UPDATE public.media_assets SET byte_size = 2 WHERE id = $1",
          [first.asset.assetId]
        ),
      "42501",
      "runtime must not update media asset metadata"
    );
    await expectSqlState(
      () =>
        runtimeA.query("DELETE FROM public.media_assets WHERE id = $1", [
          first.asset.assetId,
        ]),
      "42501",
      "runtime must not delete media asset metadata"
    );

    const report = {
      branch: expectedBranch,
      database: gateDatabase,
      fixtures: "synthetic fixtures retained until branch auto-expiry",
      serverVersion: serverInfo.server_version,
      status: "passed",
      tests: [
        "PostgreSQL 18 and upload metadata constraints are present",
        "media tables retain FORCE RLS and runtime receives SELECT plus INSERT only",
        "runtime creates product-linked assets through tenant-scoped repository transactions",
        "upload command replay is idempotent and payload mismatches conflict",
        "product media order appends and the same asset is reusable across two variants of its owning product",
        "each new upload writes one tenant audit event; replay writes none",
        "unscoped and cross-tenant reads of assets and both association tables are denied",
        "cross-tenant asset and variant association inserts are denied by RLS",
        "a media asset cannot be associated with a second product",
        "database rejects oversize, non-WebP, oversized output, and malformed fingerprints",
        "deferred constraint rejects an asset without a product association",
        "product tombstone preserves historical media and blocks repository and direct SQL writes",
        "runtime cannot update or delete media records",
      ],
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    const closeResults = await Promise.allSettled([
      ...runtimeClients.map((client) => client.end()),
      runtimeDatabase.pool.end(),
      admin.pool.end(),
    ]);
    const closeErrors = closeResults
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (closeErrors.length > 0) {
      console.error("Could not close every PR34 media upload gate connection.");
      process.exitCode = 1;
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown error";
  console.error("PR34 media upload gate failed:", message);
  process.exitCode = 1;
});
