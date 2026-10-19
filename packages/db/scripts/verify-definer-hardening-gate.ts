// biome-ignore-all lint/performance/noAwaitInLoops: a gate runs its probes strictly one at a time, for a clear failure
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import {
  disposableHostPattern,
  gateBranchPattern,
  journalMigrationCount,
  poolerPattern,
  redactedFailure,
  requiredEnvironment,
} from "./sales-gate-support";

/**
 * Hardening of the SECURITY DEFINER functions and of the default privileges (security finding A2) on a real
 * PostgreSQL 18. A function that runs with its owner's rights and resolves a name through a search_path that does not
 * end in `pg_temp` lets whoever can create a temporary object shadow that name and act as the owner. So, in the whole
 * database:
 *   1. every SECURITY DEFINER function fixes a search_path that ends in `pg_temp`;
 *   2. no runtime role (`polaris_*_runtime`, the members of those groups and the gate runner logins) has TEMPORARY on the database or CREATE on
 *      schema public, directly or through PUBLIC;
 *   3. no SECURITY DEFINER function is executable by PUBLIC (an absent ACL means PUBLIC may execute).
 * The gate then proves it can fail: it creates a throwaway function without `pg_temp` and without a REVOKE, and grants
 * TEMPORARY and CREATE to a runtime role, and each of the three checks must report exactly that; everything is undone.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

// a runtime role is a `polaris_*_runtime` group, a temporary gate login, or any role that is a member of such a group
// (production logins have free names); PUBLIC is checked on its own, because every role inherits from it
const RUNTIME_GROUP_PATTERN = "^polaris_.+_runtime$";
const RUNTIME_ROLE_PATTERN = "^polaris_gate_runner_[0-9a-f]+$";
const MIN_DEFINER_FUNCTIONS = 87;
const SEARCH_PATH_PREFIX = "search_path=";
const SEARCH_PATH_SPLIT = /\s*,\s*/;
const PROBE_ROLE = "polaris_catalog_runtime";

interface DefinerRow {
  config: string[] | null;
  publicExecute: boolean;
  signature: string;
}

interface Findings {
  createInPublic: string[];
  publicExecute: string[];
  temporary: string[];
  unpinned: string[];
}

function endsInPgTemp(config: string[] | null): boolean {
  const entry = (config ?? []).find((item) =>
    item.startsWith(SEARCH_PATH_PREFIX)
  );
  if (!entry) {
    return false;
  }
  const path = entry
    .slice(SEARCH_PATH_PREFIX.length)
    .split(SEARCH_PATH_SPLIT)
    .map((item) => item.replaceAll('"', ""));
  return path.at(-1) === "pg_temp";
}

async function findViolations(client: Client): Promise<Findings> {
  // functions that belong to an extension are not ours to change (today the only extension is plpgsql, with none)
  const definers = await client.query<DefinerRow>(
    `SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS signature,
            p.proconfig AS config,
            has_function_privilege('public', p.oid, 'EXECUTE') AS "publicExecute"
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.prosecdef
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg\\_toast%'
        AND NOT EXISTS (
          SELECT 1 FROM pg_depend d
           WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
        )
      ORDER BY 1`
  );
  const unpinned = definers.rows
    .filter((row) => !endsInPgTemp(row.config))
    .map((row) => row.signature);
  const publicExecute = definers.rows
    .filter((row) => row.publicExecute)
    .map((row) => row.signature);
  const roles = await client.query<{
    can_create: boolean;
    can_temp: boolean;
    rolname: string;
  }>(
    `SELECT rolname,
            has_database_privilege(oid, current_database(), 'TEMPORARY') AS can_temp,
            has_schema_privilege(oid, 'public', 'CREATE') AS can_create
       FROM pg_roles
      WHERE rolname ~ $2
         OR EXISTS (
           SELECT 1 FROM pg_roles g
            WHERE g.rolname ~ $1 AND pg_has_role(pg_roles.oid, g.oid, 'MEMBER')
         )
      ORDER BY 1`,
    [RUNTIME_GROUP_PATTERN, RUNTIME_ROLE_PATTERN]
  );
  const publicRights = await client.query<{
    can_create: boolean;
    can_temp: boolean;
  }>(
    `SELECT has_database_privilege('public', current_database(), 'TEMPORARY') AS can_temp,
            has_schema_privilege('public', 'public', 'CREATE') AS can_create`
  );
  const [pub] = publicRights.rows;
  assert.ok(pub);
  return {
    createInPublic: [
      ...(pub.can_create ? ["PUBLIC"] : []),
      ...roles.rows.filter((row) => row.can_create).map((row) => row.rolname),
    ],
    publicExecute,
    temporary: [
      ...(pub.can_temp ? ["PUBLIC"] : []),
      ...roles.rows.filter((row) => row.can_temp).map((row) => row.rolname),
    ],
    unpinned,
  };
}

function assertClean(findings: Findings) {
  assert.deepEqual(
    findings.unpinned,
    [],
    "SECURITY DEFINER functions whose search_path does not end in pg_temp"
  );
  assert.deepEqual(
    findings.temporary,
    [],
    "runtime roles with TEMPORARY on the database"
  );
  assert.deepEqual(
    findings.createInPublic,
    [],
    "runtime roles with CREATE on schema public"
  );
  assert.deepEqual(
    findings.publicExecute,
    [],
    "SECURITY DEFINER functions executable by PUBLIC"
  );
}

async function run() {
  const branch = requiredEnvironment("POLARIS_SALES_GATE_BRANCH");
  assert.match(branch, gateBranchPattern);
  const adminUrl = requiredEnvironment("POLARIS_SALES_GATE_DATABASE_URL");
  const parsedAdminUrl = new URL(adminUrl);
  assert.match(parsedAdminUrl.hostname, disposableHostPattern);
  assert.doesNotMatch(parsedAdminUrl.hostname, poolerPattern);

  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  const tests: string[] = [];
  const cleanupFailures: string[] = [];
  const probe = `gate_definer_probe_${randomUUID().slice(0, 8).replaceAll("-", "")}`;
  let probeCreated = false;
  let schemaCreated = false;
  let publicTemporaryGranted = false;
  let publicCreateGranted = false;
  let temporaryGranted = false;
  let createGranted = false;
  let primaryFailure = false;

  try {
    const server = await client.query<{
      database_name: string;
      server_version_num: string;
    }>(
      "SELECT current_database() AS database_name, current_setting('server_version_num') AS server_version_num"
    );
    const [serverRow] = server.rows;
    assert.ok(serverRow);
    assert.equal(serverRow.database_name, expectedDatabase);
    assert.ok(Number(serverRow.server_version_num) >= 180_000);
    const migrations = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations"
    );
    assert.equal(Number(migrations.rows[0]?.count), journalMigrationCount());
    tests.push(
      "disposable direct connection is PostgreSQL 18 with every migration replayed from scratch"
    );

    const clean = await findViolations(client);
    assertClean(clean);
    const definers = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.prosecdef AND n.nspname = 'public'"
    );
    assert.ok(Number(definers.rows[0]?.count) >= MIN_DEFINER_FUNCTIONS);
    const runtimeRoles = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pg_roles WHERE rolname ~ $1",
      [RUNTIME_GROUP_PATTERN]
    );
    assert.ok(Number(runtimeRoles.rows[0]?.count) > 0);
    tests.push(
      `all ${definers.rows[0]?.count} SECURITY DEFINER functions fix a search_path that ends in pg_temp and none is executable by PUBLIC; none of the ${runtimeRoles.rows[0]?.count} runtime roles has TEMPORARY on the database or CREATE on schema public`
    );

    // the gate can fail: a definer function with no search_path and the default ACL
    await client.query(
      `CREATE FUNCTION public.${probe}() RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'`
    );
    probeCreated = true;
    const withProbe = await findViolations(client);
    assert.deepEqual(withProbe.unpinned, [`public.${probe}()`]);
    assert.deepEqual(withProbe.publicExecute, [`public.${probe}()`]);
    await client.query(
      `ALTER FUNCTION public.${probe}() SET search_path = pg_catalog, public`
    );
    assert.deepEqual((await findViolations(client)).unpinned, [
      `public.${probe}()`,
    ]);
    await client.query(
      `ALTER FUNCTION public.${probe}() SET search_path = pg_catalog, pg_temp, public`
    );
    assert.deepEqual((await findViolations(client)).unpinned, [
      `public.${probe}()`,
    ]);
    await client.query(
      `ALTER FUNCTION public.${probe}() SET search_path = pg_catalog, public, pg_temp`
    );
    await client.query(
      `REVOKE EXECUTE ON FUNCTION public.${probe}() FROM PUBLIC`
    );
    assertClean(await findViolations(client));
    tests.push(
      "a SECURITY DEFINER function with no search_path (or one that does not end in pg_temp) and with EXECUTE for PUBLIC is reported by the gate, and passes once fixed"
    );

    // and in any other schema, not only public
    await client.query(`CREATE SCHEMA ${probe}`);
    schemaCreated = true;
    await client.query(
      `CREATE FUNCTION ${probe}.f() RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'`
    );
    const otherSchema = await findViolations(client);
    assert.deepEqual(otherSchema.unpinned, [`${probe}.f()`]);
    assert.deepEqual(otherSchema.publicExecute, [`${probe}.f()`]);
    await client.query(`DROP SCHEMA ${probe} CASCADE`);
    schemaCreated = false;
    assertClean(await findViolations(client));

    // the gate can fail: PUBLIC with TEMPORARY or CREATE (every runtime role inherits it)
    await client.query(
      `GRANT TEMPORARY ON DATABASE "${expectedDatabase}" TO PUBLIC`
    );
    publicTemporaryGranted = true;
    const publicTemp = await findViolations(client);
    assert.equal(publicTemp.temporary[0], "PUBLIC");
    assert.ok(publicTemp.temporary.includes(PROBE_ROLE));
    await client.query(
      `REVOKE TEMPORARY ON DATABASE "${expectedDatabase}" FROM PUBLIC`
    );
    publicTemporaryGranted = false;
    await client.query("GRANT CREATE ON SCHEMA public TO PUBLIC");
    publicCreateGranted = true;
    const publicCreate = await findViolations(client);
    assert.equal(publicCreate.createInPublic[0], "PUBLIC");
    assert.ok(publicCreate.createInPublic.includes(PROBE_ROLE));
    await client.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    publicCreateGranted = false;
    assertClean(await findViolations(client));

    // the gate can fail: a runtime role with TEMPORARY or CREATE
    await client.query(
      `GRANT TEMPORARY ON DATABASE "${expectedDatabase}" TO ${PROBE_ROLE}`
    );
    temporaryGranted = true;
    assert.deepEqual((await findViolations(client)).temporary, [
      PROBE_ROLE,
    ]);
    await client.query(
      `REVOKE TEMPORARY ON DATABASE "${expectedDatabase}" FROM ${PROBE_ROLE}`
    );
    temporaryGranted = false;
    await client.query(`GRANT CREATE ON SCHEMA public TO ${PROBE_ROLE}`);
    createGranted = true;
    assert.deepEqual((await findViolations(client)).createInPublic, [
      PROBE_ROLE,
    ]);
    await client.query(
      `REVOKE CREATE ON SCHEMA public FROM ${PROBE_ROLE}`
    );
    createGranted = false;
    assertClean(await findViolations(client));
    tests.push(
      "PUBLIC or a runtime role (or a member of one) granted TEMPORARY on the database, or CREATE on schema public, is reported by the gate; so is a function in any schema"
    );
  } catch (error) {
    primaryFailure = true;
    throw error;
  } finally {
    const cleanup = async (label: string, statement: string) => {
      try {
        await client.query(statement);
      } catch (error) {
        cleanupFailures.push(`${label} (${redactedFailure(error)})`);
      }
    };
    if (publicTemporaryGranted) {
      await cleanup(
        "revoke public temporary",
        `REVOKE TEMPORARY ON DATABASE "${expectedDatabase}" FROM PUBLIC`
      );
    }
    if (publicCreateGranted) {
      await cleanup(
        "revoke public create",
        "REVOKE CREATE ON SCHEMA public FROM PUBLIC"
      );
    }
    if (schemaCreated) {
      await cleanup("probe schema", `DROP SCHEMA IF EXISTS ${probe} CASCADE`);
    }
    if (temporaryGranted) {
      await cleanup(
        "revoke temporary",
        `REVOKE TEMPORARY ON DATABASE "${expectedDatabase}" FROM ${PROBE_ROLE}`
      );
    }
    if (createGranted) {
      await cleanup(
        "revoke create",
        `REVOKE CREATE ON SCHEMA public FROM ${PROBE_ROLE}`
      );
    }
    if (probeCreated) {
      await cleanup("probe", `DROP FUNCTION IF EXISTS public.${probe}()`);
    }
    await client.end();
    if (cleanupFailures.length > 0) {
      console.error(
        `Definer hardening gate cleanup failed: ${cleanupFailures.join("; ")}`
      );
      if (!primaryFailure) {
        process.exitCode = 1;
      }
    }
  }

  console.log(
    JSON.stringify({ branch, database: expectedDatabase, tests }, null, 2)
  );
}

run().catch((error: unknown) => {
  console.error(
    `Definer hardening PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
