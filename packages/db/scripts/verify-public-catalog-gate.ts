import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  EntitlementDeniedError,
  INITIAL_PLAN_CATALOG,
  resolveEntitlements,
} from "@polaris/domain/billing/entitlements";
import {
  InvalidPublicCatalogProfileError,
  PublicCatalogProductUnavailableError,
  PublicCatalogProfileMissingError,
  PublicCatalogSlugTakenError,
  PublicCatalogVersionConflictError,
  RESERVED_SLUGS,
} from "@polaris/domain/catalog/public-catalog";
import { Client } from "pg";
import { createDatabase } from "../src/client";
import {
  type CreateProductMediaAssetInput,
  createProductMediaAsset,
} from "../src/media-repository";
import {
  archiveProduct,
  configureProductVariants,
  createProduct,
  deleteProduct,
} from "../src/product-repository";
import { publicCatalogReaderOver } from "../src/public-catalog-reader";
import {
  publishProducts,
  readPublicCatalogSetup,
  savePublicCatalogProfile,
  setPublicCatalogPublished,
  unpublishProducts,
} from "../src/public-catalog-repository";
import { TenantAuthorizationError } from "../src/tenant-transaction";
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
 * The public catalog on a real PostgreSQL 18 (plan PR87 and PR88, ADR 0069): the
 * organization's side (profile, switch, products shown, all behind the plan) and
 * the public side, which is a database role that can read no table and can only
 * run four functions that return what is shown, look at the plan on every call
 * (a downgrade, an expired grant, a closed account, an archived or deleted
 * product or an unpublished one stops being served at once), and never return an
 * organization ID, a cost, a stock count or a SKU.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

type Json = Record<string, unknown> | null;

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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the gate is one linear list of independent scenarios
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
  let catalogLoginRole: string | undefined;
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

    loginRole = `polaris_catalog_gate_rt_${randomUUID().replaceAll("-", "")}`;
    catalogLoginRole = `polaris_catalog_gate_${randomUUID().replaceAll("-", "")}`;
    const loginPassword = randomBytes(24).toString("hex");
    const catalogPassword = randomBytes(24).toString("hex");
    await admin.pool.query(
      `CREATE ROLE "${loginRole}" WITH LOGIN INHERIT PASSWORD '${loginPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
    );
    await admin.pool.query(`GRANT "${runtimeRole}" TO "${loginRole}"`);
    await admin.pool.query(
      `CREATE ROLE "${catalogLoginRole}" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${catalogPassword}'`
    );
    await admin.pool.query(
      `GRANT polaris_catalog_runtime TO "${catalogLoginRole}"`
    );
    const runtimeUrl = temporaryRuntimeUrl(adminUrl, loginRole, loginPassword);
    const catalogUrl = temporaryRuntimeUrl(
      adminUrl,
      catalogLoginRole,
      catalogPassword
    );
    runtime = createDatabase(runtimeUrl, { maxConnections: 6 });
    const { db } = runtime;
    const as = <T>(
      tenant: TenantFixture,
      capability: string,
      operation: Parameters<typeof withTenantAs<T>>[3]
    ) => withTenantAs(db, tenant, capability, operation);
    const asPublisher = <T>(
      tenant: TenantFixture,
      operation: Parameters<typeof withTenantAs<T>>[3]
    ) => as(tenant, "catalog:publish", operation);
    const asCatalog = async <T>(
      operation: (client: Client) => Promise<T>
    ): Promise<T> => {
      const client = new Client({
        connectionString: catalogUrl,
        connectionTimeoutMillis: 5000,
      });
      await client.connect();
      try {
        return await operation(client);
      } finally {
        await client.end();
      }
    };
    const call = <T = Json>(statement: string, values: unknown[]) =>
      asCatalog(async (client) => {
        const result = await client.query<{ result: T }>(
          `SELECT ${statement} AS result`,
          values
        );
        return result.rows[0]?.result as T;
      });
    const profileOf = (slug: string) =>
      call("public.public_catalog_profile($1)", [slug]);
    const productsOf = (
      slug: string,
      limit = 20,
      after: string | null = null
    ) =>
      call("public.public_catalog_products($1, $2, $3::uuid)", [
        slug,
        limit,
        after,
      ]);
    const productOf = (slug: string, productId: string) =>
      call("public.public_catalog_product($1, $2::uuid)", [slug, productId]);
    const mediaOf = (slug: string, productId: string, assetId: string) =>
      call("public.public_catalog_media($1, $2::uuid, $3::uuid)", [
        slug,
        productId,
        assetId,
      ]);

    const pro = (label: string) =>
      createTenantFixture(admin.pool, label, "America/Sao_Paulo", "pro");
    const free = (label: string) =>
      createTenantFixture(admin.pool, label, "America/Sao_Paulo", "free");
    const newProduct = (tenant: TenantFixture, name: string) =>
      as(tenant, "product:create", (tx, identity) =>
        createProduct(tx, identity, { name })
      );
    const profileInput = (slug: string) => ({
      description: "Roupas feitas à mão",
      instagram: "@loja.teste",
      publicName: "Loja de Teste",
      slug,
      whatsapp: "+55 (11) 91234-5678",
    });

    // ------------------------------------------------- 1. who can do what
    const probe = await pro("catalog probe");
    for (const statement of [
      "SELECT 1 FROM public.products",
      "SELECT 1 FROM public.product_variants",
      "SELECT 1 FROM public.organizations",
      "SELECT 1 FROM public.public_catalog_profiles",
      "SELECT 1 FROM public.product_publications",
      "SELECT 1 FROM public.media_assets",
      "SELECT 1 FROM public.product_media",
      "SELECT 1 FROM public.inventory_balances",
      "SELECT 1 FROM public.sales",
      "SELECT 1 FROM public.customers",
      "SELECT 1 FROM public.organization_billing",
      "SELECT 1 FROM public.entitlement_grants",
      "SELECT 1 FROM public.plan_entitlements",
      "SELECT public.organization_public_catalog_enabled('x')",
      "SELECT public.public_catalog_visible_organization('x')",
      "SELECT public.organization_exceeds_free_limits('x')",
      "SELECT public.organization_free_limit_excess('x')",
      "DELETE FROM public.products",
      "INSERT INTO public.public_catalog_profiles (organization_id, slug, public_name) VALUES ('x', 'abc', 'x')",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: Many probes, in order.
      await expectSqlState(
        () => asCatalog((client) => client.query(statement)),
        "42501",
        `the public role cannot: ${statement}`
      );
    }
    for (const statement of [
      "SELECT public.public_catalog_profile('x')",
      "SELECT public.public_catalog_products('x', 20, NULL)",
      "SELECT public.public_catalog_product('x', gen_random_uuid())",
      "SELECT public.public_catalog_media('x', gen_random_uuid(), gen_random_uuid())",
      "SELECT public.organization_public_catalog_enabled('x')",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: Five probes, in order.
      await expectSqlState(
        () =>
          withRuntimeSqlContext(runtimeUrl, probe, (client) =>
            client.query(statement)
          ),
        "42501",
        `the tenant role cannot run: ${statement}`
      );
    }
    for (const statement of [
      "DELETE FROM public.public_catalog_profiles",
      "DELETE FROM public.product_publications",
      "UPDATE public.public_catalog_profiles SET organization_id = 'x'",
      "UPDATE public.product_publications SET product_id = gen_random_uuid()",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: Four probes, in order.
      await expectSqlState(
        () =>
          withRuntimeSqlContext(runtimeUrl, probe, (client) =>
            client.query(statement)
          ),
        "42501",
        `the tenant role cannot: ${statement}`
      );
    }
    const functions = await admin.pool.query<{
      public_execute: number;
      owner_ok: number;
    }>(
      `SELECT
         count(*) FILTER (WHERE has_function_privilege('public', p.oid, 'EXECUTE'))::int AS public_execute,
         count(*) FILTER (WHERE pg_get_userbyid(p.proowner) = 'polaris_catalog_owner' AND p.prosecdef AND p.proconfig::text LIKE '%search_path=pg_catalog, public%')::int AS owner_ok
       FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace
        AND p.proname IN ('organization_public_catalog_enabled', 'public_catalog_visible_organization', 'public_catalog_profile', 'public_catalog_products', 'public_catalog_product', 'public_catalog_media')`
    );
    assert.deepEqual(functions.rows, [{ owner_ok: 6, public_execute: 0 }]);
    tests.push(
      "the public role reads no table and runs only the four public functions (not the helpers, not billing's), the tenant role cannot run any of them, cannot delete or re-key its profile or publications, and the six functions are SECURITY DEFINER with a pinned search_path, owned by the catalog owner, and not executable by PUBLIC"
    );

    // ------------------------------------------------- 2. the organization's side
    const freeOrg = await free("catalog free");
    await assert.rejects(
      () =>
        asPublisher(freeOrg, (tx, identity) =>
          savePublicCatalogProfile(tx, identity, profileInput("loja-free"))
        ),
      EntitlementDeniedError,
      "a Free organization cannot take an address"
    );
    await assert.rejects(
      () =>
        asPublisher(freeOrg, (tx, identity) =>
          setPublicCatalogPublished(tx, identity, {
            expectedVersion: 1,
            published: true,
          })
        ),
      PublicCatalogProfileMissingError
    );
    const freeProduct = await newProduct(freeOrg, "Produto Free");
    await assert.rejects(
      () =>
        asPublisher(freeOrg, (tx, identity) =>
          publishProducts(tx, identity, { productIds: [freeProduct.id] })
        ),
      EntitlementDeniedError,
      "a Free organization cannot show a product"
    );
    const freeSetup = await asPublisher(freeOrg, (tx, identity) =>
      readPublicCatalogSetup(tx, identity)
    );
    assert.deepEqual(
      {
        enabled: freeSetup.enabled,
        profile: freeSetup.profile,
        shown: freeSetup.publishedProductIds,
      },
      { enabled: false, profile: null, shown: [] }
    );
    await assert.rejects(
      () =>
        as(freeOrg, "product:update", (tx, identity) =>
          readPublicCatalogSetup(tx, identity)
        ),
      TenantAuthorizationError,
      "the capability to publish is its own"
    );

    const orgA = await pro("catalog A");
    const slugA = `loja-a-${randomUUID().slice(0, 8)}`;
    const created = await asPublisher(orgA, (tx, identity) =>
      savePublicCatalogProfile(tx, identity, profileInput(slugA.toUpperCase()))
    );
    assert.equal(created.slug, slugA, "the address is stored in lowercase");
    assert.equal(created.version, 1);
    assert.equal(created.whatsapp, "5511912345678");
    assert.equal(created.instagram, "loja.teste");
    assert.equal(created.published, false);
    // the address is one namespace
    const orgB = await pro("catalog B");
    await assert.rejects(
      () =>
        asPublisher(orgB, (tx, identity) =>
          savePublicCatalogProfile(tx, identity, profileInput(slugA))
        ),
      PublicCatalogSlugTakenError
    );
    for (const [label, bad] of [
      ["a reserved address", { slug: "admin" }],
      ["a malformed address", { slug: "Loja Com Espaço" }],
      ["a malformed number", { whatsapp: "123" }],
      ["a missing name", { publicName: "  " }],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: Four refusals, in order.
      await assert.rejects(
        () =>
          asPublisher(orgB, (tx, identity) =>
            savePublicCatalogProfile(tx, identity, {
              ...profileInput(`loja-b-${randomUUID().slice(0, 8)}`),
              ...bad,
            })
          ),
        InvalidPublicCatalogProfileError,
        label
      );
    }
    // the database refuses a reserved address too, whoever writes it
    await expectSqlState(
      () =>
        admin.pool.query(
          "INSERT INTO public.public_catalog_profiles (organization_id, slug, public_name) VALUES ($1, 'api', 'x')",
          [orgB.organizationId]
        ),
      "23514",
      "a reserved address in the database",
      "public_catalog_profiles_slug_allowed"
    );
    for (const reserved of RESERVED_SLUGS.filter((name) => name.length >= 3)) {
      // biome-ignore lint/performance/noAwaitInLoops: One probe per reserved name, in order.
      await expectSqlState(
        () =>
          admin.pool.query(
            "INSERT INTO public.public_catalog_profiles (organization_id, slug, public_name) VALUES ($1, $2, 'x')",
            [orgB.organizationId, reserved]
          ),
        "23514",
        `the database reserves ${reserved} as the domain does`,
        "public_catalog_profiles_slug_allowed"
      );
    }
    // two first saves at once: one wins, the other is a conflict (never a raw error)
    const raceOrg = await pro("catalog race");
    const raceSlug = `loja-r-${randomUUID().slice(0, 8)}`;
    const race = await Promise.allSettled([
      asPublisher(raceOrg, (tx, identity) =>
        savePublicCatalogProfile(tx, identity, profileInput(raceSlug))
      ),
      asPublisher(raceOrg, (tx, identity) =>
        savePublicCatalogProfile(tx, identity, profileInput(raceSlug))
      ),
    ]);
    assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
    const lost = race.find((r) => r.status === "rejected");
    assert.ok(
      lost?.status === "rejected" &&
        (lost.reason instanceof PublicCatalogVersionConflictError ||
          lost.reason instanceof PublicCatalogSlugTakenError),
      "the second save is a refusal of the domain"
    );
    // an edit names the version it started from
    const edited = await asPublisher(orgA, (tx, identity) =>
      savePublicCatalogProfile(tx, identity, {
        ...profileInput(slugA),
        expectedVersion: 1,
        publicName: "Loja A Renomeada",
      })
    );
    assert.equal(edited.version, 2);
    await assert.rejects(
      () =>
        asPublisher(orgA, (tx, identity) =>
          savePublicCatalogProfile(tx, identity, {
            ...profileInput(slugA),
            expectedVersion: 1,
          })
        ),
      PublicCatalogVersionConflictError
    );
    await assert.rejects(
      () =>
        asPublisher(orgA, (tx, identity) =>
          savePublicCatalogProfile(tx, identity, profileInput(slugA))
        ),
      PublicCatalogVersionConflictError,
      "creating a profile that exists is a conflict"
    );
    tests.push(
      "a Free organization can neither take an address nor show a product and the capability to publish is its own; a Pro one saves a profile (normalized, unique across every organization, no reserved address, in the command and in the database) and edits it by version"
    );

    // ------------------------------------------------- 3. products to show
    const p1 = await newProduct(orgA, "Vestido Azul");
    const p2 = await newProduct(orgA, "Blusa Simples");
    const p3 = await newProduct(orgA, "Saia que será arquivada");
    const p4 = await newProduct(orgA, "Calça que será removida");
    const p5 = await newProduct(orgA, "Cinto");
    const p6 = await newProduct(orgA, "Bolsa nunca publicada");
    // p1 has variants named by their options, and prices
    await as(orgA, "product:update", (tx, identity) =>
      configureProductVariants(tx, identity, {
        expectedVersion: p1.version,
        id: p1.id,
        options: [{ name: "color", values: ["Azul", "Preto"] }],
        requestId: randomUUID(),
        variants: [
          { values: { color: "Azul" } },
          { values: { color: "Preto" } },
        ],
      })
    );
    await admin.pool.query(
      `UPDATE public.product_variants AS variant
          SET list_price = CASE option_value.name WHEN 'Azul' THEN 129.90 ELSE 149.90 END,
              sku = 'SEGREDO-' || variant.id::text
         FROM public.variant_option_values AS chosen
         JOIN public.product_option_values AS option_value
           ON option_value.organization_id = chosen.organization_id
          AND option_value.id = chosen.option_value_id
        WHERE chosen.organization_id = variant.organization_id
          AND chosen.variant_id = variant.id
          AND variant.product_id = $1`,
      [p1.id]
    );
    await admin.pool.query(
      "UPDATE public.product_variants SET list_price = 49.00 WHERE product_id = $1",
      [p5.id]
    );
    const images: string[] = [];
    await as(orgA, "product:update", async (tx, identity) => {
      for (const productId of [p1.id, p1.id, p2.id]) {
        // biome-ignore lint/performance/noAwaitInLoops: Three images, in order.
        const media = await createProductMediaAsset(
          tx,
          identity,
          mediaInput(orgA.organizationId, productId)
        );
        images.push(media.asset.assetId);
      }
    });
    const [p1Image1, p1Image2, p2Image] = images as [string, string, string];

    await assert.rejects(
      () =>
        asPublisher(orgA, (tx, identity) =>
          publishProducts(tx, identity, { productIds: [randomUUID()] })
        ),
      PublicCatalogProductUnavailableError
    );
    await assert.rejects(
      () =>
        asPublisher(orgA, (tx, identity) =>
          publishProducts(tx, identity, { productIds: ["not-an-id"] })
        ),
      PublicCatalogProductUnavailableError,
      "a malformed product ID is a refusal, not a database error"
    );
    await assert.rejects(
      () =>
        asPublisher(orgA, (tx, identity) =>
          publishProducts(tx, identity, { productIds: [] })
        ),
      PublicCatalogProductUnavailableError
    );
    await assert.rejects(
      () =>
        asPublisher(orgB, (tx, identity) =>
          publishProducts(tx, identity, { productIds: [p1.id] })
        ),
      PublicCatalogProductUnavailableError,
      "another organization's product cannot be shown"
    );
    await asPublisher(orgA, (tx, identity) =>
      publishProducts(tx, identity, {
        productIds: [p1.id, p2.id, p3.id, p4.id, p5.id],
      })
    );
    // nothing is public until the organization turns the catalog on
    assert.equal(await profileOf(slugA), null);
    assert.equal(await productsOf(slugA), null);
    assert.equal(await productOf(slugA, p1.id), null);
    const switched = await asPublisher(orgA, (tx, identity) =>
      setPublicCatalogPublished(tx, identity, {
        expectedVersion: edited.version,
        published: true,
      })
    );
    assert.equal(switched.published, true);
    await assert.rejects(
      () =>
        asPublisher(orgA, (tx, identity) =>
          setPublicCatalogPublished(tx, identity, {
            expectedVersion: edited.version,
            published: false,
          })
        ),
      PublicCatalogVersionConflictError,
      "the switch names the version too"
    );
    const profile = await profileOf(slugA);
    assert.deepEqual(
      profile && Object.keys(profile).sort(),
      ["description", "instagram", "name", "slug", "whatsapp"],
      "only what the organization typed into its profile"
    );
    assert.equal(profile?.name, "Loja A Renomeada");
    assert.equal(profile?.whatsapp, "5511912345678");
    tests.push(
      "products to show must exist in the organization and be live, are chosen only with the plan, and nothing is public until the switch is on; the public profile carries exactly the typed fields"
    );

    // ------------------------------------------------- 4. what the public reads
    const list = (await productsOf(slugA)) as {
      next: string | null;
      products: {
        coverAssetId: string | null;
        id: string;
        name: string;
        priceFrom: string | null;
      }[];
    };
    const shownIds = list.products.map((product) => product.id);
    assert.equal(list.next, null);
    assert.deepEqual(
      [...shownIds].sort(),
      [p1.id, p2.id, p3.id, p4.id, p5.id].sort(),
      "all five are shown while they are live"
    );
    assert.deepEqual(shownIds, [...shownIds].sort().reverse(), "newest first");
    const byId = new Map(list.products.map((product) => [product.id, product]));
    assert.equal(byId.get(p1.id)?.priceFrom, "129.90", "the lowest list price");
    assert.equal(
      byId.get(p1.id)?.coverAssetId,
      p1Image1,
      "the first picture covers it"
    );
    assert.equal(byId.get(p5.id)?.priceFrom, "49.00");
    assert.equal(byId.get(p2.id)?.priceFrom, null, "no price is not a price");
    assert.deepEqual(
      Object.keys(list.products[0] ?? {}).sort(),
      ["coverAssetId", "description", "id", "name", "priceFrom"],
      "no cost, stock or SKU"
    );
    // archived and deleted stop being shown whatever the publication says
    await as(orgA, "product:update", (tx, identity) =>
      archiveProduct(tx, identity, {
        expectedVersion: p3.version,
        id: p3.id,
        requestId: randomUUID(),
      })
    );
    await as(orgA, "product:update", (tx, identity) =>
      deleteProduct(tx, identity, {
        expectedVersion: p4.version,
        id: p4.id,
        requestId: randomUUID(),
      })
    );
    const afterLifecycle = (await productsOf(slugA)) as typeof list;
    assert.deepEqual(
      afterLifecycle.products.map((product) => product.id).sort(),
      [p1.id, p2.id, p5.id].sort()
    );
    assert.equal(await productOf(slugA, p3.id), null);
    assert.equal(await productOf(slugA, p4.id), null);
    assert.equal(await productOf(slugA, p6.id), null, "never published");
    assert.equal(await productOf(slugA, randomUUID()), null);
    // pages
    const first = (await productsOf(slugA, 2)) as typeof list;
    assert.equal(first.products.length, 2);
    assert.ok(first.next);
    const second = (await productsOf(slugA, 2, first.next)) as typeof list;
    assert.equal(second.products.length, 1);
    assert.equal(second.next, null);
    assert.deepEqual(
      [...first.products, ...second.products].map((product) => product.id),
      afterLifecycle.products.map((product) => product.id),
      "pages follow the list"
    );
    for (const size of [0, 61, -1]) {
      // biome-ignore lint/performance/noAwaitInLoops: Three probes, in order.
      await expectSqlState(
        () => productsOf(slugA, size),
        "22023",
        `a page size of ${size}`
      );
    }
    // one product
    const detail = (await productOf(slugA, p1.id)) as {
      description: string | null;
      id: string;
      media: { assetId: string; height: number; width: number }[];
      name: string;
      variants: { id: string; label: string | null; price: string | null }[];
    };
    assert.deepEqual(Object.keys(detail).sort(), [
      "description",
      "id",
      "media",
      "name",
      "variants",
    ]);
    assert.equal(detail.name, "Vestido Azul");
    assert.deepEqual(
      detail.variants.map((variant) => [variant.label, variant.price]),
      [
        ["Azul", "129.90"],
        ["Preto", "149.90"],
      ]
    );
    assert.deepEqual(
      detail.variants.map((variant) => Object.keys(variant).sort()),
      [
        ["id", "label", "price"],
        ["id", "label", "price"],
      ],
      "a variant shows its label and price, never its SKU or stock"
    );
    assert.deepEqual(
      detail.media.map((image) => image.assetId),
      [p1Image1, p1Image2],
      "the pictures in order"
    );
    assert.ok(!JSON.stringify(detail).includes("SEGREDO"));
    // a list price of 0,00 is a price not informed (AC-12): the list and the page agree, and the data stays as the ERP wrote it
    const lowestPriceOnPage = async (productId: string) => {
      const page = (await productOf(slugA, productId)) as typeof detail;
      const prices = page.variants
        .map((variant) => variant.price)
        .filter((price): price is string => price !== null)
        .map(Number);
      return prices.length === 0 ? null : Math.min(...prices);
    };
    const expectListAgreesWithPages = async (why: string) => {
      const current = (await productsOf(slugA)) as typeof list;
      assert.ok(current.products.length > 0);
      for (const product of current.products) {
        // biome-ignore lint/performance/noAwaitInLoops: One page per product shown.
        const onPage = await lowestPriceOnPage(product.id);
        assert.equal(
          product.priceFrom === null ? null : Number(product.priceFrom),
          onPage,
          `${why}: the list says "a partir de" what the page of ${product.name} says`
        );
      }
      return new Map(current.products.map((product) => [product.id, product]));
    };
    await expectListAgreesWithPages("as the prices were typed");
    const setPrices = (productId: string, prices: string[]) =>
      admin.pool.query(
        `UPDATE public.product_variants AS variant
            SET list_price = prices.price
           FROM (
             SELECT id, (ARRAY[${prices.map((_, index) => `$${index + 2}::numeric`).join(", ")}])[row_number() OVER (ORDER BY position NULLS LAST, id)] AS price
               FROM public.product_variants
              WHERE product_id = $1
           ) AS prices
          WHERE variant.id = prices.id`,
        [productId, ...prices]
      );
    // 0,00 and 49,90: the list says from 49,90 and the page shows the 0,00 variant with no price
    await setPrices(p1.id, ["0.00", "49.90"]);
    const zeroAndPriced = await expectListAgreesWithPages("0,00 and 49,90");
    assert.equal(zeroAndPriced.get(p1.id)?.priceFrom, "49.90");
    const zeroAndPricedPage = (await productOf(slugA, p1.id)) as typeof detail;
    assert.deepEqual(
      zeroAndPricedPage.variants.map((variant) => [
        variant.label,
        variant.price,
      ]),
      [
        ["Azul", null],
        ["Preto", "49.90"],
      ],
      "a variant at 0,00 shows no price; the other keeps its own"
    );
    // only 0,00: no price at all, in the list and in the page (the product with one variant and the one with two)
    await setPrices(p1.id, ["0.00", "0.00"]);
    await setPrices(p5.id, ["0.00"]);
    const onlyZero = await expectListAgreesWithPages("only 0,00");
    assert.equal(onlyZero.get(p1.id)?.priceFrom, null);
    assert.equal(onlyZero.get(p5.id)?.priceFrom, null);
    assert.deepEqual(
      ((await productOf(slugA, p1.id)) as typeof detail).variants.map(
        (variant) => variant.price
      ),
      [null, null]
    );
    assert.deepEqual(
      ((await productOf(slugA, p5.id)) as typeof detail).variants.map(
        (variant) => variant.price
      ),
      [null]
    );
    // the data is untouched: the ERP, the sale and the export still read 0.00
    const stored = await admin.pool.query<{ list_price: string }>(
      "SELECT list_price::text FROM public.product_variants WHERE product_id = ANY($1::uuid[])",
      [[p1.id, p5.id]]
    );
    assert.deepEqual(
      stored.rows.map((row) => row.list_price),
      ["0.00", "0.00", "0.00"],
      "product_variants keeps the 0.00"
    );
    // back to the prices the later checks expect
    await setPrices(p1.id, ["129.90", "149.90"]);
    await setPrices(p5.id, ["49.00"]);
    const restored = await expectListAgreesWithPages("prices restored");
    assert.equal(restored.get(p1.id)?.priceFrom, "129.90");
    assert.equal(restored.get(p5.id)?.priceFrom, "49.00");
    tests.push(
      "a list price of 0,00 is not informed in the public catalog: with 0,00 and 49,90 the list says from 49,90 and the page shows the 0,00 variant with no price; with only 0,00 both say none; the data keeps the 0,00; and for every product of the list priceFrom equals the lowest price of its page"
    );
    // media: only a picture of a product that is shown
    const media = (await mediaOf(slugA, p1.id, p1Image1)) as {
      byteSize: number;
      contentType: string;
      storageKey: string;
    };
    assert.deepEqual(Object.keys(media).sort(), [
      "byteSize",
      "contentType",
      "storageKey",
    ]);
    assert.ok(media.storageKey.includes(orgA.organizationId));
    assert.equal(
      (await mediaOf(slugA, p2.id, p2Image))?.contentType,
      "image/webp"
    );
    assert.equal(
      await mediaOf(slugA, p2.id, p1Image1),
      null,
      "a picture under another product"
    );
    assert.equal(await mediaOf(slugA, p6.id, p1Image1), null);
    assert.equal(await mediaOf(slugA, p1.id, randomUUID()), null);
    assert.equal(await mediaOf("nao-existe", p1.id, p1Image1), null);
    // one organization's address never reaches another organization's rows
    const foreign = await newProduct(orgB, "Produto de outra organização");
    await asPublisher(orgB, (tx, identity) =>
      savePublicCatalogProfile(
        tx,
        identity,
        profileInput(`loja-b-${randomUUID().slice(0, 8)}`)
      )
    );
    await asPublisher(orgB, (tx, identity) =>
      publishProducts(tx, identity, { productIds: [foreign.id] })
    );
    assert.equal(await productOf(slugA, foreign.id), null);
    assert.equal(await mediaOf(slugA, foreign.id, p1Image1), null);
    assert.equal(
      ((await productsOf(slugA)) as typeof list).products.some(
        (product) => product.id === foreign.id
      ),
      false
    );
    // the address is looked up as it is stored: the application lowercases it first
    assert.equal(await profileOf(slugA.toUpperCase()), null);
    // a cursor that is not an ID is refused by the database before the function runs
    await expectSqlState(
      () => productsOf(slugA, 20, "not-an-id"),
      "22P02",
      "a malformed cursor"
    );
    // the reader the public app uses: the same answers, and no database error for bad input
    const viaReader = <T>(
      operation: (
        reader: ReturnType<typeof publicCatalogReaderOver>
      ) => Promise<T>
    ) => asCatalog((client) => operation(publicCatalogReaderOver(client)));
    assert.equal(
      (await viaReader((reader) => reader.profile(` ${slugA.toUpperCase()} `)))
        ?.slug,
      slugA,
      "the reader looks the address up in lowercase"
    );
    assert.equal(
      await viaReader((reader) => reader.product(slugA, "not-an-id")),
      null
    );
    assert.equal(
      await viaReader((reader) =>
        reader.products(slugA, { after: "not-an-id" })
      ),
      null
    );
    assert.equal(
      await viaReader((reader) => reader.media(slugA, p1.id, "not-an-id")),
      null
    );
    assert.equal(
      (
        (await viaReader((reader) =>
          reader.products(slugA, { limit: 500 })
        )) as typeof list
      ).products.length,
      3,
      "a page size beyond the limit is clamped, not refused"
    );
    assert.equal(
      (await viaReader((reader) => reader.product(slugA, p1.id.toUpperCase())))
        ?.id,
      p1.id
    );
    tests.push(
      "the public list is newest first in pages (size 1 to 60), shows the lowest list price, the cover and nothing about cost, stock or SKU; archived, deleted, never-published and unknown products are not shown; one product shows variant labels with prices and its pictures in order; a picture is found only for a product that is shown"
    );

    // ------------------------------------------------- 5. taking it down
    await asPublisher(orgA, (tx, identity) =>
      unpublishProducts(tx, identity, { productIds: [p2.id] })
    );
    assert.equal(await productOf(slugA, p2.id), null);
    assert.equal(
      await mediaOf(slugA, p2.id, p2Image),
      null,
      "its pictures go with it"
    );
    assert.deepEqual(
      ((await productsOf(slugA)) as typeof list).products
        .map((product) => product.id)
        .sort(),
      [p1.id, p5.id].sort()
    );
    const unpublishAgain = await asPublisher(orgA, (tx, identity) =>
      unpublishProducts(tx, identity, { productIds: [p2.id, p6.id] })
    );
    assert.equal(
      unpublishAgain.unpublished,
      0,
      "one that is not shown is left as it is"
    );
    await asPublisher(orgA, (tx, identity) =>
      publishProducts(tx, identity, { productIds: [p2.id] })
    );
    assert.ok(
      await productOf(slugA, p2.id),
      "choosing it again shows it again"
    );
    const off = await asPublisher(orgA, (tx, identity) =>
      setPublicCatalogPublished(tx, identity, {
        expectedVersion: switched.version,
        published: false,
      })
    );
    assert.equal(await profileOf(slugA), null);
    assert.equal(await productsOf(slugA), null);
    assert.equal(await mediaOf(slugA, p1.id, p1Image1), null);
    const on = await asPublisher(orgA, (tx, identity) =>
      setPublicCatalogPublished(tx, identity, {
        expectedVersion: off.version,
        published: true,
      })
    );
    assert.ok(await profileOf(slugA));
    assert.equal(on.published, true);
    const catalogEvents = await admin.pool.query<{
      entity_id: string;
      event_type: string;
    }>(
      `SELECT event_type, entity_id FROM public.tenant_audit_event
        WHERE organization_id = $1 AND event_type LIKE 'public_catalog.%'`,
      [orgA.organizationId]
    );
    const catalogTypes = new Set(catalogEvents.rows.map((r) => r.event_type));
    for (const type of [
      "public_catalog.profile_created",
      "public_catalog.published",
      "public_catalog.unpublished",
    ]) {
      assert.ok(catalogTypes.has(type), `${type} is audited`);
    }
    assert.ok(
      catalogEvents.rows.every((r) => r.entity_id === orgA.organizationId),
      "the catalog's events point at the catalog profile (keyed by the organization)"
    );
    const events = await admin.pool.query<{
      entity_id: string;
      event_type: string;
    }>(
      `SELECT event_type, entity_id FROM public.tenant_audit_event
        WHERE organization_id = $1 AND event_type LIKE 'product.%_catalog'`,
      [orgA.organizationId]
    );
    const eventsOf = (type: string, productId: string) =>
      events.rows.filter(
        (row) => row.event_type === type && row.entity_id === productId
      ).length;
    assert.equal(
      eventsOf("product.published_to_catalog", p2.id),
      2,
      "shown, then shown again"
    );
    assert.equal(eventsOf("product.unpublished_from_catalog", p2.id), 1);
    assert.equal(eventsOf("product.published_to_catalog", p1.id), 1);
    assert.equal(
      events.rows.filter((row) => row.entity_id === p6.id).length,
      0,
      "a product never shown has no event, and neither does taking down one that is not shown"
    );
    assert.deepEqual(
      await asPublisher(orgA, (tx, identity) =>
        publishProducts(tx, identity, { productIds: [p1.id, p2.id] })
      ),
      { published: 0 },
      "choosing what is already shown changes nothing"
    );
    tests.push(
      "taking a product down stops it and its pictures at once, taking it down twice is one, choosing it again shows it again, and the organization's own switch turns everything off and on"
    );

    // ------------------------------------------------- 6. the plan, at every read
    await admin.pool.query(
      "UPDATE public.organization_billing SET state = 'free_over_limit', access_ends_at = NULL WHERE organization_id = $1",
      [orgA.organizationId]
    );
    assert.equal(
      await profileOf(slugA),
      null,
      "a downgrade unpublishes at once"
    );
    assert.equal(await productsOf(slugA), null);
    assert.equal(await mediaOf(slugA, p1.id, p1Image1), null);
    // nothing was erased: the setup is as it was, and the plan alone decides
    const kept = await asPublisher(orgA, (tx, identity) =>
      readPublicCatalogSetup(tx, identity)
    );
    assert.equal(kept.enabled, false);
    assert.equal(kept.profile?.published, true);
    assert.equal(
      kept.publishedProductIds.length,
      5,
      "the choices are kept, even those of products archived or deleted since"
    );
    // and with the plan back it is shown again, untouched
    await admin.pool.query(
      "UPDATE public.organization_billing SET state = 'active', access_ends_at = now() + interval '30 days' WHERE organization_id = $1",
      [orgA.organizationId]
    );
    assert.ok(await profileOf(slugA), "an upgrade shows it again");
    // a closed or suspended account is not shown
    for (const status of ["suspended", "closed"]) {
      // biome-ignore lint/performance/noAwaitInLoops: Two states, in order.
      await admin.pool.query(
        "UPDATE public.organizations SET status = $2 WHERE id = $1",
        [orgA.organizationId, status]
      );
      assert.equal(await profileOf(slugA), null, `${status} is not shown`);
      assert.equal(await mediaOf(slugA, p1.id, p1Image1), null);
    }
    await admin.pool.query(
      "UPDATE public.organizations SET status = 'active' WHERE id = $1",
      [orgA.organizationId]
    );
    assert.ok(await profileOf(slugA));
    tests.push(
      "the plan is read at every call: a downgrade stops everything with no write, an upgrade restores it untouched, and a suspended or closed account is not shown"
    );

    // ------------------------------------------------- 7. the same rule as the entitlement engine
    const parity = await free("catalog parity");
    const slugP = `loja-p-${randomUUID().slice(0, 8)}`;
    await admin.pool.query(
      "INSERT INTO public.public_catalog_profiles (organization_id, slug, public_name, published, published_at) VALUES ($1, $2, 'Paridade', true, now())",
      [parity.organizationId, slugP]
    );
    const states = [
      ["free", null],
      ["free_over_limit", null],
      ["trial_setup", null],
      ["trialing", "+10 days"],
      ["trialing", "-1 day"],
      ["active", "+30 days"],
      ["active", "-1 day"],
      ["grace", "+3 days"],
      ["grace", "-1 day"],
    ] as const;
    const grantCases = [
      ["none", null],
      ["running", { expires: "+5 days", revoked: null, start: "-1 day" }],
      ["expired", { expires: "-1 hour", revoked: null, start: "-5 days" }],
      ["future", { expires: "+9 days", revoked: null, start: "+2 days" }],
      [
        "revoked after it started",
        { expires: "-1 hour", revoked: "-1 hour", start: "-5 days" },
      ],
      [
        "revoked before it started",
        { expires: "+2 days", revoked: "+1 day", start: "+1 day" },
      ],
    ] as const;
    const at = (shift: string) =>
      `now() + interval '${shift.replace("+", "").replace("-", "- ")}'`;
    const instant = async (shift: string) =>
      (await admin.pool.query<{ value: Date }>(`SELECT ${at(shift)} AS value`))
        .rows[0]?.value as Date;
    let compared = 0;
    for (const [state, accessEnds] of states) {
      for (const [grantLabel, grant] of grantCases) {
        // biome-ignore lint/performance/noAwaitInLoops: One case at a time against one organization.
        await admin.pool
          .query(
            `UPDATE public.organization_billing SET state = $2, access_ends_at = ${accessEnds === null ? "NULL" : at(accessEnds)},
                  trial_started_at = CASE WHEN $2 = 'trialing' THEN now() END,
                  cancel_at_period_end = false, cycle_months = CASE WHEN $2 IN ('trialing', 'active', 'grace') THEN 1 END, pending_cycle_months = NULL,
                  revoked_through = NULL, revoked_reason = NULL, revoked_cycle_months = NULL, revoked_cancel_at_period_end = false
            WHERE organization_id = $1`,
            [parity.organizationId, state]
          )
          .then((result) => {
            if (result.rowCount === 0) {
              return admin.pool.query(
                `INSERT INTO public.organization_billing (organization_id, state, access_ends_at, trial_started_at, cycle_months)
               VALUES ($1, $2, ${accessEnds === null ? "NULL" : at(accessEnds)}, CASE WHEN $2 = 'trialing' THEN now() END, CASE WHEN $2 IN ('trialing', 'active', 'grace') THEN 1 END)`,
                [parity.organizationId, state]
              );
            }
            return result;
          });
        await admin.pool.query(
          "DELETE FROM public.entitlement_grants WHERE organization_id = $1",
          [parity.organizationId]
        );
        if (grant) {
          await admin.pool.query(
            `INSERT INTO public.entitlement_grants (organization_id, key, flag_value, reason, granted_by, starts_at, expires_at, revoked_at, revoked_by)
             VALUES ($1, 'public_catalog', true, 'gate', 'gate', ${at(grant.start)}, ${at(grant.expires)}, ${grant.revoked === null ? "NULL" : at(grant.revoked)}, ${grant.revoked === null ? "NULL" : "'gate'"})`,
            [parity.organizationId]
          );
        }
        const served = (await profileOf(slugP)) !== null;
        const effective = resolveEntitlements({
          catalog: INITIAL_PLAN_CATALOG,
          facts: {
            accessEndsAt:
              accessEnds === null ? null : await instant(accessEnds),
            state,
          },
          grants:
            grant && !(grant.revoked !== null && grant.revoked >= grant.start)
              ? [
                  {
                    expiresAt: await instant(grant.expires),
                    key: "public_catalog",
                    startsAt: await instant(grant.start),
                    value: true,
                  },
                ]
              : [],
          now: new Date(),
        });
        assert.equal(
          served,
          effective.values.public_catalog,
          `${state} (${accessEnds ?? "no access end"}) with a grant that is ${grantLabel}: the database and the entitlement engine agree`
        );
        compared += 1;
      }
    }
    assert.equal(compared, states.length * grantCases.length);
    tests.push(
      `the plan check in the database gives the same answer as the entitlement engine in ${compared} combinations of billing state, end of access and grant (running, expired, not yet started, revoked before and after starting)`
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
    for (const [role, group] of [
      [loginRole, runtimeRole],
      [catalogLoginRole, "polaris_catalog_runtime"],
    ] as const) {
      if (role) {
        // biome-ignore lint/performance/noAwaitInLoops: Two cleanups, in order.
        await admin.pool.query(`REVOKE "${group}" FROM "${role}"`);
        await admin.pool.query(`DROP ROLE IF EXISTS "${role}"`);
      }
    }
    await admin.pool.end();
  }
}

run().catch((error: unknown) => {
  console.error(
    `Public catalog PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
