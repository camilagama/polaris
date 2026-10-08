import assert from "node:assert/strict";
import { Pool } from "pg";

const runtimeRole = "polaris_pr11_runtime";
const expectedConfirmation = "polaris-pr22-tenant-context-disposable";
const expectedHostnamePattern =
  /^ep-[a-z-]+-[a-z0-9]+\.[a-z0-9-]+\.sa-east-1\.aws\.neon\.tech$/;
const retryTokenPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const expectedSeeds = [
  {
    organization_id: "org_a",
    token: "seed-a",
    value: "synthetic data for org_a",
  },
  {
    organization_id: "org_b",
    token: "seed-b",
    value: "synthetic data for org_b",
  },
];

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error("Missing required PR22 disposable database configuration.");
  }
  return value;
}

async function main() {
  const connectionString = requiredEnvironment(
    "POLARIS_TENANT_CONTEXT_TEST_DATABASE_URL"
  );
  const expectedHostname = requiredEnvironment(
    "POLARIS_TENANT_CONTEXT_TEST_EXPECTED_HOSTNAME"
  );
  if (
    process.env.POLARIS_TENANT_CONTEXT_TEST_CONFIRM_DISPOSABLE !==
    expectedConfirmation
  ) {
    throw new Error(
      "The PR22 fixture reconciliation requires its disposable-branch confirmation."
    );
  }

  let databaseUrl: URL;
  try {
    databaseUrl = new URL(connectionString);
  } catch (error) {
    throw new Error("A valid direct Neon URL is required.", { cause: error });
  }
  assert.equal(databaseUrl.hostname, expectedHostname);
  assert.equal(databaseUrl.pathname, "/neondb");
  assert.equal(databaseUrl.hostname.includes("-pooler"), false);
  assert.match(databaseUrl.hostname, expectedHostnamePattern);

  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 5000,
    max: 1,
  });

  try {
    const identity = await pool.query<{
      admin_bypass_rls: boolean;
      current_user: string;
      database: string;
      server_version: string;
    }>(
      "SELECT current_database() AS database, " +
        "current_setting('server_version') AS server_version, " +
        "current_user AS current_user, " +
        "(SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS admin_bypass_rls"
    );
    assert.equal(identity.rows[0]?.database, "neondb");
    assert.equal(
      Number.parseInt(identity.rows[0]?.server_version.split(".")[0] ?? "", 10),
      18
    );
    assert.equal(identity.rows[0]?.admin_bypass_rls, true);

    const runtimeRoleState = await pool.query<{
      bypass_rls: boolean;
      superuser: boolean;
    }>(
      "SELECT rolbypassrls AS bypass_rls, rolsuper AS superuser " +
        "FROM pg_roles WHERE rolname = $1",
      [runtimeRole]
    );
    assert.deepEqual(runtimeRoleState.rows[0], {
      bypass_rls: false,
      superuser: false,
    });

    const publicObjects = await pool.query<{
      kind: string;
      name: string;
    }>(
      "SELECT relation.relname AS name, relation.relkind AS kind " +
        "FROM pg_class AS relation " +
        "JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace " +
        "WHERE namespace.nspname = 'public' " +
        "AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f') " +
        "AND relation.relpersistence <> 't' " +
        "ORDER BY relation.relname"
    );
    assert.deepEqual(publicObjects.rows, [
      { kind: "r", name: "rls_poc_operations" },
    ]);

    const journal = await pool.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM drizzle.__drizzle_migrations"
    );
    assert.equal(journal.rows[0]?.count, 0);

    const tableState = await pool.query<{
      all_columns_not_null: boolean;
      column_names: string;
      column_types: string;
      force_rls: boolean;
      owner: string;
      primary_key: string | null;
      rls_enabled: boolean;
    }>(
      "SELECT relation.relrowsecurity AS rls_enabled, " +
        "relation.relforcerowsecurity AS force_rls, " +
        "pg_get_userbyid(relation.relowner) AS owner, " +
        "(SELECT string_agg(attribute.attname::text, ',' ORDER BY attribute.attnum) " +
        "FROM pg_attribute AS attribute WHERE attribute.attrelid = relation.oid " +
        "AND attribute.attnum > 0 AND NOT attribute.attisdropped) AS column_names, " +
        "(SELECT string_agg(pg_catalog.format_type(attribute.atttypid, attribute.atttypmod), ',' ORDER BY attribute.attnum) " +
        "FROM pg_attribute AS attribute WHERE attribute.attrelid = relation.oid " +
        "AND attribute.attnum > 0 AND NOT attribute.attisdropped) AS column_types, " +
        "(SELECT bool_and(attribute.attnotnull) FROM pg_attribute AS attribute " +
        "WHERE attribute.attrelid = relation.oid AND attribute.attnum > 0 AND NOT attribute.attisdropped) AS all_columns_not_null, " +
        "(SELECT pg_get_constraintdef(constraint_row.oid) FROM pg_constraint AS constraint_row " +
        "WHERE constraint_row.conrelid = relation.oid AND constraint_row.contype = 'p') AS primary_key " +
        "FROM pg_class AS relation WHERE relation.oid = 'public.rls_poc_operations'::regclass"
    );
    assert.deepEqual(tableState.rows[0], {
      all_columns_not_null: true,
      column_names: "organization_id,token,value",
      column_types: "text,text,text",
      force_rls: true,
      owner: identity.rows[0]?.current_user,
      primary_key: "PRIMARY KEY (organization_id, token)",
      rls_enabled: true,
    });

    const policies = await pool.query<{
      command: string;
      policy_name: string;
      roles: string;
      using_expression: string | null;
      with_check: string | null;
    }>(
      "SELECT policyname AS policy_name, cmd AS command, roles, " +
        "qual AS using_expression, with_check " +
        "FROM pg_policies WHERE schemaname = 'public' " +
        "AND tablename = 'rls_poc_operations'"
    );
    assert.equal(policies.rows.length, 1);
    const [fixturePolicy] = policies.rows;
    assert.equal(
      fixturePolicy?.policy_name,
      "rls_poc_operations_organization_isolation"
    );
    assert.equal(fixturePolicy?.command, "ALL");
    assert.equal(fixturePolicy?.roles, "{public}");
    assert.equal(
      normalizePolicyExpression(fixturePolicy?.using_expression),
      "organization_id=current_setting('app.organization_id'::text,true)"
    );
    assert.equal(
      normalizePolicyExpression(fixturePolicy?.with_check),
      "organization_id=current_setting('app.organization_id'::text,true)"
    );

    const grants = await pool.query<{
      can_delete: boolean;
      can_insert: boolean;
      can_select: boolean;
      can_update: boolean;
      has_grant_option: boolean;
    }>(
      "SELECT has_table_privilege($1, 'public.rls_poc_operations', 'SELECT') AS can_select, " +
        "has_table_privilege($1, 'public.rls_poc_operations', 'INSERT') AS can_insert, " +
        "has_table_privilege($1, 'public.rls_poc_operations', 'UPDATE') AS can_update, " +
        "has_table_privilege($1, 'public.rls_poc_operations', 'DELETE') AS can_delete, " +
        "COALESCE((SELECT bool_or(is_grantable = 'YES') FROM information_schema.role_table_grants " +
        "WHERE grantee = $1 AND table_schema = 'public' AND table_name = 'rls_poc_operations'), false) AS has_grant_option",
      [runtimeRole]
    );
    assert.deepEqual(grants.rows[0], {
      can_delete: true,
      can_insert: true,
      can_select: true,
      can_update: true,
      has_grant_option: false,
    });

    const seeds = await pool.query<{
      organization_id: string;
      token: string;
      value: string;
    }>(
      "SELECT organization_id, token, value FROM public.rls_poc_operations " +
        "ORDER BY organization_id"
    );
    const hasAllBaseSeeds = expectedSeeds.every((seed) =>
      seeds.rows.some(
        (row) =>
          row.organization_id === seed.organization_id &&
          row.token === seed.token &&
          row.value === seed.value
      )
    );
    assert.ok(hasAllBaseSeeds);
    const extraRows = seeds.rows.filter(
      (row) =>
        !expectedSeeds.some(
          (seed) =>
            row.organization_id === seed.organization_id &&
            row.token === seed.token &&
            row.value === seed.value
        )
    );
    assert.ok(extraRows.length <= 1);
    if (extraRows.length === 1) {
      const [retryRow] = extraRows;
      assert.ok(retryRow);
      assert.equal(retryRow?.organization_id, "org_a");
      assert.equal(retryRow?.value, "retry survives once");
      assert.match(retryRow?.token ?? "", retryTokenPattern);
    }

    await pool.query("BEGIN");
    try {
      await pool.query("DROP TABLE public.rls_poc_operations");
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }

    console.log(
      JSON.stringify({
        actions: ["verified fixture", "dropped only rls_poc_operations"],
        database: "neondb",
        migrationsJournalWasEmpty: true,
        next: "run Drizzle db:migrate immediately, then the PR22 tenant gate",
        postgresMajorVersion: 18,
        reconciledFixture: "exact synthetic PR11 RLS table and seed rows",
        status: "prepared",
      })
    );
  } finally {
    await pool.end();
  }
}

function normalizePolicyExpression(
  expression: string | null | undefined
): string {
  const normalized = (expression ?? "").replaceAll('"', "").replaceAll(" ", "");
  return normalized.startsWith("(") && normalized.endsWith(")")
    ? normalized.slice(1, -1)
    : normalized;
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "PR22 fixture preparation failed."
  );
  process.exitCode = 1;
});
