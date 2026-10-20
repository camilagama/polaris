import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createDatabase } from "../src/client";
import {
  type CreateProductMediaAssetInput,
  createProductMediaAsset,
} from "../src/media-repository";
import { createProduct } from "../src/product-repository";
import {
  publishProducts,
  savePublicCatalogProfile,
  setPublicCatalogPublished,
} from "../src/public-catalog-repository";
import { isLocalGateHost } from "./gate-hosts";
import { assertDisposableEnvironment } from "./gate-target";
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
  withTenantAs,
} from "./sales-gate-support";
import { runWorkerdVitest, temporaryLogins } from "./workerd-gate-support";

/**
 * The server side of the Catalog Worker inside workerd, against the PostgreSQL of the job (T-121b): the Hyperdrive
 * binding of the public catalog role and the private bucket, through the code the routes call (the reads of
 * `@polaris/db/public-catalog-reader` and the image route's `serveCatalogMedia`). The TanStack Start handler of the
 * Worker needs the build of Vite and does not load in this harness (the e2e of the app, `bun run test:e2e` in
 * apps/catalog, is what runs it). This script makes one store that is shown, one that is not (never switched on) and
 * their products and image, runs the Vitest project `catalog-workerd-db` and then reads the database as the owner:
 * the reads left it as it was. Local Postgres only (`CI=true`).
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const MASTER_BYTES = [82, 73, 70, 70, 1, 2, 3, 4];

function mediaInput(
  organizationId: string,
  productId: string
): CreateProductMediaAssetInput {
  const uploadCommandId = randomUUID();
  const fingerprint = createHash("sha256").update(randomUUID()).digest("hex");
  return {
    byteSize: MASTER_BYTES.length,
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
  assert.equal(
    process.env.CI,
    "true",
    "The Catalog Worker gate runs only against the Postgres of the CI job."
  );
  const branch = requiredEnvironment("POLARIS_SALES_GATE_BRANCH");
  assert.match(branch, gateBranchPattern);
  const adminUrl = requiredEnvironment("POLARIS_SALES_GATE_DATABASE_URL");
  const parsedAdminUrl = new URL(adminUrl);
  assert.match(parsedAdminUrl.hostname, disposableHostPattern);
  assert.doesNotMatch(parsedAdminUrl.hostname, poolerPattern);
  assert.ok(
    isLocalGateHost(parsedAdminUrl.hostname),
    "The Catalog Worker gate needs the job's own Postgres."
  );

  const owner = createDatabase(adminUrl, { maxConnections: 2 });
  const logins = temporaryLogins(owner, adminUrl);
  const tests: string[] = [];
  let runtime: ReturnType<typeof createDatabase> | undefined;

  try {
    // a database marked as staging, production or restore drill is refused, also when the gate runs outside the runner
    await assertDisposableEnvironment(owner.pool);
    const server = await owner.pool.query<{
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
    const migrations = await owner.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations"
    );
    assert.equal(Number(migrations.rows[0]?.count), journalMigrationCount());

    const catalogUrl = await logins.login(
      "polaris_catalog_runtime",
      "polaris_ctw_catalog"
    );
    const tenantUrl = await logins.login(runtimeRole, "polaris_ctw_tenant");
    runtime = createDatabase(tenantUrl, { maxConnections: 4 });
    const { db } = runtime;
    const as = <T>(
      tenant: TenantFixture,
      capability: string,
      operation: Parameters<typeof withTenantAs<T>>[3]
    ) => withTenantAs(db, tenant, capability, operation);

    // ------------------------------------------------- fixtures: a store that is shown and one that never was
    const suffix = randomUUID().slice(0, 8);
    const store = async (label: string, switchedOn: boolean) => {
      const organization = await createTenantFixture(
        owner.pool,
        `catalog worker ${label} ${suffix}`,
        "America/Sao_Paulo",
        "pro"
      );
      const slug = `loja-ctw-${label}-${suffix}`;
      const profile = await as(
        organization,
        "catalog:publish",
        (tx, identity) =>
          savePublicCatalogProfile(tx, identity, {
            description: "Roupas feitas à mão",
            instagram: "@loja.teste",
            publicName: `Loja ${label}`,
            slug,
            whatsapp: "+55 (11) 91234-5678",
          })
      );
      const product = await as(organization, "product:create", (tx, identity) =>
        createProduct(tx, identity, { name: `Vestido ${label}` })
      );
      const sku = `SEGREDO-${randomUUID()}`;
      await owner.pool.query(
        "UPDATE public.product_variants SET list_price = 129.90, sku = $2 WHERE product_id = $1",
        [product.id, sku]
      );
      const input = mediaInput(organization.organizationId, product.id);
      const media = await as(organization, "product:update", (tx, identity) =>
        createProductMediaAsset(tx, identity, input)
      );
      await as(organization, "catalog:publish", (tx, identity) =>
        publishProducts(tx, identity, { productIds: [product.id] })
      );
      if (switchedOn) {
        await as(organization, "catalog:publish", (tx, identity) =>
          setPublicCatalogPublished(tx, identity, {
            expectedVersion: profile.version,
            published: true,
          })
        );
      }
      return {
        assetId: media.asset.assetId,
        organizationId: organization.organizationId,
        productId: product.id,
        productName: `Vestido ${label}`,
        slug,
        sku,
        storageKey: input.storageKey,
      };
    };
    const shown = await store("on", true);
    const hidden = await store("off", false);
    const counts = async () =>
      (
        await owner.pool.query<{ publications: string; version: string }>(
          `SELECT (SELECT count(*) FROM public.product_publications WHERE organization_id = ANY($1))::text AS publications,
                  (SELECT sum(version) FROM public.public_catalog_profiles WHERE organization_id = ANY($1))::text AS version`,
          [[shown.organizationId, hidden.organizationId]]
        )
      ).rows[0];
    const before = await counts();

    // ------------------------------------------------- the Worker's server side, in workerd
    const result = await runWorkerdVitest("vitest.catalog-worker.config.ts", {
      POLARIS_CATALOG_WORKER_CATALOG_HYPERDRIVE_URL: catalogUrl,
      POLARIS_CATALOG_WORKER_FIXTURE: JSON.stringify({
        masterBytes: MASTER_BYTES,
        catalogLogin: decodeURIComponent(new URL(catalogUrl).username),
        hidden,
        shown,
      }),
    });
    if (result.code !== 0) {
      // the runner of the gates shows only the last lines: the digest is what failed, the whole output only on request
      const lines =
        process.env.POLARIS_WORKERD_GATE_VERBOSE === "1"
          ? result.lines
          : result.digest;
      for (const line of lines) {
        console.error(
          process.env.POLARIS_WORKERD_GATE_VERBOSE === "1"
            ? line
            : line.slice(0, 220)
        );
      }
      throw new Error(
        "The Catalog Worker suite failed inside workerd (the lines above)."
      );
    }
    tests.push(
      "the Hyperdrive binding of the public catalog role and the bucket work inside workerd: the reads, the image route, and what a store that is not shown, an unknown address and a database that is down answer"
    );

    // ------------------------------------------------- what the database holds afterwards
    assert.deepEqual(
      await counts(),
      before,
      "reading the catalog changed nothing"
    );
    tests.push(
      "the reads of the public role left the publications and the profiles as they were"
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
    try {
      await runtime?.pool.end();
    } finally {
      try {
        await logins.drop();
      } finally {
        await owner.pool.end();
      }
    }
  }
}

run().catch((error: unknown) => {
  console.error(
    `Catalog Worker PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
