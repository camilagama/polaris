import { createHash } from "node:crypto";
import type { PolarisRpcClient } from "@polaris/contracts";
import { localDate } from "../calendar";
import { createJourneyUser, expect, runT0, test } from "../fixtures";
import { journeyName } from "../journey-names";
import { seedProduct, seedStock } from "../seed";

const ZONE = "America/Sao_Paulo";
const COST = "12.50";
const STOCK = 7;
const PAGE_SIZE = 60;
const ZERO_PRICE = /"(?:priceFrom|price)":"0/;

type Sql = Parameters<Parameters<typeof test>[2]>[0]["sql"];

const PROFILE_KEYS = ["description", "instagram", "name", "slug", "whatsapp"];
const LIST_KEYS = ["next", "products"];
const LIST_PRODUCT_KEYS = [
  "coverAssetId",
  "description",
  "id",
  "name",
  "priceFrom",
];
const DETAIL_KEYS = ["description", "id", "media", "name", "variants"];
const DETAIL_VARIANT_KEYS = ["id", "label", "price"];

interface PublicProfile {
  description: string | null;
  instagram: string | null;
  name: string;
  slug: string;
  whatsapp: string | null;
}

interface PublicList {
  next: string | null;
  products: {
    coverAssetId: string | null;
    description: string | null;
    id: string;
    name: string;
    priceFrom: string | null;
  }[];
}

interface PublicDetail {
  description: string | null;
  id: string;
  media: unknown[];
  name: string;
  variants: { id: string; label: string | null; price: string | null }[];
}

interface Store {
  email: string;
  organizationId: string;
  ownerId: string;
  rpc: PolarisRpcClient;
  slug: string;
  storeName: string;
}

/** The public address of a journey: unique in the run (the journey name and the run id), 3 to 40 lowercase characters. */
function slugOf(journey: string): string {
  const digest = createHash("sha256")
    .update(`${process.env.E2E_RUN_ID ?? ""}/${journey}`)
    .digest("hex")
    .slice(0, 12);
  return `leitura-${digest}`;
}

/** Offline and the public catalog are Pro: the billing record of an active subscription, as the other journeys write it. */
async function setPlan(
  sql: Sql,
  organizationId: string,
  plan: "free" | "pro"
): Promise<void> {
  await sql.query(
    `UPDATE organization_billing
        SET access_ends_at = now() + CASE WHEN $2 THEN interval '365 days' ELSE interval '-1 day' END
      WHERE organization_id = $1`,
    [organizationId, plan === "pro"]
  );
}

async function makePro(sql: Sql, organizationId: string): Promise<void> {
  await sql.query(
    `INSERT INTO organization_billing (organization_id, state, access_ends_at, cycle_months)
     VALUES ($1, 'active', now() + interval '365 days', 1)`,
    [organizationId]
  );
}

async function publicProfile(
  sql: Sql,
  slug: string
): Promise<PublicProfile | null> {
  const { rows } = await sql.query<{ result: PublicProfile | null }>(
    "SELECT public.public_catalog_profile($1) AS result",
    [slug]
  );
  return rows[0]?.result ?? null;
}

async function publicList(sql: Sql, slug: string): Promise<PublicList | null> {
  const { rows } = await sql.query<{ result: PublicList | null }>(
    "SELECT public.public_catalog_products($1, $2, NULL::uuid) AS result",
    [slug, PAGE_SIZE]
  );
  return rows[0]?.result ?? null;
}

async function publicDetail(
  sql: Sql,
  slug: string,
  productId: string
): Promise<PublicDetail | null> {
  const { rows } = await sql.query<{ result: PublicDetail | null }>(
    "SELECT public.public_catalog_product($1, $2::uuid) AS result",
    [slug, productId]
  );
  return rows[0]?.result ?? null;
}

async function shownIds(sql: Sql, slug: string): Promise<string[]> {
  return ((await publicList(sql, slug))?.products ?? [])
    .map((product) => product.id)
    .sort();
}

/** What the store chose to show, as the tables hold it: the profile row and one row per chosen product, whole. */
async function storedChoice(sql: Sql, organizationId: string) {
  const profile = await sql.query(
    "SELECT to_jsonb(p) AS row FROM public_catalog_profiles p WHERE p.organization_id = $1",
    [organizationId]
  );
  const publications = await sql.query(
    "SELECT to_jsonb(x) AS row FROM product_publications x WHERE x.organization_id = $1 ORDER BY x.product_id",
    [organizationId]
  );
  return {
    profile: profile.rows.map((row: { row: unknown }) => row.row),
    publications: publications.rows.map((row: { row: unknown }) => row.row),
  };
}

/**
 * A Pro store with its public profile saved and switched on, through the commands (the screen is another journey's).
 * No browser: the journey is the commands and the SQL the Worker of the catalog sends.
 */
async function openStore(
  testInfo: Parameters<Parameters<typeof test>[2]>[1],
  sql: Sql,
  journey: string
) {
  const owner = await createJourneyUser(
    String(testInfo.project.use.baseURL),
    journeyName(
      testInfo.project.name,
      journey,
      testInfo.retry,
      testInfo.repeatEachIndex
    )
  );
  const { rpc } = owner;
  const created = await rpc.organization.createInitial({
    name: owner.name,
    timezone: ZONE,
  });
  const organizationId = created.organization.id;
  await makePro(sql, organizationId);
  const slug = slugOf(owner.name);
  const saved = await rpc.publicCatalog.saveProfile({
    description: "Importados escolhidos a dedo",
    instagram: "loja.leitura",
    organizationId,
    publicName: "Vitrine de leitura",
    slug,
    whatsapp: "5511999990000",
  });
  await rpc.publicCatalog.setPublished({
    expectedVersion: saved.version,
    organizationId,
    published: true,
  });
  const store: Store = {
    email: `${owner.name}@e2e.invalid`,
    organizationId,
    ownerId: owner.id,
    rpc,
    slug,
    storeName: owner.name,
  };
  return store;
}

/** A product of two variants (P and M) with the list prices given, `null` for none. */
async function seedTwoVariants(
  store: Store,
  name: string,
  prices: [string | null, string | null]
) {
  const { organizationId, rpc } = store;
  const product = await rpc.product.create({ name, organizationId });
  const initial = await rpc.product.getVariants({
    id: product.id,
    organizationId,
  });
  const configured = await rpc.product.configureVariants({
    expectedVersion: initial.productVersion,
    id: product.id,
    options: [{ name: "size", values: ["P", "M"] }],
    organizationId,
    variants: [{ values: { size: "P" } }, { values: { size: "M" } }],
  });
  const { configuration } = configured;
  const idOf = (size: string) => {
    const variant = configuration.variants.find((candidate) =>
      candidate.values.some((value) => value.optionValueName === size)
    );
    if (!variant) {
      throw new Error(`The product ${name} has no variant ${size}.`);
    }
    return variant.id;
  };
  const variantIds = { M: idOf("M"), P: idOf("P") };
  const setPrice = (
    version: number,
    variantId: string,
    listPrice: string | null
  ) =>
    rpc.product.setVariantListPrice({
      expectedVersion: version,
      listPrice,
      organizationId,
      productId: product.id,
      variantId,
    });
  const afterP = await setPrice(
    configuration.productVersion,
    variantIds.P,
    prices[0]
  );
  await setPrice(afterP.configuration.productVersion, variantIds.M, prices[1]);
  return { productId: product.id, variantIds };
}

/** Every value of a JSON document, with the keys on the way: what a visitor could read, wherever it sits. */
function leaves(
  value: unknown,
  path = "$"
): { path: string; value: unknown }[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => leaves(item, `${path}[${index}]`));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) =>
      leaves(item, `${path}.${key}`)
    );
  }
  return [{ path, value }];
}

function keysOf(value: object): string[] {
  return Object.keys(value).sort();
}

/**
 * AC-3.1 (only what was chosen is served) and AC-3.2 (only what is allowed): the three `public_catalog_*` read functions the
 * catalog Worker calls for the profile, the list and the detail (the media one needs R2, which the stack has not), run here with the owner connection of the run (the same SQL the Worker sends). Three products,
 * two chosen: the list holds those two and the detail of the third is empty. What comes out has a fixed set of keys
 * and, in no key and no value, the cost, the balance, the SKU, the store id or anything of the owner that was seeded.
 */
test("catálogo público lido pelo banco: só os produtos escolhidos, e nada de custo, saldo, SKU, id da loja ou dado do dono", async ({
  sql,
}, testInfo) => {
  const store = await openStore(
    testInfo,
    sql,
    "catalogo-publico-leitura-escolhido"
  );
  const { organizationId, rpc, slug } = store;
  const today = localDate(runT0(), ZONE);

  const bag = await seedProduct(rpc, organizationId, "Bolsa de couro", "89.00");
  const wallet = await seedProduct(rpc, organizationId, "Carteira", "35.00");
  const belt = await seedProduct(rpc, organizationId, "Cinto reserva", "20.00");
  const stocked = (product: typeof bag, sku: string) =>
    seedStock(rpc, organizationId, product.variantId, STOCK, COST, today)
      .then(() =>
        rpc.product.getVariants({ id: product.productId, organizationId })
      )
      .then((configuration) =>
        rpc.product.setVariantSku({
          expectedVersion: configuration.productVersion,
          organizationId,
          productId: product.productId,
          sku,
          variantId: product.variantId,
        })
      );
  const skus = [
    `SKU-BOLSA-${slug}`,
    `SKU-CARTEIRA-${slug}`,
    `SKU-CINTO-${slug}`,
  ];
  await Promise.all([
    stocked(bag, skus[0] as string),
    stocked(wallet, skus[1] as string),
    stocked(belt, skus[2] as string),
  ]);

  await rpc.publicCatalog.publishProducts({
    organizationId,
    productIds: [bag.productId, wallet.productId],
  });

  // AC-3.1: the list has the two chosen, the third is not served by the detail either
  await expect
    .poll(() => shownIds(sql, slug))
    .toEqual([bag.productId, wallet.productId].sort());
  expect(await publicDetail(sql, slug, belt.productId)).toBeNull();
  const bagDetail = await publicDetail(sql, slug, bag.productId);
  expect(bagDetail?.name).toBe("Bolsa de couro");
  const list = await publicList(sql, slug);
  expect(list?.products.map((product) => product.name).sort()).toEqual([
    "Bolsa de couro",
    "Carteira",
  ]);
  expect(list?.next).toBeNull();
  // the functions look the address up as written: the Worker lowercases what a visitor typed (`parseSlug`) before it asks
  expect(await publicProfile(sql, slug.toUpperCase())).toBeNull();
  expect(await publicProfile(sql, slug)).not.toBeNull();

  // AC-3.2: the helper that returns the store's id is not callable by the role of the public app; the three reads are
  const executable = async (signature: string) =>
    (
      await sql.query<{ allowed: boolean }>(
        "SELECT has_function_privilege('polaris_catalog_runtime', $1, 'EXECUTE') AS allowed",
        [`public.${signature}`]
      )
    ).rows[0]?.allowed;
  expect(await executable("public_catalog_visible_organization(text)")).toBe(
    false
  );
  const reads = [
    "public_catalog_profile(text)",
    "public_catalog_products(text, integer, uuid)",
    "public_catalog_product(text, uuid)",
  ];
  expect(await Promise.all(reads.map(executable))).toEqual([true, true, true]);

  // AC-3.2: the keys, one set per function and nothing else
  const profile = await publicProfile(sql, slug);
  const detail = await publicDetail(sql, slug, wallet.productId);
  expect(profile).toEqual({
    description: "Importados escolhidos a dedo",
    instagram: "loja.leitura",
    name: "Vitrine de leitura",
    slug,
    whatsapp: "5511999990000",
  });
  expect(keysOf(profile as object)).toEqual(PROFILE_KEYS);
  expect(keysOf(list as object)).toEqual(LIST_KEYS);
  for (const product of (list as PublicList).products) {
    expect(keysOf(product)).toEqual(LIST_PRODUCT_KEYS);
  }
  expect(keysOf(detail as object)).toEqual(DETAIL_KEYS);
  expect((detail as PublicDetail).variants.length).toBeGreaterThan(0);
  for (const variant of (detail as PublicDetail).variants) {
    expect(keysOf(variant)).toEqual(DETAIL_VARIANT_KEYS);
  }

  // AC-3.2: the seeded values are in no column and no part of the JSON
  const forbidden = [
    store.organizationId,
    store.ownerId,
    store.email,
    store.storeName,
    ...skus,
    "12.5",
    "12,50",
  ];
  const served = [
    { document: profile, label: "public_catalog_profile" },
    { document: list, label: "public_catalog_products" },
    { document: bagDetail, label: "public_catalog_product (bag)" },
    { document: detail, label: "public_catalog_product (wallet)" },
  ];
  for (const { document, label } of served) {
    const text = JSON.stringify(document);
    for (const value of forbidden) {
      expect(text, `${label} must not carry ${value}`).not.toContain(value);
    }
    for (const leaf of leaves(document)) {
      expect(
        [STOCK, String(STOCK)],
        `${label} ${leaf.path} must not be the balance`
      ).not.toContain(leaf.value);
    }
  }
});

/**
 * AC-3.3: the list price never comes out as zero. Variants at 0,00 and 49,90: the product is "from 49,90" and the
 * variant at 0,00 has no price (null, never "0.00"); every variant at 0,00, or none with a price: no price in the list
 * and none in the detail.
 */
test("catálogo público lido pelo banco: preço 0,00 nunca sai como zero, e sem preço informado o produto sai sem preço", async ({
  sql,
}, testInfo) => {
  const store = await openStore(
    testInfo,
    sql,
    "catalogo-publico-leitura-preco"
  );
  const { organizationId, rpc, slug } = store;

  const mixed = await seedTwoVariants(store, "Camiseta mista", [
    "0.00",
    "49.90",
  ]);
  const allZero = await seedTwoVariants(store, "Camiseta toda a zero", [
    "0.00",
    "0.00",
  ]);
  const unpriced = await seedProduct(
    rpc,
    organizationId,
    "Camiseta sem preço",
    null
  );
  await rpc.publicCatalog.publishProducts({
    organizationId,
    productIds: [mixed.productId, allZero.productId, unpriced.productId],
  });

  await expect.poll(() => shownIds(sql, slug)).toHaveLength(3);
  const list = (await publicList(sql, slug)) as PublicList;
  const priceFrom = (id: string) =>
    list.products.find((product) => product.id === id)?.priceFrom;
  expect(priceFrom(mixed.productId)).toBe("49.90");
  expect(priceFrom(allZero.productId)).toBeNull();
  expect(priceFrom(unpriced.productId)).toBeNull();
  expect(JSON.stringify(list)).not.toMatch(ZERO_PRICE);

  const mixedDetail = (await publicDetail(
    sql,
    slug,
    mixed.productId
  )) as PublicDetail;
  const priceOf = (detail: PublicDetail, label: string) =>
    detail.variants.find((variant) => variant.label === label)?.price;
  expect(mixedDetail.variants.map((variant) => variant.label).sort()).toEqual([
    "M",
    "P",
  ]);
  expect(priceOf(mixedDetail, "P")).toBeNull();
  expect(priceOf(mixedDetail, "M")).toBe("49.90");

  const zeroDetail = (await publicDetail(
    sql,
    slug,
    allZero.productId
  )) as PublicDetail;
  expect(zeroDetail.variants).toHaveLength(2);
  for (const variant of zeroDetail.variants) {
    expect(variant.price).toBeNull();
  }
  const unpricedDetail = (await publicDetail(
    sql,
    slug,
    unpriced.productId
  )) as PublicDetail;
  expect(unpricedDetail.variants).toHaveLength(1);
  expect(unpricedDetail.variants[0]?.price).toBeNull();

  // the data is not rewritten: the ERP still holds the 0,00 that was typed
  const stored = async (productId: string) =>
    (
      await sql.query<{ list_price: string }>(
        `SELECT list_price::text FROM product_variants
          WHERE organization_id = $1 AND product_id = $2 ORDER BY list_price`,
        [organizationId, productId]
      )
    ).rows.map((row) => Number(row.list_price));
  expect(await stored(allZero.productId)).toEqual([0, 0]);
  expect(await stored(mixed.productId)).toEqual([0, 49.9]);
});

/**
 * AC-3.4: the plan in force at the moment of the request decides. The store falls to Free (the end of its paid
 * access moves to yesterday, the way a lapsed subscription counts as Free before any record changes): the functions
 * answer nothing for the profile and the products, and no row of the profile, the switch or the choice changes; with
 * Pro back (the end date in the future) the same read gives the same two products, with nothing configured again.
 */
test("catálogo público lido pelo banco: caindo para o Free nada é servido e nada é gravado, e com o Pro volta a mesma leitura", async ({
  sql,
}, testInfo) => {
  const store = await openStore(
    testInfo,
    sql,
    "catalogo-publico-leitura-plano"
  );
  const { organizationId, rpc, slug } = store;
  const first = await seedProduct(rpc, organizationId, "Anel", "120.00");
  const second = await seedProduct(rpc, organizationId, "Brinco", "60.00");
  await seedProduct(rpc, organizationId, "Colar", "75.00");
  await rpc.publicCatalog.publishProducts({
    organizationId,
    productIds: [first.productId, second.productId],
  });
  const chosen = [first.productId, second.productId].sort();

  await expect.poll(() => shownIds(sql, slug)).toEqual(chosen);
  const servedBefore = {
    first: await publicDetail(sql, slug, first.productId),
    list: await publicList(sql, slug),
    profile: await publicProfile(sql, slug),
  };
  const storedBefore = await storedChoice(sql, organizationId);
  expect(storedBefore.profile).toHaveLength(1);
  expect(storedBefore.publications).toHaveLength(2);

  await setPlan(sql, organizationId, "free");
  await expect.poll(() => publicProfile(sql, slug)).toBeNull();
  await expect.poll(() => publicList(sql, slug)).toBeNull();
  expect(await publicDetail(sql, slug, first.productId)).toBeNull();
  expect(await publicDetail(sql, slug, second.productId)).toBeNull();
  await expect
    .poll(() => storedChoice(sql, organizationId))
    .toEqual(storedBefore);

  await setPlan(sql, organizationId, "pro");
  await expect.poll(() => shownIds(sql, slug)).toEqual(chosen);
  expect({
    first: await publicDetail(sql, slug, first.productId),
    list: await publicList(sql, slug),
    profile: await publicProfile(sql, slug),
  }).toEqual(servedBefore);
  expect(await storedChoice(sql, organizationId)).toEqual(storedBefore);
});

/**
 * AC-3.5: the switch and the product. With the catalog switched off nothing is served and the choice stays; switched
 * on again, the same products come back. An archived product leaves the reading and restoring it brings it back,
 * without choosing it again: the choice was never erased.
 */
test("catálogo público lido pelo banco: desligado não serve nada, e o produto arquivado sai da leitura e volta ao ser restaurado", async ({
  sql,
}, testInfo) => {
  const store = await openStore(
    testInfo,
    sql,
    "catalogo-publico-leitura-interruptor"
  );
  const { organizationId, rpc, slug } = store;
  const first = await seedProduct(rpc, organizationId, "Pulseira", "40.00");
  const second = await seedProduct(
    rpc,
    organizationId,
    "Tornozeleira",
    "30.00"
  );
  await rpc.publicCatalog.publishProducts({
    organizationId,
    productIds: [first.productId, second.productId],
  });
  const both = [first.productId, second.productId].sort();
  await expect.poll(() => shownIds(sql, slug)).toEqual(both);
  const stored = await storedChoice(sql, organizationId);

  // the switch off: nothing is served, nothing of the choice changes but the switch itself
  const setup = await rpc.publicCatalog.setup({ organizationId });
  const profileVersion = setup.profile?.version as number;
  const off = await rpc.publicCatalog.setPublished({
    expectedVersion: profileVersion,
    organizationId,
    published: false,
  });
  await expect.poll(() => publicProfile(sql, slug)).toBeNull();
  expect(await publicList(sql, slug)).toBeNull();
  expect(await publicDetail(sql, slug, first.productId)).toBeNull();
  expect((await storedChoice(sql, organizationId)).publications).toEqual(
    stored.publications
  );
  await rpc.publicCatalog.setPublished({
    expectedVersion: off.version,
    organizationId,
    published: true,
  });
  await expect.poll(() => shownIds(sql, slug)).toEqual(both);

  // archiving a chosen product takes it out of the list and the detail; the publication row stays
  const configuration = await rpc.product.getVariants({
    id: first.productId,
    organizationId,
  });
  const archived = await rpc.product.archive({
    expectedVersion: configuration.productVersion,
    id: first.productId,
    organizationId,
  });
  await expect.poll(() => shownIds(sql, slug)).toEqual([second.productId]);
  expect(await publicDetail(sql, slug, first.productId)).toBeNull();
  expect((await storedChoice(sql, organizationId)).publications).toEqual(
    stored.publications
  );

  // restoring it brings it back: the choice was not erased and is not made again
  await rpc.product.restore({
    expectedVersion: archived.product.version,
    id: first.productId,
    organizationId,
  });
  await expect.poll(() => shownIds(sql, slug)).toEqual(both);
  expect((await publicDetail(sql, slug, first.productId))?.name).toBe(
    "Pulseira"
  );
  expect((await storedChoice(sql, organizationId)).publications).toEqual(
    stored.publications
  );
});
