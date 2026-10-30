import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MAX_PRODUCT_OPTION_VALUE_LENGTH,
  MAX_PRODUCT_VARIANT_SKU_LENGTH,
} from "@polaris/domain/catalog/product";
import type { PoolClient } from "pg";
import { createDatabase } from "../src/client";
import {
  createTenantFixture,
  disposableHostPattern,
  expectSqlState,
  gateBranchPattern,
  journalMigrationCount,
  poolerPattern,
  redactedFailure,
  requiredEnvironment,
  type TenantFixture,
} from "./sales-gate-support";

/**
 * Size ceilings of the catalog in the database (0107): an option value of at most 80 and a SKU of at most 64 code
 * points, the numbers of the domain. This gate proves, on the database after every migration: both constraints are
 * there, validated, and carry the domain number; the limit is counted in code points (an emoji is one, as in the
 * domain), not in bytes or UTF-16 units; a NULL SKU stays accepted; the migration replayed over a table of rows within
 * the ceilings leaves the constraints validated, and over a legacy row above one it fails naming the constraint and
 * changes nothing; and the read-only count a person runs before applying it later sees that row. Every fixture is
 * written in a transaction that is rolled back.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";
const CHECK_VIOLATION = "23514";
const VALUE_CHECK = "product_option_values_name_max_length";
const SKU_CHECK = "product_variants_sku_max_length";
const EMOJI = "\u{1F600}";
const FAMILY = "\u{1F468}‍\u{1F469}‍\u{1F467}";

const migrationStatements = readFileSync(
  new URL(
    "../drizzle/0107_limite_de_sku_e_valor_de_opcao.sql",
    import.meta.url
  ),
  "utf8"
)
  .split("--> statement-breakpoint")
  .map((statement) =>
    statement
      .split("\n")
      .filter((line) => !line.startsWith("--"))
      .join("\n")
      .trim()
  )
  .filter((statement) => statement.length > 0);

const legacyCount = `
  SELECT
    coalesce((SELECT max(char_length(name)) FROM public.product_option_values), 0)::int AS max_value,
    (SELECT count(*) FROM public.product_option_values WHERE char_length(name) > ${MAX_PRODUCT_OPTION_VALUE_LENGTH})::int AS over_value,
    coalesce((SELECT max(char_length(sku)) FROM public.product_variants), 0)::int AS max_sku,
    (SELECT count(*) FROM public.product_variants WHERE char_length(sku) > ${MAX_PRODUCT_VARIANT_SKU_LENGTH})::int AS over_sku`;

interface CatalogFixture {
  valueId: string;
  variantId: string;
}

async function replayMigration(client: PoolClient): Promise<void> {
  for (const statement of migrationStatements) {
    // biome-ignore lint/performance/noAwaitInLoops: the statements of one migration, in their order
    await client.query(statement);
  }
}

async function inRolledBackTransaction(
  owner: ReturnType<typeof createDatabase>,
  body: (client: PoolClient) => Promise<void>
): Promise<void> {
  const client = await owner.pool.connect();
  try {
    await client.query("BEGIN");
    await body(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function firstId(client: PoolClient, text: string, values: unknown[]) {
  const found = await client.query<{ id: string }>(text, values);
  const id = found.rows[0]?.id;
  assert.ok(id);
  return id;
}

/**
 * One configured product with a single variant and a single option value, built the way the domain commands leave it
 * (the default variant is replaced by the configured one), so the deferred product triggers hold when the constraints
 * are checked and the rows are changed by UPDATE.
 */
async function createCatalogFixture(
  client: PoolClient,
  tenant: TenantFixture
): Promise<CatalogFixture> {
  const org = tenant.organizationId;
  const productId = await firstId(
    client,
    "INSERT INTO public.products (organization_id, name) VALUES ($1, 'Produto do teto') RETURNING id",
    [org]
  );
  await client.query(
    "INSERT INTO public.product_variants (organization_id, product_id, is_default) VALUES ($1, $2, true)",
    [org, productId]
  );
  const optionId = await firstId(
    client,
    "INSERT INTO public.product_options (organization_id, product_id, name, position) VALUES ($1, $2, 'size', 2) RETURNING id",
    [org, productId]
  );
  const valueId = await firstId(
    client,
    "INSERT INTO public.product_option_values (organization_id, product_id, option_id, name, position) VALUES ($1, $2, $3, 'P', 0) RETURNING id",
    [org, productId, optionId]
  );
  const variantId = await firstId(
    client,
    "INSERT INTO public.product_variants (organization_id, product_id, is_default, position) VALUES ($1, $2, false, 0) RETURNING id",
    [org, productId]
  );
  await client.query(
    "INSERT INTO public.variant_option_values (organization_id, product_id, variant_id, option_id, option_value_id) VALUES ($1, $2, $3, $4, $5)",
    [org, productId, variantId, optionId, valueId]
  );
  await client.query(
    "DELETE FROM public.product_variants WHERE organization_id = $1 AND product_id = $2 AND is_default = true",
    [org, productId]
  );
  await client.query(
    "UPDATE public.products SET variants_configured_at = now() WHERE organization_id = $1 AND id = $2",
    [org, productId]
  );
  await client.query("SET CONSTRAINTS ALL IMMEDIATE");
  return { valueId, variantId };
}

function setValue(client: PoolClient, fixture: CatalogFixture, name: string) {
  return client.query(
    "UPDATE public.product_option_values SET name = $2 WHERE id = $1",
    [fixture.valueId, name]
  );
}

function setSku(
  client: PoolClient,
  fixture: CatalogFixture,
  sku: string | null
) {
  return client.query(
    "UPDATE public.product_variants SET sku = $2 WHERE id = $1",
    [fixture.variantId, sku]
  );
}

async function expectRefusedAndRecovered(
  client: PoolClient,
  attempt: () => Promise<unknown>,
  constraint: string,
  label: string
) {
  await client.query("SAVEPOINT attempt");
  await expectSqlState(attempt, CHECK_VIOLATION, label, constraint);
  await client.query("ROLLBACK TO SAVEPOINT attempt");
}

async function constraintStates(client: Pick<PoolClient, "query">) {
  const found = await client.query<{
    definition: string;
    name: string;
    validated: boolean;
  }>(
    `SELECT conname AS name, convalidated AS validated, pg_get_constraintdef(oid) AS definition
       FROM pg_catalog.pg_constraint
      WHERE conname = ANY($1::text[])
      ORDER BY conname`,
    [[VALUE_CHECK, SKU_CHECK]]
  );
  return found.rows;
}

async function proveCeilingsOnTheDatabase(
  owner: ReturnType<typeof createDatabase>,
  tenant: TenantFixture
) {
  await inRolledBackTransaction(owner, async (client) => {
    const fixture = await createCatalogFixture(client, tenant);
    const value = (name: string) => setValue(client, fixture, name);
    const sku = (text: string | null) => setSku(client, fixture, text);

    await value("a".repeat(MAX_PRODUCT_OPTION_VALUE_LENGTH));
    await expectRefusedAndRecovered(
      client,
      () => value("a".repeat(MAX_PRODUCT_OPTION_VALUE_LENGTH + 1)),
      VALUE_CHECK,
      "81 characters in an option value are refused"
    );
    await value(EMOJI.repeat(MAX_PRODUCT_OPTION_VALUE_LENGTH));
    await expectRefusedAndRecovered(
      client,
      () => value(EMOJI.repeat(MAX_PRODUCT_OPTION_VALUE_LENGTH + 1)),
      VALUE_CHECK,
      "81 emoji in an option value are refused"
    );
    // 5 code points each, though a person sees one: 16 of them are 80 code points, and 17 are 85
    await value(FAMILY.repeat(MAX_PRODUCT_OPTION_VALUE_LENGTH / 5));
    await expectRefusedAndRecovered(
      client,
      () => value(FAMILY.repeat(MAX_PRODUCT_OPTION_VALUE_LENGTH / 5 + 1)),
      VALUE_CHECK,
      "a sequence of joined emoji is counted by code point, not by what is seen"
    );

    await sku(null);
    await sku("S".repeat(MAX_PRODUCT_VARIANT_SKU_LENGTH));
    await expectRefusedAndRecovered(
      client,
      () => sku("S".repeat(MAX_PRODUCT_VARIANT_SKU_LENGTH + 1)),
      SKU_CHECK,
      "65 characters in a SKU are refused"
    );
    await sku(EMOJI.repeat(MAX_PRODUCT_VARIANT_SKU_LENGTH));
    await expectRefusedAndRecovered(
      client,
      () => sku(EMOJI.repeat(MAX_PRODUCT_VARIANT_SKU_LENGTH + 1)),
      SKU_CHECK,
      "65 emoji in a SKU are refused"
    );
  });
}

async function proveReplay(
  owner: ReturnType<typeof createDatabase>,
  tenant: TenantFixture
) {
  await inRolledBackTransaction(owner, async (client) => {
    const fixture = await createCatalogFixture(client, tenant);
    await setValue(client, fixture, "Azul-marinho");
    await setSku(client, fixture, "SKU-ANTIGO");
    await client.query(
      `ALTER TABLE public.product_option_values DROP CONSTRAINT ${VALUE_CHECK}`
    );
    await client.query(
      `ALTER TABLE public.product_variants DROP CONSTRAINT ${SKU_CHECK}`
    );
    assert.deepEqual(await constraintStates(client), []);
    await replayMigration(client);
    const after = await constraintStates(client);
    assert.equal(after.length, 2);
    assert.ok(after.every((state) => state.validated));
  });

  const legacyCases = [
    { constraint: VALUE_CHECK, overSku: 0, overValue: 1 },
    { constraint: SKU_CHECK, overSku: 1, overValue: 0 },
    { constraint: VALUE_CHECK, overSku: 1, overValue: 1 },
  ];
  for (const legacy of legacyCases) {
    // biome-ignore lint/performance/noAwaitInLoops: each case is its own rolled-back transaction
    await inRolledBackTransaction(owner, async (client) => {
      const fixture = await createCatalogFixture(client, tenant);
      await client.query(
        `ALTER TABLE public.product_option_values DROP CONSTRAINT ${VALUE_CHECK}`
      );
      await client.query(
        `ALTER TABLE public.product_variants DROP CONSTRAINT ${SKU_CHECK}`
      );
      if (legacy.overValue) {
        await setValue(
          client,
          fixture,
          "v".repeat(MAX_PRODUCT_OPTION_VALUE_LENGTH + 1)
        );
      }
      if (legacy.overSku) {
        await setSku(
          client,
          fixture,
          "k".repeat(MAX_PRODUCT_VARIANT_SKU_LENGTH + 1)
        );
      }
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      const counted = await client.query(legacyCount);
      assert.deepEqual(counted.rows[0], {
        max_sku: legacy.overSku ? MAX_PRODUCT_VARIANT_SKU_LENGTH + 1 : 0,
        max_value: legacy.overValue ? MAX_PRODUCT_OPTION_VALUE_LENGTH + 1 : 1,
        over_sku: legacy.overSku,
        over_value: legacy.overValue,
      });
      await client.query("SAVEPOINT replay");
      await expectSqlState(
        () => replayMigration(client),
        CHECK_VIOLATION,
        "the migration over a legacy row above a ceiling fails",
        legacy.constraint
      );
      await client.query("ROLLBACK TO SAVEPOINT replay");
      assert.deepEqual(
        await constraintStates(client),
        [],
        "and leaves no constraint behind"
      );
    });
  }
}

async function run() {
  const branch = requiredEnvironment("POLARIS_SALES_GATE_BRANCH");
  assert.match(branch, gateBranchPattern);
  const adminUrl = requiredEnvironment("POLARIS_SALES_GATE_DATABASE_URL");
  const parsedAdminUrl = new URL(adminUrl);
  assert.match(parsedAdminUrl.hostname, disposableHostPattern);
  assert.doesNotMatch(parsedAdminUrl.hostname, poolerPattern);

  const owner = createDatabase(adminUrl, { maxConnections: 2 });
  const tests: string[] = [];
  try {
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
    tests.push(
      "disposable direct connection is PostgreSQL 18 with every migration replayed from scratch"
    );

    const states = await constraintStates(owner.pool);
    assert.deepEqual(
      states.map((state) => [state.name, state.validated]),
      [
        [VALUE_CHECK, true],
        [SKU_CHECK, true],
      ]
    );
    assert.match(
      states.find((state) => state.name === VALUE_CHECK)?.definition ?? "",
      new RegExp(
        `char_length\\(name\\) <= ${MAX_PRODUCT_OPTION_VALUE_LENGTH}\\)`
      )
    );
    assert.match(
      states.find((state) => state.name === SKU_CHECK)?.definition ?? "",
      new RegExp(
        `sku IS NULL\\) OR \\(char_length\\(sku\\) <= ${MAX_PRODUCT_VARIANT_SKU_LENGTH}\\)`
      )
    );
    tests.push(
      "both constraints are validated and carry the numbers of the domain (80 and 64)"
    );

    const tenant = await createTenantFixture(owner.pool, "size-ceilings");
    await proveCeilingsOnTheDatabase(owner, tenant);
    tests.push(
      "an option value of 80 is accepted and 81 refused (23514, its constraint); a SKU of 64 is accepted, 65 refused, NULL accepted"
    );
    tests.push(
      "the limit is in code points like the domain: 80 and 81 emoji, and joined emoji sequences, are counted one code point at a time, for the option value and for the SKU"
    );

    await proveReplay(owner, tenant);
    tests.push(
      "replayed over rows within the ceilings the migration leaves both constraints validated; over a legacy value above its ceiling, a legacy SKU above its own, or both, it fails naming the constraint of the first one found (23514) and leaves nothing behind, and the read-only count sees those rows"
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
    await owner.pool.end();
  }
}

run().catch((error: unknown) => {
  console.error(
    `Catalog size ceilings PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
