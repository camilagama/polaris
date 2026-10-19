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
 *      schema public, directly or through PUBLIC, and neither has any role it can reach with SET ROLE;
 *   3. no runtime role is the database owner (`datdba`) or a superuser, or a member (with SET or INHERIT) of the database owner,
 *      of `neon_superuser` (when it exists) or of any `*_owner` role;
 *   4. no SECURITY DEFINER function is executable by PUBLIC (an absent ACL means PUBLIC may execute).
 * The gate then proves it can fail: it creates a throwaway function without `pg_temp` and without a REVOKE, grants
 * TEMPORARY and CREATE to a runtime role, makes a throwaway runtime login the database owner or a member of an owner role,
 * and each check must report exactly that; everything is undone.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

// a runtime role is a `polaris_*_runtime` group, a temporary gate login, or any role that is a member of such a group
// (production logins have free names); PUBLIC is checked on its own, because every role inherits from it. Membership is explicit (pg_auth_members, followed through groups): pg_has_role says a superuser is a member of everything. A runtime role that is a superuser or the database owner is reported as such and left out of the membership checks
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
  ownerMembership: string[];
  privilegedRuntime: string[];
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
  // runtime roles (see RUNTIME_*_PATTERN); the checks below also follow SET ROLE chains through pg_has_role
  const runtime = `
    WITH RECURSIVE closure(member, roleid) AS (
      SELECT member, roleid FROM pg_auth_members
      UNION
      SELECT c.member, m.roleid FROM closure c JOIN pg_auth_members m ON m.member = c.roleid
    ),
    runtime AS (
      SELECT r.oid, r.rolname, r.rolsuper, r.rolcreaterole, r.rolreplication, r.rolbypassrls, r.oid = d.datdba AS is_owner
        FROM pg_roles r, pg_database d
       WHERE d.datname = current_database()
         AND (r.rolname ~ $2
          OR r.rolname ~ $1
          OR EXISTS (
            SELECT 1 FROM closure c JOIN pg_roles g ON g.oid = c.roleid
             WHERE c.member = r.oid AND g.rolname ~ $1
          ))
    )`;
  const privileged = await client.query<{ reason: string; rolname: string }>(
    `${runtime}
     SELECT rolname,
            CASE WHEN is_owner THEN 'database owner'
                 WHEN rolsuper THEN 'superuser'
                 ELSE 'CREATEROLE, REPLICATION or BYPASSRLS' END AS reason
       FROM runtime
      WHERE is_owner OR rolsuper OR rolcreaterole OR rolreplication OR rolbypassrls
      ORDER BY 1`,
    [RUNTIME_GROUP_PATTERN, RUNTIME_ROLE_PATTERN]
  );
  // owner roles: the database owner, neon_superuser (when it exists), every *_owner role (pg_database_owner is the database owner
  // by another name), any superuser and the predefined roles that read or write files, run programs or bypass table privileges;
  // the login reaches one when a role it can become with SET ROLE (itself included) inherits it, can SET to it or has ADMIN OPTION on it
  // (whoever has ADMIN OPTION can grant itself SET and INHERIT)
  const membership = await client.query<{ login: string; target: string }>(
    `${runtime}
     SELECT DISTINCT runtime.rolname AS login, t.rolname AS target
       FROM runtime
       JOIN pg_roles via ON pg_has_role(runtime.oid, via.oid, 'SET')
       JOIN pg_roles t ON t.oid <> via.oid
        AND (t.oid = (SELECT datdba FROM pg_database WHERE datname = current_database())
          OR t.rolname = 'neon_superuser'
          OR t.rolname LIKE '%\\_owner'
          OR t.rolsuper
          OR t.rolname IN ('pg_execute_server_program', 'pg_read_server_files', 'pg_write_server_files', 'pg_read_all_data', 'pg_write_all_data'))
      WHERE NOT runtime.rolsuper AND NOT runtime.is_owner
        AND t.rolname <> 'pg_database_owner'
        AND (pg_has_role(via.oid, t.oid, 'SET')
          OR pg_has_role(via.oid, t.oid, 'USAGE')
          OR EXISTS (
            SELECT 1 FROM pg_auth_members a
             WHERE a.roleid = t.oid AND a.admin_option
               AND (pg_has_role(via.oid, a.member, 'SET') OR pg_has_role(via.oid, a.member, 'USAGE'))
          ))
      ORDER BY 1, 2`,
    [RUNTIME_GROUP_PATTERN, RUNTIME_ROLE_PATTERN]
  );
  const roles = await client.query<{
    can_create: boolean;
    can_temp: boolean;
    rolname: string;
  }>(
    `${runtime}
     SELECT DISTINCT t.rolname,
            has_database_privilege(t.oid, current_database(), 'TEMPORARY') AS can_temp,
            has_schema_privilege(t.oid, 'public', 'CREATE') AS can_create
       FROM runtime
       JOIN pg_roles t ON pg_has_role(runtime.oid, t.oid, 'SET')
      WHERE NOT runtime.rolsuper AND NOT runtime.is_owner
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
    ownerMembership: membership.rows.map(
      (row) => `${row.login}->${row.target}`
    ),
    privilegedRuntime: privileged.rows.map(
      (row) => `${row.rolname} (${row.reason})`
    ),
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
    findings.privilegedRuntime,
    [],
    "runtime roles that are the database owner or a superuser"
  );
  assert.deepEqual(
    findings.ownerMembership,
    [],
    "runtime roles that are members (SET or INHERIT) of the database owner, neon_superuser or a *_owner role"
  );
  assert.deepEqual(
    findings.publicExecute,
    [],
    "SECURITY DEFINER functions executable by PUBLIC"
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one linear gate script, scenario by scenario
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
  const runner = `polaris_gate_runner_${randomUUID().slice(0, 8).replaceAll("-", "")}`;
  const reach = `gate_definer_reach_${randomUUID().slice(0, 8).replaceAll("-", "")}`;
  let originalOwner: string | undefined;
  let ownerChanged = false;
  const chainGroup = `polaris_gate_chain_${randomUUID().slice(0, 8).replaceAll("-", "")}_runtime`;
  let chainGroupCreated = false;
  let runnerCreated = false;
  let reachCreated = false;
  const superuser = `gate_definer_super_${randomUUID().slice(0, 8).replaceAll("-", "")}`;
  let superuserCreated = false;
  let neonSuperuserCreated = false;

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
    assert.deepEqual((await findViolations(client)).temporary, [PROBE_ROLE]);
    await client.query(
      `REVOKE TEMPORARY ON DATABASE "${expectedDatabase}" FROM ${PROBE_ROLE}`
    );
    temporaryGranted = false;
    await client.query(`GRANT CREATE ON SCHEMA public TO ${PROBE_ROLE}`);
    createGranted = true;
    assert.deepEqual((await findViolations(client)).createInPublic, [
      PROBE_ROLE,
    ]);
    await client.query(`REVOKE CREATE ON SCHEMA public FROM ${PROBE_ROLE}`);
    createGranted = false;
    assertClean(await findViolations(client));
    tests.push(
      "PUBLIC or a runtime role (or a member of one) granted TEMPORARY on the database, or CREATE on schema public, is reported by the gate; so is a function in any schema"
    );

    // the gate can fail: a runtime login that is the database owner, or a member of an owner role
    const ownerRows = await client.query<{ owner: string }>(
      "SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = current_database()"
    );
    originalOwner = ownerRows.rows[0]?.owner;
    assert.ok(originalOwner);
    const otherOwners = await client.query<{ rolname: string }>(
      "SELECT rolname FROM pg_roles WHERE rolname LIKE '%\\_owner' AND rolname !~ '^pg_' AND rolname <> $1 ORDER BY 1 LIMIT 1",
      [originalOwner]
    );
    const otherOwner = otherOwners.rows[0]?.rolname;
    assert.ok(otherOwner);
    await client.query(
      `CREATE ROLE ${runner} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`
    );
    runnerCreated = true;
    assertClean(await findViolations(client));
    for (const [target, inherit, set] of [
      [otherOwner, "TRUE", "FALSE"],
      [otherOwner, "FALSE", "TRUE"],
      [originalOwner, "TRUE", "FALSE"],
      [originalOwner, "FALSE", "TRUE"],
    ] as const) {
      await client.query(
        `GRANT "${target}" TO ${runner} WITH INHERIT ${inherit}, SET ${set}`
      );
      const reached = (await findViolations(client)).ownerMembership;
      // a member of a superuser owner reaches every other owner through it, so only the target itself is asserted there
      if (target === otherOwner) {
        assert.deepEqual(reached, [`${runner}->${target}`]);
      } else {
        assert.ok(reached.includes(`${runner}->${target}`));
      }
      await client.query(`REVOKE "${target}" FROM ${runner}`);
    }
    // a membership with neither INHERIT, SET nor ADMIN grants nothing that the gate cares about
    await client.query(
      `GRANT "${otherOwner}" TO ${runner} WITH ADMIN FALSE, INHERIT FALSE, SET FALSE`
    );
    assertClean(await findViolations(client));
    await client.query(`REVOKE "${otherOwner}" FROM ${runner}`);
    // ADMIN OPTION alone is enough to grant itself SET and INHERIT
    await client.query(
      `GRANT "${otherOwner}" TO ${runner} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`
    );
    assert.deepEqual((await findViolations(client)).ownerMembership, [
      `${runner}->${otherOwner}`,
    ]);
    await client.query(`REVOKE "${otherOwner}" FROM ${runner}`);
    // a login that belongs to a group that is itself a member of an owner role (a chain); the group is a throwaway one
    await client.query(`CREATE ROLE ${chainGroup} NOLOGIN NOSUPERUSER`);
    chainGroupCreated = true;
    await client.query(`GRANT ${chainGroup} TO ${runner}`);
    await client.query(`GRANT "${otherOwner}" TO ${chainGroup}`);
    const chain = (await findViolations(client)).ownerMembership;
    assert.ok(chain.includes(`${chainGroup}->${otherOwner}`));
    assert.ok(chain.includes(`${runner}->${otherOwner}`));
    await client.query(`REVOKE "${otherOwner}" FROM ${chainGroup}`);
    // a mixed chain: the login can SET ROLE to the group (without inheriting it) and the group inherits the owner without SET
    await client.query(`REVOKE ${chainGroup} FROM ${runner}`);
    await client.query(
      `GRANT ${chainGroup} TO ${runner} WITH INHERIT FALSE, SET TRUE`
    );
    await client.query(
      `GRANT "${otherOwner}" TO ${chainGroup} WITH INHERIT TRUE, SET FALSE`
    );
    assert.ok(
      (await findViolations(client)).ownerMembership.includes(
        `${runner}->${otherOwner}`
      )
    );
    await client.query(`DROP ROLE ${chainGroup}`);
    chainGroupCreated = false;
    assertClean(await findViolations(client));
    // neon_superuser exists on Neon only; create it when absent so the check runs here too
    const neonSuperuser = await client.query(
      "SELECT 1 FROM pg_roles WHERE rolname = 'neon_superuser'"
    );
    if (neonSuperuser.rowCount === 0) {
      await client.query("CREATE ROLE neon_superuser NOLOGIN NOSUPERUSER");
      neonSuperuserCreated = true;
    }
    await client.query(`GRANT neon_superuser TO ${runner}`);
    assert.deepEqual((await findViolations(client)).ownerMembership, [
      `${runner}->neon_superuser`,
    ]);
    await client.query(`REVOKE neon_superuser FROM ${runner}`);
    if (neonSuperuserCreated) {
      await client.query("DROP ROLE neon_superuser");
      neonSuperuserCreated = false;
    }
    assertClean(await findViolations(client));
    // the login is the database owner
    // the new owner must be inherited by the current user too, or the owner cannot be handed back without superuser
    await client.query(
      `GRANT ${runner} TO CURRENT_USER WITH INHERIT TRUE, SET TRUE`
    );
    await client.query(
      `ALTER DATABASE "${expectedDatabase}" OWNER TO ${runner}`
    );
    ownerChanged = true;
    assert.deepEqual((await findViolations(client)).privilegedRuntime, [
      `${runner} (database owner)`,
    ]);
    await client.query(
      `ALTER DATABASE "${expectedDatabase}" OWNER TO "${originalOwner}"`
    );
    ownerChanged = false;
    assertClean(await findViolations(client));
    // a superuser that is an explicit member of a runtime group (whatever its name) is a runtime login; only a superuser can create one
    const self = await client.query<{ rolsuper: boolean }>(
      "SELECT rolsuper FROM pg_roles WHERE rolname = current_user"
    );
    if (self.rows[0]?.rolsuper) {
      await client.query(`CREATE ROLE ${superuser} NOLOGIN SUPERUSER`);
      superuserCreated = true;
      await client.query(`GRANT ${PROBE_ROLE} TO ${superuser}`);
      assert.deepEqual((await findViolations(client)).privilegedRuntime, [
        `${superuser} (superuser)`,
      ]);
      await client.query(`DROP ROLE ${superuser}`);
      superuserCreated = false;
      assertClean(await findViolations(client));
    }
    // a runtime login with CREATEROLE (it could create a role and grant it to itself)
    await client.query(`ALTER ROLE ${runner} CREATEROLE`);
    assert.deepEqual((await findViolations(client)).privilegedRuntime, [
      `${runner} (CREATEROLE, REPLICATION or BYPASSRLS)`,
    ]);
    await client.query(`ALTER ROLE ${runner} NOCREATEROLE`);
    assertClean(await findViolations(client));
    tests.push(
      "a runtime login that is the database owner, a superuser or has CREATEROLE, REPLICATION or BYPASSRLS, or that reaches (with SET, INHERIT or ADMIN OPTION, directly, through a group or through a mixed chain) the database owner, neon_superuser, a superuser, a *_owner role or a predefined file or program role, is reported by the gate"
    );

    // the gate can fail: a role the login can reach with SET ROLE, even without inheriting it, holds TEMPORARY or CREATE
    await client.query(`CREATE ROLE ${reach} NOLOGIN NOSUPERUSER`);
    reachCreated = true;
    await client.query(
      `GRANT TEMPORARY ON DATABASE "${expectedDatabase}" TO ${reach}`
    );
    await client.query(`GRANT CREATE ON SCHEMA public TO ${reach}`);
    await client.query(
      `GRANT ${reach} TO ${runner} WITH INHERIT FALSE, SET TRUE`
    );
    const reachable = await findViolations(client);
    assert.deepEqual(reachable.temporary, [reach]);
    assert.deepEqual(reachable.createInPublic, [reach]);
    await client.query(`REVOKE ${reach} FROM ${runner}`);
    assertClean(await findViolations(client));
    // a role that holds them but cannot be reached (no SET) is not reported
    await client.query(
      `GRANT ${reach} TO ${runner} WITH INHERIT FALSE, SET FALSE`
    );
    assertClean(await findViolations(client));
    await client.query(`REVOKE ${reach} FROM ${runner}`);
    tests.push(
      "a role that a runtime login can reach with SET ROLE and that has TEMPORARY on the database or CREATE on schema public is reported by the gate"
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
    if (chainGroupCreated) {
      await cleanup("chain group", `DROP ROLE IF EXISTS ${chainGroup}`);
    }
    if (ownerChanged && originalOwner) {
      await cleanup(
        "restore database owner",
        `ALTER DATABASE "${expectedDatabase}" OWNER TO "${originalOwner}"`
      );
    }
    if (reachCreated) {
      await cleanup("reach role privileges", `DROP OWNED BY ${reach}`);
      await cleanup("reach role", `DROP ROLE IF EXISTS ${reach}`);
    }
    if (runnerCreated) {
      await cleanup("runner login", `DROP ROLE IF EXISTS ${runner}`);
    }
    if (superuserCreated) {
      await cleanup("superuser login", `DROP ROLE IF EXISTS ${superuser}`);
    }
    if (neonSuperuserCreated) {
      await cleanup("neon_superuser", "DROP ROLE IF EXISTS neon_superuser");
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
