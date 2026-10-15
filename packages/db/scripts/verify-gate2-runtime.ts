import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  CategoryDeletedError,
  CategoryInUseError,
  CategoryLifecycleError,
  CategoryNameConflictError,
} from "@polaris/domain/catalog/category";
import {
  InvalidVariantListPriceError,
  ProductCategoryUnavailableError,
  ProductDefaultVariantSkuConflictError,
  ProductVariantConfigurationError,
  ProductVariantNotFoundError,
  ProductVariantSkuConflictError,
  ProductVariantsAlreadyConfiguredError,
  ProductVersionConflictError,
} from "@polaris/domain/catalog/product";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import {
  archiveCategory,
  createCategory,
  deleteCategory,
  listCategories,
  renameCategory,
  restoreCategory,
} from "../src/category-repository";
import { createDatabase } from "../src/client";
import { createInitialOrganizationInDatabase } from "../src/organization-repository";
import {
  archiveProduct,
  configureProductVariants,
  createProduct,
  getProductVariants,
  listProducts,
  restoreProduct,
  setProductVariantListPrice,
  setProductVariantSku,
  updateProduct,
} from "../src/product-repository";
import { categories } from "../src/schema/category";
import { products } from "../src/schema/product";
import { withAuthorizedTenantTransaction } from "../src/tenant-transaction";

const gateDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const runtimeRole = "polaris_pr11_runtime";
const onboardingRole = "polaris_onboarding_runtime";
const expectedHost = /^ep-[a-z-]+-[a-z0-9]+\.c-2\.sa-east-1\.aws\.neon\.tech$/;
const sqlIdentifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const rollbackMessagePattern = /intentional Gate 2 rollback/;
const sqlStatePattern = /^[0-9A-Z]{5}$/;
const errorStackLineBreak = /\r?\n/;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error("Missing Gate 2 database configuration.");
  }
  return value;
}

function redactConnectionDetails(message: string, connectionString: string) {
  const { password } = new URL(connectionString);
  const withoutConnection = message.replaceAll(
    connectionString,
    "[redacted connection]"
  );
  return password
    ? withoutConnection.replaceAll(password, "[redacted password]")
    : withoutConnection;
}

function sqlState(error: unknown): string | undefined {
  const visited = new Set<object>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null) {
    if (visited.has(current)) {
      return undefined;
    }
    visited.add(current);
    const candidate = current as { cause?: unknown; code?: unknown };
    if (
      typeof candidate.code === "string" &&
      sqlStatePattern.test(candidate.code)
    ) {
      return candidate.code;
    }
    current = candidate.cause;
  }
  return undefined;
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

async function ensureSetRole(
  pool: ReturnType<typeof createDatabase>["pool"],
  roleName: string
): Promise<{ adminRole: string; canSet: boolean }> {
  const result = await pool.query<{
    adminRole: string;
    canSet: boolean;
  }>(
    'SELECT current_user AS "adminRole", ' +
      "pg_has_role(current_user, $1, 'SET') AS \"canSet\"",
    [roleName]
  );
  const [row] = result.rows;
  assert.ok(row);
  assert.match(row.adminRole, sqlIdentifierPattern);
  return { adminRole: row.adminRole, canSet: row.canSet };
}

async function expectForgedCategoryInsertDenied(
  client: Client,
  userId: string,
  organizationId: string
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(
      "SELECT set_config('app.user_id', $1, true), " +
        "set_config('app.organization_id', $2, true)",
      [userId, organizationId]
    );
    await expectSqlState(
      client.query(
        "INSERT INTO public.categories (organization_id, name) VALUES ($1, $2)",
        [organizationId, "forged category"]
      ),
      "42501",
      "category insert with forged context"
    );
  } finally {
    await client.query("ROLLBACK");
  }
}

async function expectForgedCategoryUpdateHidden(
  client: Client,
  userId: string,
  organizationId: string,
  categoryId: string
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(
      "SELECT set_config('app.user_id', $1, true), " +
        "set_config('app.organization_id', $2, true)",
      [userId, organizationId]
    );
    const result = await client.query(
      "UPDATE public.categories SET archived_at = now() WHERE id = $1",
      [categoryId]
    );
    assert.equal(
      result.rowCount,
      0,
      "forged tenant context must not update rows"
    );
  } finally {
    await client.query("ROLLBACK");
  }
}

async function expectCategoryHardDeleteDenied(
  client: Client,
  userId: string,
  organizationId: string,
  categoryId: string
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(
      "SELECT set_config('app.user_id', $1, true), " +
        "set_config('app.organization_id', $2, true)",
      [userId, organizationId]
    );
    await expectSqlState(
      client.query("DELETE FROM public.categories WHERE id = $1", [categoryId]),
      "42501",
      "tenant role cannot physically delete categories"
    );
  } finally {
    await client.query("ROLLBACK");
  }
}

async function expectCategoryTombstoneTriggerDenied(
  client: Client,
  userId: string,
  organizationId: string,
  categoryId: string
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(
      "SELECT set_config('app.user_id', $1, true), " +
        "set_config('app.organization_id', $2, true)",
      [userId, organizationId]
    );
    await expectSqlState(
      client.query(
        "UPDATE public.categories SET deleted_at = now() WHERE id = $1",
        [categoryId]
      ),
      "23503",
      "database trigger blocks tombstoning a category referenced by products"
    );
  } finally {
    await client.query("ROLLBACK");
  }
}

async function expectInactiveCategoryAssignmentDenied(
  client: Client,
  userId: string,
  organizationId: string,
  categoryId: string
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(
      "SELECT set_config('app.user_id', $1, true), " +
        "set_config('app.organization_id', $2, true)",
      [userId, organizationId]
    );
    await expectSqlState(
      client.query(
        "INSERT INTO public.products (organization_id, category_id, name) " +
          "VALUES ($1, $2, $3)",
        [organizationId, categoryId, "Direct archived category assignment"]
      ),
      "23503",
      "database trigger rejects assigning a new product to an archived category"
    );
  } finally {
    await client.query("ROLLBACK");
  }
}

async function expectProductVariantDeleteDenied(
  client: Client,
  userId: string,
  organizationId: string,
  productId: string
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(
      "SELECT set_config('app.user_id', $1, true), " +
        "set_config('app.organization_id', $2, true)",
      [userId, organizationId]
    );
    const result = await client.query(
      "DELETE FROM public.product_variants WHERE product_id = $1",
      [productId]
    );
    assert.equal(result.rowCount, 0);
  } finally {
    await client.query("ROLLBACK");
  }
}

async function expectDefaultVariantRemovalRequiresReplacement(
  client: Client,
  userId: string,
  organizationId: string,
  productId: string
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(
      "SELECT set_config('app.user_id', $1, true), " +
        "set_config('app.organization_id', $2, true)",
      [userId, organizationId]
    );
    const deleted = await client.query(
      "DELETE FROM public.product_variants " +
        "WHERE product_id = $1 AND is_default = true",
      [productId]
    );
    assert.equal(
      deleted.rowCount,
      1,
      "the unconfigured product default variant should be deletable in the transaction"
    );
    await expectSqlState(
      client.query("SET CONSTRAINTS ALL IMMEDIATE"),
      "23514",
      "a default variant cannot be removed without configured replacements"
    );
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
  }
}

async function expectProductVariantLimitDenied(
  pool: ReturnType<typeof createDatabase>["pool"],
  organizationId: string,
  productId: string
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const option = await client.query<{ id: string }>(
      "INSERT INTO public.product_options " +
        "(organization_id, product_id, name, position) " +
        "VALUES ($1, $2, 'model', 0) RETURNING id",
      [organizationId, productId]
    );
    const optionId = option.rows[0]?.id;
    assert.ok(optionId);
    await client.query(
      "INSERT INTO public.product_option_values " +
        "(organization_id, product_id, option_id, name, position) " +
        "SELECT $1, $2, $3, 'Modelo ' || series.position::text, series.position " +
        "FROM generate_series(1, 51) AS series(position)",
      [organizationId, productId, optionId]
    );
    await client.query(
      "INSERT INTO public.product_variants " +
        "(organization_id, product_id, is_default, position) " +
        "SELECT $1, $2, false, series.position - 1 " +
        "FROM generate_series(1, 51) AS series(position)",
      [organizationId, productId]
    );
    await client.query(
      "INSERT INTO public.variant_option_values " +
        "(organization_id, product_id, variant_id, option_id, option_value_id) " +
        "SELECT $1, $2, variant.id, $3, option_value.id " +
        "FROM public.product_variants AS variant " +
        "INNER JOIN public.product_option_values AS option_value " +
        "ON option_value.organization_id = variant.organization_id " +
        "AND option_value.product_id = variant.product_id " +
        "AND option_value.option_id = $3 " +
        "AND option_value.position = variant.position + 1 " +
        "WHERE variant.organization_id = $1 AND variant.product_id = $2 " +
        "AND variant.is_default = false",
      [organizationId, productId, optionId]
    );
    await client.query(
      "DELETE FROM public.product_variants " +
        "WHERE organization_id = $1 AND product_id = $2 AND is_default = true",
      [organizationId, productId]
    );
    await client.query(
      "UPDATE public.products SET variants_configured_at = now() " +
        "WHERE organization_id = $1 AND id = $2",
      [organizationId, productId]
    );
    await expectSqlState(
      client.query("SET CONSTRAINTS ALL IMMEDIATE"),
      "23514",
      "deferred PostgreSQL guard rejects a persisted 51st variant"
    );
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

async function expectDuplicateOptionValueDenied(
  pool: ReturnType<typeof createDatabase>["pool"],
  organizationId: string,
  productId: string
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const option = await client.query<{ id: string }>(
      "INSERT INTO public.product_options " +
        "(organization_id, product_id, name, position) " +
        "VALUES ($1, $2, 'color', 1) RETURNING id",
      [organizationId, productId]
    );
    const optionId = option.rows[0]?.id;
    assert.ok(optionId);
    await client.query(
      "INSERT INTO public.product_option_values " +
        "(organization_id, product_id, option_id, name, position) " +
        "VALUES ($1, $2, $3, 'Azul', 0)",
      [organizationId, productId, optionId]
    );
    await expectSqlState(
      client.query(
        "INSERT INTO public.product_option_values " +
          "(organization_id, product_id, option_id, name, position) " +
          "VALUES ($1, $2, $3, ' azul ', 1)",
        [organizationId, productId, optionId]
      ),
      "23505",
      "database value uniqueness ignores case and surrounding whitespace"
    );
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

async function expectProductWithoutVariantDenied(
  pool: ReturnType<typeof createDatabase>["pool"],
  organizationId: string
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO public.products (organization_id, name) VALUES ($1, $2)",
      [organizationId, "Gate product without variant"]
    );
    await expectSqlState(
      client.query("SET CONSTRAINTS ALL IMMEDIATE"),
      "23514",
      "deferred database invariant requires every product to have a variant"
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This gate is a sequential checklist of independent database invariants.
async function main() {
  const connectionString = requiredEnvironment(
    "POLARIS_GATE2_TEST_DATABASE_URL"
  );
  const expectedHostname = requiredEnvironment(
    "POLARIS_GATE2_TEST_EXPECTED_HOSTNAME"
  );
  if (
    process.env.POLARIS_GATE2_TEST_CONFIRM_DISPOSABLE !== "gate2-runtime-proof"
  ) {
    throw new Error(
      "Set POLARIS_GATE2_TEST_CONFIRM_DISPOSABLE=gate2-runtime-proof only for the auto-expiring disposable Neon branch."
    );
  }
  const databaseUrl = new URL(connectionString);
  assert.equal(databaseUrl.hostname, expectedHostname);
  assert.equal(databaseUrl.pathname, `/${gateDatabase}`);
  assert.equal(databaseUrl.hostname.includes("-pooler"), false);
  assert.match(databaseUrl.hostname, expectedHost);

  const { db: adminDb, pool: adminPool } = createDatabase(connectionString, {
    maxConnections: 3,
  });
  const runtimeClient = new Client({
    connectionString,
    connectionTimeoutMillis: 5000,
  });
  const runtimeDb = drizzle({ client: runtimeClient }) as unknown as ReturnType<
    typeof createDatabase
  >["db"];
  const fixtureUsers: string[] = [];
  const fixtureOrganizations: string[] = [];
  let connected = false;
  let adminRole: string | undefined;
  let grantedRuntimeRole = false;
  let grantedOnboardingRole = false;
  let passed = false;

  async function createUser(
    name: string,
    emailVerified = true
  ): Promise<string> {
    const id = randomUUID();
    fixtureUsers.push(id);
    await adminPool.query(
      'INSERT INTO public."user" (id, name, email, email_verified) VALUES ($1, $2, $3, $4)',
      [id, name, `gate2-${id}@example.invalid`, emailVerified]
    );
    return id;
  }

  async function createOrganization(userId: string, name: string) {
    const result = await createInitialOrganizationInDatabase(adminDb, {
      id: randomUUID(),
      name,
      requestId: randomUUID(),
      timezone: "America/Sao_Paulo",
      userId,
    });
    fixtureOrganizations.push(result.organization.id);
    // this gate exercises the catalog itself (a 50-variant product), which the plan
    // limits: a new organization is on Free, so the fixture is made a paid one
    await adminPool.query(
      "INSERT INTO public.organization_billing (organization_id, state, access_ends_at) VALUES ($1, 'active', now() + interval '365 days')",
      [result.organization.id]
    );
    return result;
  }

  try {
    const server = await adminPool.query<{
      database: string;
      version: string;
      owner: string;
      ownerBypassRls: boolean;
    }>(
      "SELECT current_database() AS database, " +
        "current_setting('server_version') AS version, " +
        "current_user AS owner, " +
        '(SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS "ownerBypassRls"'
    );
    assert.equal(server.rows[0]?.database, gateDatabase);
    assert.equal(
      Number.parseInt(server.rows[0]?.version.split(".")[0] ?? "", 10),
      18
    );
    assert.equal(server.rows[0]?.ownerBypassRls, true);
    const ownerName = server.rows[0]?.owner;
    assert.ok(ownerName);

    const roleState = await adminPool.query<{
      roleName: string;
      bypassRls: boolean;
      canLogin: boolean;
    }>(
      'SELECT rolname AS "roleName", rolbypassrls AS "bypassRls", ' +
        'rolcanlogin AS "canLogin" FROM pg_roles ' +
        "WHERE rolname = ANY($1::text[]) ORDER BY rolname",
      [[onboardingRole, runtimeRole]]
    );
    assert.deepEqual(
      roleState.rows.map((role) => [
        role.roleName,
        role.bypassRls,
        role.canLogin,
      ]),
      [
        [onboardingRole, false, false],
        [runtimeRole, false, true],
      ]
    );

    const rls = await adminPool.query<{
      name: string;
      enabled: boolean;
      forced: boolean;
      owner: string;
    }>(
      "SELECT c.relname AS name, c.relrowsecurity AS enabled, " +
        "c.relforcerowsecurity AS forced, pg_get_userbyid(c.relowner) AS owner " +
        "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
        "WHERE n.nspname = 'public' AND c.relname = ANY($1::text[]) " +
        "ORDER BY c.relname",
      [
        [
          "categories",
          "memberships",
          "organizations",
          "product_option_values",
          "product_options",
          "product_variants",
          "products",
          "tenant_audit_event",
          "variant_option_values",
        ],
      ]
    );
    assert.deepEqual(
      rls.rows.map((table) => [table.name, table.enabled, table.forced]),
      [
        ["categories", true, true],
        ["memberships", true, true],
        ["organizations", true, true],
        ["product_option_values", true, true],
        ["product_options", true, true],
        ["product_variants", true, true],
        ["products", true, true],
        ["tenant_audit_event", true, true],
        ["variant_option_values", true, true],
      ]
    );
    assert.ok(rls.rows.every((table) => table.owner === ownerName));
    assert.ok(rls.rows.every((table) => table.owner !== runtimeRole));
    assert.ok(rls.rows.every((table) => table.owner !== onboardingRole));

    const categoryPolicies = await adminPool.query<{
      name: string;
      command: string;
      roles: string;
      usingExpression: string | null;
      withCheck: string | null;
    }>(
      "SELECT policyname AS name, cmd AS command, roles, " +
        'qual AS "usingExpression", with_check AS "withCheck" ' +
        "FROM pg_policies WHERE schemaname = 'public' AND tablename = 'categories' " +
        "ORDER BY policyname"
    );
    assert.deepEqual(
      categoryPolicies.rows.map((policy) => policy.name),
      [
        "categories_current_tenant_insert",
        "categories_current_tenant_select",
        "categories_current_tenant_update",
      ]
    );
    assert.ok(
      categoryPolicies.rows.every(
        (policy) => policy.roles === `{${runtimeRole}}`
      )
    );
    assert.equal(categoryPolicies.rows[0]?.command, "INSERT");
    assert.ok(categoryPolicies.rows[0]?.withCheck?.includes("app.user_id"));
    assert.ok(
      categoryPolicies.rows[0]?.withCheck?.includes("app.organization_id")
    );
    assert.equal(categoryPolicies.rows[1]?.command, "SELECT");
    assert.ok(
      categoryPolicies.rows[1]?.usingExpression?.includes("app.user_id")
    );
    assert.ok(
      categoryPolicies.rows[1]?.usingExpression?.includes("app.organization_id")
    );
    assert.equal(categoryPolicies.rows[2]?.command, "UPDATE");
    assert.ok(
      categoryPolicies.rows[2]?.usingExpression?.includes("app.user_id")
    );
    assert.ok(categoryPolicies.rows[2]?.withCheck?.includes("app.user_id"));
    assert.ok(
      categoryPolicies.rows[2]?.withCheck?.includes("app.organization_id")
    );

    const productPolicies = await adminPool.query<{
      name: string;
      command: string;
      roles: string;
      usingExpression: string | null;
      withCheck: string | null;
    }>(
      "SELECT policyname AS name, cmd AS command, roles, " +
        'qual AS "usingExpression", with_check AS "withCheck" ' +
        "FROM pg_policies WHERE schemaname = 'public' AND tablename = 'products' " +
        // the tenant policies; the billing owner's read policy is checked on its own below
        "AND roles <> '{polaris_billing_owner}' " +
        "ORDER BY policyname"
    );
    assert.deepEqual(
      productPolicies.rows.map((policy) => [policy.name, policy.command]),
      [
        ["products_current_tenant_insert", "INSERT"],
        ["products_current_tenant_select", "SELECT"],
        ["products_current_tenant_update", "UPDATE"],
      ]
    );
    assert.ok(
      productPolicies.rows.every(
        (policy) => policy.roles === `{${runtimeRole}}`
      )
    );
    assert.ok(
      productPolicies.rows
        .filter((policy) => policy.command !== "SELECT")
        .every(
          (policy) =>
            policy.withCheck?.includes("app.user_id") &&
            policy.withCheck.includes("app.organization_id")
        )
    );
    assert.ok(
      productPolicies.rows
        .find((policy) => policy.command === "SELECT")
        ?.usingExpression?.includes("app.organization_id")
    );

    const variantPolicies = await adminPool.query<{
      name: string;
      command: string;
      roles: string;
      usingExpression: string | null;
      withCheck: string | null;
    }>(
      "SELECT policyname AS name, cmd AS command, roles, " +
        'qual AS "usingExpression", with_check AS "withCheck" ' +
        "FROM pg_policies WHERE schemaname = 'public' AND tablename = 'product_variants' " +
        "AND roles <> '{polaris_billing_owner}' " +
        "ORDER BY policyname"
    );
    assert.deepEqual(
      variantPolicies.rows.map((policy) => [policy.name, policy.command]),
      [
        ["product_variants_current_tenant_delete", "DELETE"],
        ["product_variants_current_tenant_insert", "INSERT"],
        ["product_variants_current_tenant_select", "SELECT"],
        ["product_variants_current_tenant_sku_update", "UPDATE"],
      ]
    );
    assert.ok(
      variantPolicies.rows.every(
        (policy) => policy.roles === `{${runtimeRole}}`
      )
    );
    assert.ok(
      variantPolicies.rows
        .filter((policy) => policy.command === "INSERT")
        .every(
          (policy) =>
            policy.withCheck?.includes("app.user_id") &&
            policy.withCheck.includes("product_scope")
        )
    );
    assert.ok(
      variantPolicies.rows
        .find((policy) => policy.command === "DELETE")
        ?.usingExpression?.includes("variants_configured_at IS NULL")
    );
    const variantSkuPolicy = variantPolicies.rows.find(
      (policy) => policy.command === "UPDATE"
    );
    assert.ok(
      variantSkuPolicy?.usingExpression?.includes("app.organization_id") &&
        variantSkuPolicy.usingExpression.includes("product_scope") &&
        variantSkuPolicy.withCheck?.includes("app.user_id") &&
        variantSkuPolicy.withCheck.includes("product_scope")
    );

    // The one system policy these tables carry (migration 0053): the billing owner may
    // read the columns its over-limit check counts, through a SECURITY DEFINER function
    // that no tenant role can run. Nothing else is granted to a non-tenant role.
    const billingOwnerPolicies = await adminPool.query<{
      command: string;
      relation: string;
      roles: string;
      usingExpression: string | null;
    }>(
      'SELECT tablename AS relation, cmd AS command, roles, qual AS "usingExpression" ' +
        "FROM pg_policies WHERE schemaname = 'public' " +
        "AND tablename = ANY($1::text[]) AND roles = '{polaris_billing_owner}' " +
        "ORDER BY tablename",
      [["products", "product_variants"]]
    );
    assert.deepEqual(
      billingOwnerPolicies.rows.map((policy) => [
        policy.relation,
        policy.command,
        policy.usingExpression,
      ]),
      [
        ["product_variants", "SELECT", "true"],
        ["products", "SELECT", "true"],
      ]
    );

    const optionPolicies = await adminPool.query<{
      relation: string;
      name: string;
      command: string;
      roles: string;
      usingExpression: string | null;
      withCheck: string | null;
    }>(
      "SELECT tablename AS relation, policyname AS name, cmd AS command, roles, " +
        'qual AS "usingExpression", with_check AS "withCheck" ' +
        "FROM pg_policies WHERE schemaname = 'public' " +
        "AND tablename = ANY($1::text[]) ORDER BY tablename, policyname",
      [["product_option_values", "product_options", "variant_option_values"]]
    );
    assert.deepEqual(
      optionPolicies.rows.map((policy) => [
        policy.relation,
        policy.name,
        policy.command,
      ]),
      [
        [
          "product_option_values",
          "product_option_values_current_tenant_insert",
          "INSERT",
        ],
        [
          "product_option_values",
          "product_option_values_current_tenant_select",
          "SELECT",
        ],
        ["product_options", "product_options_current_tenant_insert", "INSERT"],
        ["product_options", "product_options_current_tenant_select", "SELECT"],
        [
          "variant_option_values",
          "variant_option_values_current_tenant_insert",
          "INSERT",
        ],
        [
          "variant_option_values",
          "variant_option_values_current_tenant_select",
          "SELECT",
        ],
      ]
    );
    assert.ok(
      optionPolicies.rows.every((policy) => policy.roles === `{${runtimeRole}}`)
    );
    assert.ok(
      optionPolicies.rows
        .filter((policy) => policy.command === "INSERT")
        .every(
          (policy) =>
            policy.withCheck?.includes("app.user_id") &&
            policy.withCheck.includes("app.organization_id") &&
            policy.withCheck.includes("variants_configured_at IS NULL")
        )
    );

    const productTriggers = await adminPool.query<{
      name: string;
      deferrable: boolean | null;
      initiallyDeferred: boolean | null;
    }>(
      "SELECT t.tgname AS name, c.condeferrable AS deferrable, " +
        'c.condeferred AS "initiallyDeferred" ' +
        "FROM pg_trigger AS t LEFT JOIN pg_constraint AS c ON c.oid = t.tgconstraint " +
        "WHERE NOT t.tgisinternal AND t.tgrelid = ANY($1::regclass[]) " +
        // The sync change-log triggers are proven by the sync-log gate.
        "AND t.tgname NOT LIKE 'sync_record_%' " +
        "ORDER BY t.tgname",
      [
        [
          "public.categories",
          "public.product_option_values",
          "public.product_options",
          "public.product_variants",
          "public.products",
          "public.variant_option_values",
        ],
      ]
    );
    assert.deepEqual(productTriggers.rows, [
      {
        deferrable: null,
        initiallyDeferred: null,
        name: "categories_prevent_tombstone_with_products",
      },
      {
        deferrable: true,
        initiallyDeferred: true,
        name: "product_option_values_configuration_guard",
      },
      {
        deferrable: null,
        initiallyDeferred: null,
        name: "product_option_values_lock_unconfigured_product",
      },
      {
        deferrable: true,
        initiallyDeferred: true,
        name: "product_options_configuration_guard",
      },
      {
        deferrable: null,
        initiallyDeferred: null,
        name: "product_options_lock_unconfigured_product",
      },
      {
        deferrable: true,
        initiallyDeferred: true,
        name: "product_variants_configuration_guard",
      },
      {
        deferrable: null,
        initiallyDeferred: null,
        name: "product_variants_lock_unconfigured_product",
      },
      {
        deferrable: true,
        initiallyDeferred: true,
        name: "product_variants_preserve_parent",
      },
      {
        deferrable: null,
        initiallyDeferred: null,
        name: "product_variants_prevent_default_sku_loss",
      },
      {
        deferrable: null,
        initiallyDeferred: null,
        name: "products_prevent_variant_configuration_reset",
      },
      {
        deferrable: null,
        initiallyDeferred: null,
        name: "products_require_active_category",
      },
      {
        deferrable: true,
        initiallyDeferred: true,
        name: "products_require_variant",
      },
      {
        deferrable: null,
        initiallyDeferred: null,
        name: "products_tombstone_guard",
      },
      {
        deferrable: true,
        initiallyDeferred: true,
        name: "products_variant_configuration_guard",
      },
      {
        deferrable: true,
        initiallyDeferred: true,
        name: "variant_option_values_configuration_guard",
      },
      {
        deferrable: null,
        initiallyDeferred: null,
        name: "variant_option_values_lock_unconfigured_product",
      },
    ]);

    const grants = await adminPool.query<{
      categorySelect: boolean;
      categoryInsert: boolean;
      categoryUpdate: boolean;
      categoryDelete: boolean;
      productSelect: boolean;
      productInsert: boolean;
      productUpdate: boolean;
      productDelete: boolean;
      variantSelect: boolean;
      variantInsert: boolean;
      variantUpdate: boolean;
      variantDelete: boolean;
      productOptionSelect: boolean;
      productOptionInsert: boolean;
      productOptionUpdate: boolean;
      productOptionDelete: boolean;
      productOptionValueSelect: boolean;
      productOptionValueInsert: boolean;
      productOptionValueUpdate: boolean;
      productOptionValueDelete: boolean;
      variantOptionValueSelect: boolean;
      variantOptionValueInsert: boolean;
      variantOptionValueUpdate: boolean;
      variantOptionValueDelete: boolean;
      variantSkuUpdate: boolean;
      variantPositionUpdate: boolean;
      organizationInsert: boolean;
      membershipInsert: boolean;
    }>(
      "SELECT has_table_privilege($1, 'public.categories', 'SELECT') AS \"categorySelect\", " +
        "has_table_privilege($1, 'public.categories', 'INSERT') AS \"categoryInsert\", " +
        "has_any_column_privilege($1, 'public.categories', 'UPDATE') AS \"categoryUpdate\", " +
        "has_table_privilege($1, 'public.categories', 'DELETE') AS \"categoryDelete\", " +
        "has_table_privilege($1, 'public.products', 'SELECT') AS \"productSelect\", " +
        "has_table_privilege($1, 'public.products', 'INSERT') AS \"productInsert\", " +
        "has_any_column_privilege($1, 'public.products', 'UPDATE') AS \"productUpdate\", " +
        "has_table_privilege($1, 'public.products', 'DELETE') AS \"productDelete\", " +
        "has_table_privilege($1, 'public.product_variants', 'SELECT') AS \"variantSelect\", " +
        "has_table_privilege($1, 'public.product_variants', 'INSERT') AS \"variantInsert\", " +
        "has_table_privilege($1, 'public.product_variants', 'UPDATE') AS \"variantUpdate\", " +
        "has_table_privilege($1, 'public.product_variants', 'DELETE') AS \"variantDelete\", " +
        "has_column_privilege($1, 'public.product_variants', 'sku', 'UPDATE') AS \"variantSkuUpdate\", " +
        "has_column_privilege($1, 'public.product_variants', 'position', 'UPDATE') AS \"variantPositionUpdate\", " +
        "has_table_privilege($1, 'public.product_options', 'SELECT') AS \"productOptionSelect\", " +
        "has_table_privilege($1, 'public.product_options', 'INSERT') AS \"productOptionInsert\", " +
        "has_table_privilege($1, 'public.product_options', 'UPDATE') AS \"productOptionUpdate\", " +
        "has_table_privilege($1, 'public.product_options', 'DELETE') AS \"productOptionDelete\", " +
        "has_table_privilege($1, 'public.product_option_values', 'SELECT') AS \"productOptionValueSelect\", " +
        "has_table_privilege($1, 'public.product_option_values', 'INSERT') AS \"productOptionValueInsert\", " +
        "has_table_privilege($1, 'public.product_option_values', 'UPDATE') AS \"productOptionValueUpdate\", " +
        "has_table_privilege($1, 'public.product_option_values', 'DELETE') AS \"productOptionValueDelete\", " +
        "has_table_privilege($1, 'public.variant_option_values', 'SELECT') AS \"variantOptionValueSelect\", " +
        "has_table_privilege($1, 'public.variant_option_values', 'INSERT') AS \"variantOptionValueInsert\", " +
        "has_table_privilege($1, 'public.variant_option_values', 'UPDATE') AS \"variantOptionValueUpdate\", " +
        "has_table_privilege($1, 'public.variant_option_values', 'DELETE') AS \"variantOptionValueDelete\", " +
        "has_table_privilege($1, 'public.organizations', 'INSERT') AS \"organizationInsert\", " +
        "has_table_privilege($1, 'public.memberships', 'INSERT') AS \"membershipInsert\"",
      [runtimeRole]
    );
    assert.deepEqual(grants.rows[0], {
      categoryDelete: false,
      categoryInsert: true,
      categorySelect: true,
      categoryUpdate: true,
      membershipInsert: false,
      organizationInsert: false,
      productDelete: false,
      productInsert: true,
      productOptionDelete: false,
      productOptionInsert: true,
      productOptionSelect: true,
      productOptionUpdate: false,
      productOptionValueDelete: false,
      productOptionValueInsert: true,
      productOptionValueSelect: true,
      productOptionValueUpdate: false,
      productSelect: true,
      productUpdate: true,
      variantDelete: true,
      variantInsert: true,
      variantOptionValueDelete: false,
      variantOptionValueInsert: true,
      variantOptionValueSelect: true,
      variantOptionValueUpdate: false,
      variantPositionUpdate: false,
      variantSelect: true,
      variantSkuUpdate: true,
      variantUpdate: false,
    });

    const functionAccess = await adminPool.query<{
      runtimeCanExecute: boolean;
      onboardingCanExecute: boolean;
      publicCanExecute: boolean;
      securityDefiner: boolean;
      owner: string;
      config: string[] | null;
    }>(
      "SELECT has_function_privilege($1, " +
        "'public.create_initial_organization(text,text,text,text,uuid)', 'EXECUTE') AS \"runtimeCanExecute\", " +
        "has_function_privilege($2, " +
        "'public.create_initial_organization(text,text,text,text,uuid)', 'EXECUTE') AS \"onboardingCanExecute\", " +
        "EXISTS (SELECT 1 FROM pg_catalog.aclexplode(" +
        "COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS acl " +
        "WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE') AS \"publicCanExecute\", " +
        'p.prosecdef AS "securityDefiner", ' +
        "pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config " +
        "FROM pg_catalog.pg_proc p " +
        "WHERE p.oid = 'public.create_initial_organization(text,text,text,text,uuid)'::regprocedure",
      [runtimeRole, onboardingRole]
    );
    assert.deepEqual(functionAccess.rows[0], {
      config: ["search_path=pg_catalog, pg_temp"],
      onboardingCanExecute: true,
      owner: ownerName,
      publicCanExecute: false,
      runtimeCanExecute: false,
      securityDefiner: true,
    });

    const runtimeSet = await ensureSetRole(adminPool, runtimeRole);
    ({ adminRole } = runtimeSet);
    if (!runtimeSet.canSet) {
      grantedRuntimeRole = true;
      await adminPool.query(`GRANT ${runtimeRole} TO ${adminRole}`);
    }
    const onboardingSet = await ensureSetRole(adminPool, onboardingRole);
    if (!onboardingSet.canSet) {
      grantedOnboardingRole = true;
      await adminPool.query(
        `GRANT ${onboardingRole} TO ${onboardingSet.adminRole}`
      );
    }

    await runtimeClient.connect();
    connected = true;
    await runtimeClient.query(`SET ROLE ${runtimeRole}`);

    const userA = await createUser("Gate 2 tenant A");
    const userB = await createUser("Gate 2 tenant B");
    const unverifiedUser = await createUser("Gate 2 unverified", false);
    const organizationA = await createOrganization(userA, "Gate 2 tenant A");
    const organizationB = await createOrganization(userB, "Gate 2 tenant B");
    assert.equal(organizationA.created, true);
    assert.equal(organizationB.created, true);

    const onboardingUser = await createUser("Gate 2 onboarding writer");
    const onboardingOrganizationId = randomUUID();
    fixtureOrganizations.push(onboardingOrganizationId);
    await expectSqlState(
      runtimeClient.query(
        "SELECT * FROM public.create_initial_organization($1, $2, $3, $4, $5)",
        [
          onboardingUser,
          randomUUID(),
          "Runtime role must not call the writer",
          "America/Sao_Paulo",
          randomUUID(),
        ]
      ),
      "42501",
      "the tenant role cannot execute the onboarding writer"
    );

    await runtimeClient.query("RESET ROLE");
    await runtimeClient.query(`SET ROLE ${onboardingRole}`);
    const onboardingRequestId = randomUUID();
    const onboardingResult = await runtimeClient.query<{
      created: boolean;
      id: string;
      name: string;
      timezone: string;
      currency: string;
      status: string;
    }>("SELECT * FROM public.create_initial_organization($1, $2, $3, $4, $5)", [
      onboardingUser,
      onboardingOrganizationId,
      "Runtime onboarding",
      "America/Sao_Paulo",
      onboardingRequestId,
    ]);
    assert.equal(onboardingResult.rows[0]?.created, true);
    assert.equal(onboardingResult.rows[0]?.id, onboardingOrganizationId);
    assert.equal(onboardingResult.rows[0]?.name, "Runtime onboarding");
    assert.equal(onboardingResult.rows[0]?.status, "active");

    const retry = await runtimeClient.query<{
      created: boolean;
      id: string;
      name: string;
    }>(
      "SELECT created, id, name FROM public.create_initial_organization($1, $2, $3, $4, $5)",
      [
        onboardingUser,
        randomUUID(),
        "Retry must not mutate existing organization",
        "Etc/UTC",
        randomUUID(),
      ]
    );
    assert.deepEqual(retry.rows[0], {
      created: false,
      id: onboardingOrganizationId,
      name: "Runtime onboarding",
    });

    await expectSqlState(
      runtimeClient.query(
        "SELECT * FROM public.create_initial_organization($1, $2, $3, $4, $5)",
        [
          unverifiedUser,
          randomUUID(),
          "Must be rejected",
          "America/Sao_Paulo",
          randomUUID(),
        ]
      ),
      "P0001",
      "unverified onboarding user is rejected"
    );
    await expectSqlState(
      runtimeClient.query(
        "INSERT INTO public.organizations (id, name, timezone) VALUES ($1, $2, $3)",
        [randomUUID(), "Direct write forbidden", "Etc/UTC"]
      ),
      "42501",
      "the onboarding role has no direct table DML"
    );
    await runtimeClient.query("RESET ROLE");
    await runtimeClient.query(`SET ROLE ${runtimeRole}`);

    const onboardingMembership = await adminPool.query(
      "SELECT organization_id FROM public.memberships WHERE user_id = $1",
      [onboardingUser]
    );
    assert.deepEqual(onboardingMembership.rows, [
      { organization_id: onboardingOrganizationId },
    ]);
    const onboardingAudit = await adminPool.query(
      "SELECT organization_id, actor_user_id, event_type, entity_type, entity_id, request_id " +
        "FROM public.tenant_audit_event WHERE event_type = 'organization.created' " +
        "AND entity_id = $1",
      [onboardingOrganizationId]
    );
    assert.deepEqual(onboardingAudit.rows, [
      {
        actor_user_id: onboardingUser,
        entity_id: onboardingOrganizationId,
        entity_type: "organization",
        event_type: "organization.created",
        organization_id: onboardingOrganizationId,
        request_id: onboardingRequestId,
      },
    ]);

    const contextlessCategories = await runtimeClient.query(
      "SELECT id FROM public.categories"
    );
    assert.deepEqual(contextlessCategories.rows, []);

    const categoryA = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userA,
        capability: "category:create",
        requestedOrganizationId: organizationA.organization.id,
      },
      (transaction, identity) =>
        createCategory(transaction, identity, {
          name: "  Escritório  ",
          requestId: randomUUID(),
        })
    );
    const categoryB = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userB,
        capability: "category:create",
        requestedOrganizationId: organizationB.organization.id,
      },
      (transaction, identity) =>
        createCategory(transaction, identity, {
          name: "Escritório",
          requestId: randomUUID(),
        })
    );
    assert.equal(categoryA.name, "Escritório");
    assert.equal(categoryB.name, categoryA.name);

    const renameConflictCategory = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userA,
        capability: "category:create",
        requestedOrganizationId: organizationA.organization.id,
      },
      (transaction, identity) =>
        createCategory(transaction, identity, {
          name: "Outro",
          requestId: randomUUID(),
        })
    );

    await assert.rejects(
      withAuthorizedTenantTransaction(
        runtimeDb,
        {
          authenticatedUserId: userA,
          capability: "category:create",
          requestedOrganizationId: organizationA.organization.id,
        },
        (transaction, identity) =>
          createCategory(transaction, identity, {
            name: "escritório",
            requestId: randomUUID(),
          })
      ),
      CategoryNameConflictError,
      "case-insensitive duplicate create in one organization"
    );
    await assert.rejects(
      withAuthorizedTenantTransaction(
        runtimeDb,
        {
          authenticatedUserId: userA,
          capability: "category:manage",
          requestedOrganizationId: organizationA.organization.id,
        },
        (transaction, identity) =>
          renameCategory(transaction, identity, {
            id: categoryA.id,
            name: "outro",
          })
      ),
      CategoryNameConflictError,
      "rename conflicts with a category in the same organization"
    );
    const renameConflictCleanup = await adminPool.query(
      "DELETE FROM public.categories WHERE id = $1 AND organization_id = $2",
      [renameConflictCategory.id, organizationA.organization.id]
    );
    assert.equal(renameConflictCleanup.rowCount, 1);
    const renamedCategory = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userA,
        capability: "category:manage",
        requestedOrganizationId: organizationA.organization.id,
      },
      (transaction, identity) =>
        renameCategory(transaction, identity, {
          id: categoryA.id,
          name: "Acessórios",
          requestId: randomUUID(),
        })
    );
    assert.equal(renamedCategory.changed, true);
    assert.equal(renamedCategory.category.name, "Acessórios");
    const renameRetry = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userA,
        capability: "category:manage",
        requestedOrganizationId: organizationA.organization.id,
      },
      (transaction, identity) =>
        renameCategory(transaction, identity, {
          id: categoryA.id,
          name: " Acessórios ",
        })
    );
    assert.equal(renameRetry.changed, false);

    const productA = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userA,
        capability: "product:create",
        requestedOrganizationId: organizationA.organization.id,
      },
      (transaction, identity) =>
        createProduct(transaction, identity, {
          categoryId: categoryA.id,
          description: "  ",
          name: "Bolsa",
          requestId: randomUUID(),
        })
    );
    assert.equal(productA.description, null);
    assert.equal(productA.categoryId, categoryA.id);
    assert.equal(productA.version, 1);

    const duplicateProductA = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userA,
        capability: "product:create",
        requestedOrganizationId: organizationA.organization.id,
      },
      (transaction, identity) =>
        createProduct(transaction, identity, {
          name: "Bolsa",
          requestId: randomUUID(),
        })
    );
    const productB = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userB,
        capability: "product:create",
        requestedOrganizationId: organizationB.organization.id,
      },
      (transaction, identity) =>
        createProduct(transaction, identity, {
          categoryId: categoryB.id,
          name: "Bolsa",
          requestId: randomUUID(),
        })
    );
    assert.notEqual(productA.id, duplicateProductA.id);
    assert.equal(productA.name, duplicateProductA.name);
    assert.equal(productB.name, productA.name);
    await assert.rejects(
      withAuthorizedTenantTransaction(
        runtimeDb,
        {
          authenticatedUserId: userA,
          capability: "product:update",
          requestedOrganizationId: organizationA.organization.id,
        },
        (transaction, identity) =>
          configureProductVariants(transaction, identity, {
            expectedVersion: 1,
            id: duplicateProductA.id,
            options: [{ name: "color", values: ["Azul"] }],
            requestId: randomUUID(),
            variants: [
              { values: { color: "Azul" } },
              { values: { color: " azul " } },
            ],
          })
      ),
      ProductVariantConfigurationError
    );

    const archivedCategoryB = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userB,
        capability: "category:manage",
        requestedOrganizationId: organizationB.organization.id,
      },
      (transaction, identity) =>
        archiveCategory(transaction, identity, { id: categoryB.id })
    );
    assert.equal(archivedCategoryB.changed, true);
    assert.equal(productB.categoryId, categoryB.id);
    await assert.rejects(
      withAuthorizedTenantTransaction(
        runtimeDb,
        {
          authenticatedUserId: userB,
          capability: "product:create",
          requestedOrganizationId: organizationB.organization.id,
        },
        (transaction, identity) =>
          createProduct(transaction, identity, {
            categoryId: categoryB.id,
            name: "Produto em categoria arquivada",
          })
      ),
      ProductCategoryUnavailableError
    );
    await expectInactiveCategoryAssignmentDenied(
      runtimeClient,
      userB,
      organizationB.organization.id,
      categoryB.id
    );
    const restoredCategoryB = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userB,
        capability: "category:manage",
        requestedOrganizationId: organizationB.organization.id,
      },
      (transaction, identity) =>
        restoreCategory(transaction, identity, { id: categoryB.id })
    );
    assert.equal(restoredCategoryB.changed, true);

    const productIds = [productA.id, duplicateProductA.id, productB.id];
    const productIdVersions = await adminPool.query<{ version: number }>(
      "SELECT uuid_extract_version(id) AS version FROM public.products " +
        "WHERE id = ANY($1::uuid[])",
      [productIds]
    );
    assert.equal(productIdVersions.rows.length, 3);
    assert.ok(productIdVersions.rows.every((row) => row.version === 7));
    const defaultVariants = await adminPool.query<{
      product_id: string;
      variant_count: string;
      all_default: boolean;
    }>(
      "SELECT product_id::text, count(*)::text AS variant_count, " +
        "bool_and(is_default) AS all_default FROM public.product_variants " +
        "WHERE product_id = ANY($1::uuid[]) GROUP BY product_id " +
        "ORDER BY product_id",
      [productIds]
    );
    assert.equal(defaultVariants.rows.length, 3);
    assert.ok(
      defaultVariants.rows.every(
        (row) => row.variant_count === "1" && row.all_default
      )
    );

    const configurableProduct = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userA,
        capability: "product:create",
        requestedOrganizationId: organizationA.organization.id,
      },
      (transaction, identity) =>
        createProduct(transaction, identity, {
          name: "Gate product variants",
          requestId: randomUUID(),
        })
    );
    const explicitCombinations = [
      { values: { color: "Azul", size: "P" } },
      { values: { color: "Azul", size: "M" } },
      { values: { color: "Preto", size: "M" } },
    ];
    const configuredVariants = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userA,
        capability: "product:update",
        requestedOrganizationId: organizationA.organization.id,
      },
      (transaction, identity) =>
        configureProductVariants(transaction, identity, {
          expectedVersion: 1,
          id: configurableProduct.id,
          options: [
            { name: "color", values: ["Azul", "Preto"] },
            { name: "size", values: ["P", "M"] },
          ],
          requestId: randomUUID(),
          variants: explicitCombinations,
        })
    );
    assert.equal(configuredVariants.product.version, 2);
    assert.equal(configuredVariants.configuration.configured, true);
    assert.deepEqual(
      configuredVariants.configuration.options.map((option) => option.name),
      ["color", "size"]
    );
    assert.deepEqual(
      configuredVariants.configuration.variants.map((variant) =>
        variant.values.map((value) => value.optionValueName)
      ),
      [
        ["Azul", "P"],
        ["Azul", "M"],
        ["Preto", "M"],
      ]
    );
    assert.deepEqual(
      configuredVariants.configuration.variants.map(
        (variant) => variant.position
      ),
      [0, 1, 2]
    );
    assert.ok(
      configuredVariants.configuration.variants.every(
        (variant) => !variant.isDefault
      )
    );
    const configuredRead = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userA,
        capability: "catalog:read",
        requestedOrganizationId: organizationA.organization.id,
      },
      (transaction, identity) =>
        getProductVariants(transaction, identity, configurableProduct.id)
    );
    assert.deepEqual(configuredRead, configuredVariants.configuration);
    const variantEntityUuidVersions = await adminPool.query<{
      version: number;
    }>(
      "SELECT uuid_extract_version(id) AS version " +
        "FROM public.product_variants WHERE product_id = $1 " +
        "UNION ALL SELECT uuid_extract_version(id) AS version " +
        "FROM public.product_options WHERE product_id = $1 " +
        "UNION ALL SELECT uuid_extract_version(id) AS version " +
        "FROM public.product_option_values WHERE product_id = $1",
      [configurableProduct.id]
    );
    assert.equal(variantEntityUuidVersions.rows.length, 9);
    assert.ok(variantEntityUuidVersions.rows.every((row) => row.version === 7));

    const variantConfigurationState = await adminPool.query<{
      assignmentCount: string;
      configured: boolean;
      defaultCount: string;
      optionCount: string;
      optionValueCount: string;
      productVersion: number;
      variantCount: string;
    }>(
      "SELECT product.variants_configured_at IS NOT NULL AS configured, " +
        'product.version AS "productVersion", ' +
        "(SELECT count(*)::text FROM public.product_options AS option " +
        "WHERE option.organization_id = product.organization_id " +
        'AND option.product_id = product.id) AS "optionCount", ' +
        "(SELECT count(*)::text FROM public.product_option_values AS value " +
        "WHERE value.organization_id = product.organization_id " +
        'AND value.product_id = product.id) AS "optionValueCount", ' +
        "(SELECT count(*)::text FROM public.product_variants AS variant " +
        "WHERE variant.organization_id = product.organization_id " +
        'AND variant.product_id = product.id) AS "variantCount", ' +
        "(SELECT count(*)::text FROM public.product_variants AS variant " +
        "WHERE variant.organization_id = product.organization_id " +
        'AND variant.product_id = product.id AND variant.is_default) AS "defaultCount", ' +
        "(SELECT count(*)::text FROM public.variant_option_values AS assignment " +
        "WHERE assignment.organization_id = product.organization_id " +
        'AND assignment.product_id = product.id) AS "assignmentCount" ' +
        "FROM public.products AS product WHERE product.id = $1",
      [configurableProduct.id]
    );
    assert.deepEqual(variantConfigurationState.rows[0], {
      assignmentCount: "6",
      configured: true,
      defaultCount: "0",
      optionCount: "2",
      optionValueCount: "4",
      productVersion: 2,
      variantCount: "3",
    });
    const duplicateValueProduct = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userA,
        capability: "product:create",
        requestedOrganizationId: organizationA.organization.id,
      },
      (transaction, identity) =>
        createProduct(transaction, identity, {
          name: "Gate duplicate option values",
          requestId: randomUUID(),
        })
    );
    await expectDuplicateOptionValueDenied(
      adminPool,
      organizationA.organization.id,
      duplicateValueProduct.id
    );

    const variantAudit = await adminPool.query<{ event_type: string }>(
      "SELECT event_type FROM public.tenant_audit_event " +
        "WHERE entity_id = $1 ORDER BY event_type",
      [configurableProduct.id]
    );
    assert.deepEqual(
      variantAudit.rows.map((row) => row.event_type),
      ["product.created", "product.variants_configured"]
    );

    await assert.rejects(
      withAuthorizedTenantTransaction(
        runtimeDb,
        {
          authenticatedUserId: userA,
          capability: "product:update",
          requestedOrganizationId: organizationA.organization.id,
        },
        (transaction, identity) =>
          configureProductVariants(transaction, identity, {
            expectedVersion: 2,
            id: configurableProduct.id,
            options: [{ name: "model", values: ["Reconfiguração"] }],
            requestId: randomUUID(),
            variants: [{ values: { model: "Reconfiguração" } }],
          })
      ),
      ProductVariantsAlreadyConfiguredError
    );
    await runtimeClient.query("BEGIN");
    await runtimeClient.query(
      "SELECT set_config('app.user_id', $1, true), " +
        "set_config('app.organization_id', $2, true)",
      [userA, organizationA.organization.id]
    );
    await expectSqlState(
      runtimeClient.query(
        "UPDATE public.products SET variants_configured_at = NULL WHERE id = $1",
        [configurableProduct.id]
      ),
      "23514",
      "the database prevents resetting the one-time variant configuration marker"
    );
    await runtimeClient.query("ROLLBACK");
    await expectProductVariantDeleteDenied(
      runtimeClient,
      userA,
      organizationA.organization.id,
      configurableProduct.id
    );

    const archivedConfiguredProduct = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userA,
        capability: "product:update",
        requestedOrganizationId: organizationA.organization.id,
      },
      (transaction, identity) =>
        archiveProduct(transaction, identity, {
          expectedVersion: 2,
          id: configurableProduct.id,
          requestId: randomUUID(),
        })
    );
    assert.equal(archivedConfiguredProduct.product.version, 3);
    const restoredConfiguredProduct = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userA,
        capability: "product:update",
        requestedOrganizationId: organizationA.organization.id,
      },
      (transaction, identity) =>
        restoreProduct(transaction, identity, {
          expectedVersion: 3,
          id: configurableProduct.id,
          requestId: randomUUID(),
        })
    );
    assert.equal(restoredConfiguredProduct.product.version, 4);
    const restoredVariants = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userA,
        capability: "catalog:read",
        requestedOrganizationId: organizationA.organization.id,
      },
      (transaction, identity) =>
        getProductVariants(transaction, identity, configurableProduct.id)
    );
    assert.deepEqual(
      restoredVariants.variants.map((variant) => variant.id),
      configuredVariants.configuration.variants.map((variant) => variant.id)
    );

    const concurrentVariantProduct = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userA,
        capability: "product:create",
        requestedOrganizationId: organizationA.organization.id,
      },
      (transaction, identity) =>
        createProduct(transaction, identity, {
          name: "Gate concurrent variant configuration",
          requestId: randomUUID(),
        })
    );
    const concurrentConfiguration = () =>
      withAuthorizedTenantTransaction(
        adminDb,
        {
          authenticatedUserId: userA,
          capability: "product:update",
          requestedOrganizationId: organizationA.organization.id,
        },
        (transaction, identity) =>
          configureProductVariants(transaction, identity, {
            expectedVersion: 1,
            id: concurrentVariantProduct.id,
            options: [{ name: "model", values: ["A", "B"] }],
            requestId: randomUUID(),
            variants: [{ values: { model: "A" } }, { values: { model: "B" } }],
          })
      );
    const concurrentResults = await Promise.allSettled([
      concurrentConfiguration(),
      concurrentConfiguration(),
    ]);
    assert.equal(
      concurrentResults.filter((result) => result.status === "fulfilled")
        .length,
      1,
      "exactly one concurrent variant configuration should commit"
    );
    const concurrentFailure = concurrentResults.find(
      (result) => result.status === "rejected"
    );
    assert.ok(concurrentFailure && concurrentFailure.status === "rejected");
    assert.ok(concurrentFailure.reason instanceof ProductVersionConflictError);

    const concurrentVariantConfiguration =
      await withAuthorizedTenantTransaction(
        runtimeDb,
        {
          authenticatedUserId: userA,
          capability: "catalog:read",
          requestedOrganizationId: organizationA.organization.id,
        },
        (transaction, identity) =>
          getProductVariants(transaction, identity, concurrentVariantProduct.id)
      );
    const [skuVariantA, skuVariantB] = concurrentVariantConfiguration.variants;
    assert.ok(skuVariantA && skuVariantB);
    assert.equal(concurrentVariantConfiguration.productVersion, 2);

    const assignedVariantSku = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userA,
        capability: "product:update",
        requestedOrganizationId: organizationA.organization.id,
      },
      (transaction, identity) =>
        setProductVariantSku(transaction, identity, {
          expectedVersion: 2,
          id: concurrentVariantProduct.id,
          requestId: randomUUID(),
          sku: "  sku-Abc  ",
          variantId: skuVariantA.id,
        })
    );
    assert.equal(assignedVariantSku.changed, true);
    assert.equal(assignedVariantSku.product.version, 3);
    assert.equal(assignedVariantSku.configuration.variants[0]?.sku, "sku-Abc");

    await assert.rejects(
      withAuthorizedTenantTransaction(
        runtimeDb,
        {
          authenticatedUserId: userA,
          capability: "product:update",
          requestedOrganizationId: organizationA.organization.id,
        },
        (transaction, identity) =>
          setProductVariantSku(transaction, identity, {
            expectedVersion: 3,
            id: concurrentVariantProduct.id,
            requestId: randomUUID(),
            sku: "SKU-ABC",
            variantId: skuVariantB.id,
          })
      ),
      ProductVariantSkuConflictError
    );

    const productBVariants = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userB,
        capability: "catalog:read",
        requestedOrganizationId: organizationB.organization.id,
      },
      (transaction, identity) =>
        getProductVariants(transaction, identity, productB.id)
    );
    const [defaultVariantB] = productBVariants.variants;
    assert.ok(defaultVariantB?.isDefault);
    const sameSkuInOtherOrganization = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userB,
        capability: "product:update",
        requestedOrganizationId: organizationB.organization.id,
      },
      (transaction, identity) =>
        setProductVariantSku(transaction, identity, {
          expectedVersion: 1,
          id: productB.id,
          requestId: randomUUID(),
          sku: "SKU-ABC",
          variantId: defaultVariantB.id,
        })
    );
    assert.equal(sameSkuInOtherOrganization.changed, true);

    const defaultSkuDeleteClient = await adminPool.connect();
    try {
      await defaultSkuDeleteClient.query("BEGIN");
      await expectSqlState(
        defaultSkuDeleteClient.query(
          "DELETE FROM public.product_variants WHERE id = $1",
          [defaultVariantB.id]
        ),
        "23514",
        "the database prevents losing an SKU on the default variant"
      );
    } finally {
      await defaultSkuDeleteClient.query("ROLLBACK").catch(() => undefined);
      defaultSkuDeleteClient.release();
    }

    await assert.rejects(
      withAuthorizedTenantTransaction(
        runtimeDb,
        {
          authenticatedUserId: userB,
          capability: "product:update",
          requestedOrganizationId: organizationB.organization.id,
        },
        (transaction, identity) =>
          configureProductVariants(transaction, identity, {
            expectedVersion: 2,
            id: productB.id,
            options: [{ name: "model", values: ["Unique"] }],
            requestId: randomUUID(),
            variants: [{ values: { model: "Unique" } }],
          })
      ),
      ProductDefaultVariantSkuConflictError
    );

    const clearedDefaultSku = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userB,
        capability: "product:update",
        requestedOrganizationId: organizationB.organization.id,
      },
      (transaction, identity) =>
        setProductVariantSku(transaction, identity, {
          expectedVersion: 2,
          id: productB.id,
          requestId: randomUUID(),
          sku: null,
          variantId: defaultVariantB.id,
        })
    );
    assert.equal(clearedDefaultSku.product.version, 3);
    const configuredAfterDefaultSkuClear =
      await withAuthorizedTenantTransaction(
        runtimeDb,
        {
          authenticatedUserId: userB,
          capability: "product:update",
          requestedOrganizationId: organizationB.organization.id,
        },
        (transaction, identity) =>
          configureProductVariants(transaction, identity, {
            expectedVersion: 3,
            id: productB.id,
            options: [{ name: "model", values: ["Unique"] }],
            requestId: randomUUID(),
            variants: [{ values: { model: "Unique" } }],
          })
      );
    assert.equal(configuredAfterDefaultSkuClear.product.version, 4);
    assert.equal(
      configuredAfterDefaultSkuClear.configuration.variants[0]?.sku,
      null
    );

    const changedSkuCase = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userA,
        capability: "product:update",
        requestedOrganizationId: organizationA.organization.id,
      },
      (transaction, identity) =>
        setProductVariantSku(transaction, identity, {
          expectedVersion: 3,
          id: concurrentVariantProduct.id,
          requestId: randomUUID(),
          sku: "SKU-ABC",
          variantId: skuVariantA.id,
        })
    );
    assert.equal(changedSkuCase.changed, true);
    assert.equal(changedSkuCase.product.version, 4);
    assert.equal(changedSkuCase.configuration.variants[0]?.sku, "SKU-ABC");

    const clearedSku = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userA,
        capability: "product:update",
        requestedOrganizationId: organizationA.organization.id,
      },
      (transaction, identity) =>
        setProductVariantSku(transaction, identity, {
          expectedVersion: 4,
          id: concurrentVariantProduct.id,
          requestId: randomUUID(),
          sku: " \t\n ",
          variantId: skuVariantA.id,
        })
    );
    assert.equal(clearedSku.changed, true);
    assert.equal(clearedSku.product.version, 5);
    assert.equal(clearedSku.configuration.variants[0]?.sku, null);

    const reusedSku = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userA,
        capability: "product:update",
        requestedOrganizationId: organizationA.organization.id,
      },
      (transaction, identity) =>
        setProductVariantSku(transaction, identity, {
          expectedVersion: 5,
          id: concurrentVariantProduct.id,
          requestId: randomUUID(),
          sku: "SKU-ABC",
          variantId: skuVariantB.id,
        })
    );
    assert.equal(reusedSku.changed, true);
    assert.equal(reusedSku.product.version, 6);
    const sameSkuNoop = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userA,
        capability: "product:update",
        requestedOrganizationId: organizationA.organization.id,
      },
      (transaction, identity) =>
        setProductVariantSku(transaction, identity, {
          expectedVersion: 6,
          id: concurrentVariantProduct.id,
          requestId: randomUUID(),
          sku: " SKU-ABC ",
          variantId: skuVariantB.id,
        })
    );
    assert.equal(sameSkuNoop.changed, false);
    assert.equal(sameSkuNoop.product.version, 6);

    await assert.rejects(
      withAuthorizedTenantTransaction(
        runtimeDb,
        {
          authenticatedUserId: userA,
          capability: "product:update",
          requestedOrganizationId: organizationA.organization.id,
        },
        (transaction, identity) =>
          setProductVariantSku(transaction, identity, {
            expectedVersion: 6,
            id: concurrentVariantProduct.id,
            requestId: randomUUID(),
            sku: "SKU-UNKNOWN",
            variantId: randomUUID(),
          })
      ),
      ProductVariantNotFoundError
    );

    // ---- the optional list price of a variant (D-6)
    const withListPrice = (
      expectedVersion: number,
      listPrice: string | null,
      variantId = skuVariantA.id
    ) =>
      withAuthorizedTenantTransaction(
        runtimeDb,
        {
          authenticatedUserId: userA,
          capability: "product:update",
          requestedOrganizationId: organizationA.organization.id,
        },
        (transaction, identity) =>
          setProductVariantListPrice(transaction, identity, {
            expectedVersion,
            id: concurrentVariantProduct.id,
            listPrice,
            requestId: randomUUID(),
            variantId,
          })
      );
    const priced = await withListPrice(6, " 49.9 ");
    assert.equal(priced.changed, true);
    assert.equal(priced.product.version, 7);
    assert.equal(
      priced.configuration.variants.find(
        (variant) => variant.id === skuVariantA.id
      )?.listPrice,
      "49.90"
    );
    const samePrice = await withListPrice(7, "49.90");
    assert.equal(samePrice.changed, false, "the same price changes nothing");
    assert.equal(samePrice.product.version, 7);
    await assert.rejects(
      withListPrice(3, "10.00"),
      ProductVersionConflictError
    );
    for (const invalid of [
      "-1",
      "1.234",
      "abc",
      "",
      "1e3",
      "1234567890123456",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each probe is verified before the next one starts
      await assert.rejects(
        withListPrice(7, invalid),
        InvalidVariantListPriceError,
        `list price ${JSON.stringify(invalid)} is refused`
      );
    }
    const cleared = await withListPrice(7, null);
    assert.equal(cleared.changed, true);
    assert.equal(
      cleared.configuration.variants.find(
        (variant) => variant.id === skuVariantA.id
      )?.listPrice,
      null
    );
    const otherVariantUnpriced = cleared.configuration.variants.find(
      (variant) => variant.id === skuVariantB.id
    );
    assert.equal(otherVariantUnpriced?.listPrice, null);
    await expectSqlState(
      adminPool.query(
        "UPDATE public.product_variants SET list_price = -1 WHERE id = $1",
        [skuVariantA.id]
      ),
      "23514",
      "the database refuses an invalid list price"
    );
    await expectSqlState(
      adminPool.query(
        "UPDATE public.product_variants SET list_price = 1.234 WHERE id = $1",
        [skuVariantA.id]
      ),
      "23514",
      "the database refuses an invalid list price"
    );

    await runtimeClient.query("BEGIN");
    await runtimeClient.query(
      "SELECT set_config('app.user_id', $1, true), " +
        "set_config('app.organization_id', $2, true)",
      [userA, organizationA.organization.id]
    );
    await expectSqlState(
      runtimeClient.query(
        "UPDATE public.product_variants SET position = position " +
          "WHERE id = $1",
        [skuVariantB.id]
      ),
      "42501",
      "runtime may update SKU but not other product variant columns"
    );
    await runtimeClient.query("ROLLBACK");

    await runtimeClient.query("BEGIN");
    await runtimeClient.query(
      "SELECT set_config('app.user_id', $1, true), " +
        "set_config('app.organization_id', $2, true)",
      [userA, organizationA.organization.id]
    );
    await expectSqlState(
      runtimeClient.query(
        "UPDATE public.product_variants SET sku = '  ' WHERE id = $1",
        [skuVariantB.id]
      ),
      "23514",
      "the database rejects noncanonical blank SKUs"
    );
    await runtimeClient.query("ROLLBACK");

    await runtimeClient.query("BEGIN");
    await runtimeClient.query(
      "SELECT set_config('app.user_id', $1, true), " +
        "set_config('app.organization_id', $2, true)",
      [userB, organizationB.organization.id]
    );
    const crossTenantSkuUpdate = await runtimeClient.query(
      "UPDATE public.product_variants SET sku = $1 WHERE id = $2 RETURNING id",
      ["cross-tenant-attempt", skuVariantB.id]
    );
    assert.equal(crossTenantSkuUpdate.rowCount, 0);
    await runtimeClient.query("ROLLBACK");

    const skuAudit = await adminPool.query<{
      entity_id: string;
      event_type: string;
    }>(
      "SELECT entity_id, event_type FROM public.tenant_audit_event " +
        "WHERE entity_id = ANY($1::text[]) AND event_type = $2 " +
        "ORDER BY entity_id, created_at",
      [[skuVariantA.id, skuVariantB.id], "product_variant.sku_changed"]
    );
    assert.equal(skuAudit.rows.length, 4);
    assert.equal(
      skuAudit.rows.filter((row) => row.entity_id === skuVariantA.id).length,
      3
    );
    assert.equal(
      skuAudit.rows.filter((row) => row.entity_id === skuVariantB.id).length,
      1
    );

    await runtimeClient.query("BEGIN");
    await runtimeClient.query(
      "SELECT set_config('app.user_id', $1, true), " +
        "set_config('app.organization_id', $2, true)",
      [userB, organizationB.organization.id]
    );
    assert.deepEqual(
      (
        await runtimeClient.query(
          "SELECT id FROM public.product_options WHERE product_id = $1",
          [configurableProduct.id]
        )
      ).rows,
      [],
      "cross-tenant runtime reads cannot see product options"
    );
    assert.deepEqual(
      (
        await runtimeClient.query(
          "SELECT variant_id FROM public.variant_option_values WHERE product_id = $1",
          [configurableProduct.id]
        )
      ).rows,
      [],
      "cross-tenant runtime reads cannot see variant assignments"
    );
    await runtimeClient.query("ROLLBACK");

    const limitedProduct = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userA,
        capability: "product:create",
        requestedOrganizationId: organizationA.organization.id,
      },
      (transaction, identity) =>
        createProduct(transaction, identity, {
          name: "Gate product over limit",
          requestId: randomUUID(),
        })
    );
    await expectProductVariantLimitDenied(
      adminPool,
      organizationA.organization.id,
      limitedProduct.id
    );

    const fiftyVariantProduct = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userA,
        capability: "product:create",
        requestedOrganizationId: organizationA.organization.id,
      },
      (transaction, identity) =>
        createProduct(transaction, identity, {
          name: "Gate product with fifty variants",
          requestId: randomUUID(),
        })
    );
    const fiftyModels = Array.from(
      { length: 50 },
      (_, index) => `Modelo ${index + 1}`
    );
    const fiftyVariantResult = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userA,
        capability: "product:update",
        requestedOrganizationId: organizationA.organization.id,
      },
      (transaction, identity) =>
        configureProductVariants(transaction, identity, {
          expectedVersion: 1,
          id: fiftyVariantProduct.id,
          options: [{ name: "model", values: fiftyModels }],
          requestId: randomUUID(),
          variants: fiftyModels.map((model) => ({ values: { model } })),
        })
    );
    assert.equal(fiftyVariantResult.configuration.variants.length, 50);

    const variantIdVersions = await adminPool.query<{ version: number }>(
      "SELECT uuid_extract_version(id) AS version " +
        "FROM public.product_variants WHERE product_id = ANY($1::uuid[])",
      [productIds]
    );
    assert.equal(variantIdVersions.rows.length, 3);
    assert.ok(variantIdVersions.rows.every((row) => row.version === 7));
    await expectProductWithoutVariantDenied(
      adminPool,
      organizationA.organization.id
    );
    await expectDefaultVariantRemovalRequiresReplacement(
      runtimeClient,
      userA,
      organizationA.organization.id,
      productA.id
    );

    await assert.rejects(
      withAuthorizedTenantTransaction(
        runtimeDb,
        {
          authenticatedUserId: userA,
          capability: "product:create",
          requestedOrganizationId: organizationA.organization.id,
        },
        (transaction, identity) =>
          createProduct(transaction, identity, {
            categoryId: categoryB.id,
            name: "Categoria de outro tenant",
          })
      ),
      ProductCategoryUnavailableError,
      "product cannot point at another tenant category"
    );

    const productListsA = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userA,
        capability: "catalog:read",
        requestedOrganizationId: organizationA.organization.id,
      },
      async (transaction, identity) => ({
        otherTenantRows: await transaction
          .select({ id: products.id })
          .from(products)
          .where(eq(products.organizationId, organizationB.organization.id)),
        products: await listProducts(transaction, identity, { status: "all" }),
      })
    );
    assert.deepEqual(
      productListsA.products.map((product) => product.id).sort(),
      [
        productA.id,
        duplicateProductA.id,
        configurableProduct.id,
        duplicateValueProduct.id,
        concurrentVariantProduct.id,
        limitedProduct.id,
        fiftyVariantProduct.id,
      ].sort()
    );
    assert.deepEqual(productListsA.otherTenantRows, []);

    const visibleA = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userA,
        capability: "catalog:read",
        requestedOrganizationId: organizationA.organization.id,
      },
      async (transaction, identity) => ({
        categories: await listCategories(transaction, identity),
        otherTenantRows: await transaction
          .select({ id: categories.id })
          .from(categories)
          .where(eq(categories.organizationId, organizationB.organization.id)),
      })
    );
    assert.deepEqual(visibleA.categories, [renamedCategory.category]);
    assert.deepEqual(visibleA.otherTenantRows, []);

    await expectForgedCategoryInsertDenied(
      runtimeClient,
      userA,
      organizationB.organization.id
    );
    await expectForgedCategoryUpdateHidden(
      runtimeClient,
      userA,
      organizationB.organization.id,
      categoryA.id
    );
    await expectCategoryHardDeleteDenied(
      runtimeClient,
      userA,
      organizationA.organization.id,
      categoryA.id
    );

    const updatedProduct = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userA,
        capability: "product:update",
        requestedOrganizationId: organizationA.organization.id,
      },
      (transaction, identity) =>
        updateProduct(transaction, identity, {
          categoryId: categoryA.id,
          description: "Lona resistente",
          expectedVersion: 1,
          id: productA.id,
          name: "Bolsa transversal",
          requestId: randomUUID(),
        })
    );
    assert.equal(updatedProduct.changed, true);
    assert.equal(updatedProduct.product.version, 2);
    await assert.rejects(
      withAuthorizedTenantTransaction(
        runtimeDb,
        {
          authenticatedUserId: userA,
          capability: "product:update",
          requestedOrganizationId: organizationA.organization.id,
        },
        (transaction, identity) =>
          updateProduct(transaction, identity, {
            categoryId: categoryA.id,
            description: "Concorrência obsoleta",
            expectedVersion: 1,
            id: productA.id,
            name: "Bolsa velha",
          })
      ),
      ProductVersionConflictError
    );

    const archivedProduct = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userA,
        capability: "product:update",
        requestedOrganizationId: organizationA.organization.id,
      },
      (transaction, identity) =>
        archiveProduct(transaction, identity, {
          expectedVersion: 2,
          id: productA.id,
          requestId: randomUUID(),
        })
    );
    assert.equal(archivedProduct.changed, true);
    assert.equal(archivedProduct.product.version, 3);
    const archiveProductRetry = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userA,
        capability: "product:update",
        requestedOrganizationId: organizationA.organization.id,
      },
      (transaction, identity) =>
        archiveProduct(transaction, identity, {
          expectedVersion: 2,
          id: productA.id,
        })
    );
    assert.equal(archiveProductRetry.changed, false);
    const activeProductsAfterArchive = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userA,
        capability: "catalog:read",
        requestedOrganizationId: organizationA.organization.id,
      },
      (transaction, identity) => listProducts(transaction, identity)
    );
    assert.deepEqual(
      activeProductsAfterArchive.map((product) => product.id).sort(),
      [
        duplicateProductA.id,
        configurableProduct.id,
        duplicateValueProduct.id,
        concurrentVariantProduct.id,
        limitedProduct.id,
        fiftyVariantProduct.id,
      ].sort()
    );
    const archivedProducts = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userA,
        capability: "catalog:read",
        requestedOrganizationId: organizationA.organization.id,
      },
      (transaction, identity) =>
        listProducts(transaction, identity, { status: "archived" })
    );
    assert.deepEqual(
      archivedProducts.map((product) => product.id),
      [productA.id]
    );
    const restoredProduct = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userA,
        capability: "product:update",
        requestedOrganizationId: organizationA.organization.id,
      },
      (transaction, identity) =>
        restoreProduct(transaction, identity, {
          expectedVersion: 3,
          id: productA.id,
          requestId: randomUUID(),
        })
    );
    assert.equal(restoredProduct.changed, true);
    assert.equal(restoredProduct.product.version, 4);

    await assert.rejects(
      withAuthorizedTenantTransaction(
        runtimeDb,
        {
          authenticatedUserId: userA,
          capability: "category:manage",
          requestedOrganizationId: organizationA.organization.id,
        },
        (transaction, identity) =>
          deleteCategory(transaction, identity, {
            id: categoryA.id,
          })
      ),
      CategoryInUseError,
      "category tombstone is blocked while a product points at it"
    );
    await expectCategoryTombstoneTriggerDenied(
      runtimeClient,
      userA,
      organizationA.organization.id,
      categoryA.id
    );

    const unlinkedProduct = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userA,
        capability: "product:update",
        requestedOrganizationId: organizationA.organization.id,
      },
      (transaction, identity) =>
        updateProduct(transaction, identity, {
          categoryId: null,
          description: "Lona resistente",
          expectedVersion: 4,
          id: productA.id,
          name: "Bolsa transversal",
          requestId: randomUUID(),
        })
    );
    assert.equal(unlinkedProduct.changed, true);
    assert.equal(unlinkedProduct.product.version, 5);

    const archivedCategory = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userA,
        capability: "category:manage",
        requestedOrganizationId: organizationA.organization.id,
      },
      (transaction, identity) =>
        archiveCategory(transaction, identity, {
          id: categoryA.id,
          requestId: randomUUID(),
        })
    );
    assert.equal(archivedCategory.changed, true);
    assert.ok(archivedCategory.category.archivedAt instanceof Date);
    assert.deepEqual(
      await withAuthorizedTenantTransaction(
        runtimeDb,
        {
          authenticatedUserId: userA,
          capability: "catalog:read",
          requestedOrganizationId: organizationA.organization.id,
        },
        (transaction, identity) => listCategories(transaction, identity)
      ),
      []
    );
    assert.deepEqual(
      await withAuthorizedTenantTransaction(
        runtimeDb,
        {
          authenticatedUserId: userA,
          capability: "catalog:read",
          requestedOrganizationId: organizationA.organization.id,
        },
        (transaction, identity) =>
          listCategories(transaction, identity, { status: "archived" })
      ),
      [archivedCategory.category]
    );

    const archiveRetry = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userA,
        capability: "category:manage",
        requestedOrganizationId: organizationA.organization.id,
      },
      (transaction, identity) =>
        archiveCategory(transaction, identity, { id: categoryA.id })
    );
    assert.equal(archiveRetry.changed, false);

    const restoredCategory = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userA,
        capability: "category:manage",
        requestedOrganizationId: organizationA.organization.id,
      },
      (transaction, identity) =>
        restoreCategory(transaction, identity, {
          id: categoryA.id,
          requestId: randomUUID(),
        })
    );
    assert.equal(restoredCategory.changed, true);
    assert.equal(restoredCategory.category.archivedAt, null);

    const deletedCategory = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userA,
        capability: "category:manage",
        requestedOrganizationId: organizationA.organization.id,
      },
      (transaction, identity) =>
        deleteCategory(transaction, identity, {
          id: categoryA.id,
          requestId: randomUUID(),
        })
    );
    assert.equal(deletedCategory.changed, true);
    assert.ok(deletedCategory.category.deletedAt instanceof Date);
    await assert.rejects(
      withAuthorizedTenantTransaction(
        runtimeDb,
        {
          authenticatedUserId: userA,
          capability: "category:manage",
          requestedOrganizationId: organizationA.organization.id,
        },
        (transaction, identity) =>
          restoreCategory(transaction, identity, { id: categoryA.id })
      ),
      CategoryLifecycleError
    );
    const deletedRetry = await withAuthorizedTenantTransaction(
      runtimeDb,
      {
        authenticatedUserId: userA,
        capability: "category:manage",
        requestedOrganizationId: organizationA.organization.id,
      },
      (transaction, identity) =>
        deleteCategory(transaction, identity, { id: categoryA.id })
    );
    assert.equal(deletedRetry.changed, false);
    await assert.rejects(
      withAuthorizedTenantTransaction(
        runtimeDb,
        {
          authenticatedUserId: userA,
          capability: "category:manage",
          requestedOrganizationId: organizationA.organization.id,
        },
        (transaction, identity) =>
          renameCategory(transaction, identity, {
            id: categoryA.id,
            name: "Outro nome",
          })
      ),
      CategoryDeletedError
    );
    await assert.rejects(
      withAuthorizedTenantTransaction(
        runtimeDb,
        {
          authenticatedUserId: userA,
          capability: "category:create",
          requestedOrganizationId: organizationA.organization.id,
        },
        (transaction, identity) =>
          createCategory(transaction, identity, {
            name: "acessórios",
          })
      ),
      CategoryNameConflictError
    );
    assert.deepEqual(
      await withAuthorizedTenantTransaction(
        runtimeDb,
        {
          authenticatedUserId: userA,
          capability: "catalog:read",
          requestedOrganizationId: organizationA.organization.id,
        },
        (transaction, identity) =>
          listCategories(transaction, identity, { status: "deleted" })
      ),
      [deletedCategory.category]
    );

    let rolledBackCategoryId: string | undefined;
    await assert.rejects(
      withAuthorizedTenantTransaction(
        runtimeDb,
        {
          authenticatedUserId: userA,
          capability: "category:create",
          requestedOrganizationId: organizationA.organization.id,
        },
        async (transaction, identity) => {
          const category = await createCategory(transaction, identity, {
            name: "Rollback",
            requestId: randomUUID(),
          });
          rolledBackCategoryId = category.id;
          throw new Error("intentional Gate 2 rollback");
        }
      ),
      rollbackMessagePattern
    );
    assert.ok(rolledBackCategoryId);
    assert.deepEqual(
      (
        await adminPool.query(
          "SELECT id FROM public.categories WHERE id = $1",
          [rolledBackCategoryId]
        )
      ).rows,
      []
    );
    assert.deepEqual(
      (
        await adminPool.query(
          "SELECT id FROM public.tenant_audit_event WHERE entity_id = $1",
          [rolledBackCategoryId]
        )
      ).rows,
      []
    );

    const categoryAudit = await adminPool.query(
      "SELECT entity_id, actor_user_id, organization_id " +
        "FROM public.tenant_audit_event WHERE event_type = 'category.created' " +
        "AND entity_id = ANY($1::text[])",
      [[categoryA.id, categoryB.id]]
    );
    assert.equal(categoryAudit.rows.length, 2);

    const categoryLifecycleAudit = await adminPool.query<{
      event_type: string;
    }>(
      "SELECT event_type FROM public.tenant_audit_event " +
        "WHERE entity_id = $1 AND event_type <> 'category.created' " +
        "ORDER BY event_type",
      [categoryA.id]
    );
    assert.deepEqual(
      categoryLifecycleAudit.rows.map((row) => row.event_type),
      [
        "category.archived",
        "category.deleted",
        "category.renamed",
        "category.restored",
      ]
    );

    const productAudit = await adminPool.query<{ event_type: string }>(
      "SELECT event_type FROM public.tenant_audit_event " +
        "WHERE entity_id = $1 ORDER BY event_type",
      [productA.id]
    );
    assert.deepEqual(
      productAudit.rows.map((row) => row.event_type),
      [
        "product.archived",
        "product.created",
        "product.restored",
        "product.updated",
        "product.updated",
      ]
    );

    await adminPool.query("DELETE FROM public.organizations WHERE id = $1", [
      organizationB.organization.id,
    ]);
    fixtureOrganizations.splice(
      fixtureOrganizations.indexOf(organizationB.organization.id),
      1
    );
    assert.deepEqual(
      (
        await adminPool.query(
          "SELECT id FROM public.categories WHERE id = $1",
          [categoryB.id]
        )
      ).rows,
      []
    );
    assert.deepEqual(
      (
        await adminPool.query(
          "SELECT id FROM public.products WHERE id = $1 " +
            "UNION ALL SELECT id FROM public.product_variants WHERE product_id = $1",
          [productB.id]
        )
      ).rows,
      [],
      "organization cascade removes products and their variants"
    );
    assert.deepEqual(
      (
        await adminPool.query(
          "SELECT id FROM public.tenant_audit_event WHERE entity_id = $1",
          [categoryB.id]
        )
      ).rows,
      []
    );

    passed = true;
    console.log(
      JSON.stringify({
        categoryIsolationAndAudit: "passed",
        categoryLifecycleAndUniqueName: "passed",
        categoryProductTombstoneProtection: "passed",
        directOnboardingDml: "denied",
        onboardingAtomicRetryAndAudit: "passed",
        onboardingRole,
        onboardingRoleCanExecuteOnboarding: true,
        postgresMajorVersion: 18,
        postgresServerVersion: server.rows[0]?.version,
        productAtomicVariantAndUuidV7: "passed",
        productLifecycleConcurrencyAndAudit: "passed",
        productVariantConfigurationAndAudit: "passed",
        productVariantLimit: "passed",
        productVariantSkuAssignmentUniquenessAndAudit: "passed",
        productVariantsConcurrentConfigurationOneWinner: "passed",
        publicExecute: false,
        rlsTables: [
          "categories",
          "memberships",
          "organizations",
          "product_option_values",
          "product_options",
          "product_variants",
          "products",
          "tenant_audit_event",
          "variant_option_values",
        ],
        rollbackAndCascade: "passed",
        status: "passed",
        tenantRole: runtimeRole,
        tenantRoleCanExecuteOnboarding: false,
      })
    );
  } finally {
    const cleanupErrors: unknown[] = [];
    if (connected) {
      try {
        await runtimeClient.query("RESET ROLE");
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (adminRole && grantedRuntimeRole) {
      try {
        await adminPool.query(`REVOKE ${runtimeRole} FROM ${adminRole}`);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (adminRole && grantedOnboardingRole) {
      try {
        await adminPool.query(`REVOKE ${onboardingRole} FROM ${adminRole}`);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    const organizationCleanup = await Promise.allSettled(
      fixtureOrganizations.map((organizationId) =>
        adminPool.query("DELETE FROM public.organizations WHERE id = $1", [
          organizationId,
        ])
      )
    );
    for (const result of organizationCleanup) {
      if (result.status === "rejected") {
        cleanupErrors.push(result.reason);
      }
    }
    const userCleanup = await Promise.allSettled(
      fixtureUsers.map((userId) =>
        adminPool.query('DELETE FROM public."user" WHERE id = $1', [userId])
      )
    );
    for (const result of userCleanup) {
      if (result.status === "rejected") {
        cleanupErrors.push(result.reason);
      }
    }
    await Promise.allSettled([
      connected ? runtimeClient.end() : Promise.resolve(),
      adminPool.end(),
    ]);
    if (cleanupErrors.length > 0) {
      process.exitCode = 1;
      console.error("gate2_database_cleanup=failed", cleanupErrors.length);
      for (const error of cleanupErrors) {
        const message = error instanceof Error ? error.message : "unknown";
        console.error(
          "gate2_database_cleanup_error",
          redactConnectionDetails(message, connectionString)
        );
      }
    }
    if (!passed) {
      console.error("gate2_runtime=failed");
    }
  }
}

main().catch((error: unknown) => {
  const connectionString = process.env.POLARIS_GATE2_TEST_DATABASE_URL ?? "";
  const message = error instanceof Error ? error.message : "unknown error";
  const sourceFrame =
    error instanceof Error
      ? error.stack
          ?.split(errorStackLineBreak)
          .find((line) => line.includes("verify-gate2-runtime.ts:"))
          ?.trim()
      : undefined;
  console.error(
    "gate2_runtime=failed",
    error instanceof Error ? error.name : "UnknownError",
    message.replaceAll(connectionString, "[redacted]"),
    sourceFrame
  );
  process.exitCode = 1;
});
