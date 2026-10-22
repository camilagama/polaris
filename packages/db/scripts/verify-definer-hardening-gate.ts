// biome-ignore-all lint/performance/noAwaitInLoops: a gate runs its probes strictly one at a time, for a clear failure
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import {
  assertClean,
  findViolations,
  MIN_DEFINER_FUNCTIONS,
  RUNTIME_GROUP_PATTERN,
} from "./definer-hardening-checks";
import {
  assertOwnerRolesClean,
  findOwnerAttributeViolations,
  MIN_OWNER_ROLES,
  MIN_REACHABLE_ROLES,
} from "./owner-role-attributes";
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
 *   3. no runtime role is the database owner (`datdba`) or a superuser, or reaches (with SET, INHERIT or ADMIN OPTION, which grants
 *      both to itself) the database owner, `neon_superuser` (when it exists), any `*_owner` role, any predefined `pg_*` role
 *      (`pg_database_owner` aside) or any role with SUPERUSER, BYPASSRLS or CREATEROLE;
 *   4. no SECURITY DEFINER function is executable by PUBLIC (an absent ACL means PUBLIC may execute);
 *   5. every `polaris_*_owner` role is NOLOGIN, NOSUPERUSER, NOCREATEROLE, NOCREATEDB, NOREPLICATION and NOBYPASSRLS and is a
 *      member (INHERIT, SET or ADMIN OPTION) of no role, and so is every role a runtime role reaches, with ADMIN OPTION counting as
 *      reach (the same read-only check as `staging:verify-database after-migrate`).
 * The gate then proves it can fail: it creates a throwaway function without `pg_temp` and without a REVOKE, grants
 * TEMPORARY and CREATE to a runtime role, makes a throwaway runtime login the database owner or a member of an owner role
 * (also with ADMIN OPTION alone on a runtime group, on an owner role, on a predefined role or on a role with attributes), creates a throwaway `polaris_*_owner` role with LOGIN, CREATEDB and CREATEROLE (and REPLICATION and BYPASSRLS, as a superuser),
 * and each check must report exactly that; everything is undone.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const PROBE_ROLE = "polaris_catalog_runtime";
const OWNER_FLOOR = /fewer polaris_\*_owner roles/;
const READER_NAME = /polaris_closed_export_reader is not reachable/;
const REACHABLE_FLOOR = /fewer roles reachable from a runtime role/;
// the order in which the attributes check reports a role's attributes
const ATTRIBUTE_ORDER = [
  "LOGIN",
  "SUPERUSER",
  "CREATEROLE",
  "CREATEDB",
  "REPLICATION",
  "BYPASSRLS",
] as const;

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
  const adminOnly = `gate_definer_adminonly_${randomUUID().slice(0, 8).replaceAll("-", "")}`;
  let adminOnlyCreated = false;
  let neonSuperuserCreated = false;
  const adminBoth = `gate_definer_adminboth_${randomUUID().slice(0, 8).replaceAll("-", "")}`;
  let adminBothCreated = false;
  const ownerAttributes = `polaris_gate_attr_${randomUUID().slice(0, 8).replaceAll("-", "")}_owner`;
  let ownerAttributesCreated = false;
  const suffix = () => randomUUID().slice(0, 8).replaceAll("-", "");
  const reachAttr = `gate_definer_reachattr_${suffix()}`;
  let reachAttrCreated = false;
  const ownerMember = `polaris_gate_member_${suffix()}_owner`;
  let ownerMemberCreated = false;
  const dbOwnerMember = `polaris_gate_dbowner_${suffix()}_owner`;
  let dbOwnerMemberCreated = false;
  const privRole = `gate_definer_priv_${suffix()}`;
  let privRoleCreated = false;
  const viaRole = `gate_definer_via_${suffix()}`;
  let viaRoleCreated = false;
  const adminTarget = `gate_definer_admintarget_${suffix()}`;
  let adminTargetCreated = false;
  const renamedProbe = `gate_definer_renamed_${suffix()}`;

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
    // an owner role that is a member of the database owner, with no attribute on that role: only the database-owner clause finds it
    await client.query(`CREATE ROLE ${dbOwnerMember} NOLOGIN NOSUPERUSER`);
    dbOwnerMemberCreated = true;
    assert.deepEqual(
      await findOwnerAttributeViolations(client).then(
        (check) => check.findings
      ),
      []
    );
    await client.query(
      `GRANT ${runner} TO ${dbOwnerMember} WITH INHERIT TRUE, SET FALSE`
    );
    assert.deepEqual((await findOwnerAttributeViolations(client)).findings, [
      `${dbOwnerMember}->${runner}`,
    ]);
    await client.query(`DROP ROLE ${dbOwnerMember}`);
    dbOwnerMemberCreated = false;
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
      "a runtime login that is the database owner, a superuser or has CREATEROLE, REPLICATION or BYPASSRLS, or that reaches (with SET, INHERIT or ADMIN OPTION, directly, through a group or through a mixed chain) the database owner, neon_superuser, a *_owner role, any predefined pg_* role or a role with SUPERUSER, BYPASSRLS or CREATEROLE, is reported by the gate"
    );

    // a role that is not the database owner and has only ADMIN OPTION on a runtime group (no INHERIT, no SET) is still a runtime role: it could grant itself the group
    await client.query(
      `CREATE ROLE ${adminOnly} NOLOGIN NOSUPERUSER CREATEROLE`
    );
    adminOnlyCreated = true;
    await client.query(
      `GRANT ${PROBE_ROLE} TO ${adminOnly} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`
    );
    assert.deepEqual((await findViolations(client)).privilegedRuntime, [
      `${adminOnly} (CREATEROLE, REPLICATION or BYPASSRLS)`,
    ]);
    await client.query(`ALTER ROLE ${adminOnly} NOCREATEROLE`);
    assertClean(await findViolations(client));
    await client.query(`DROP ROLE ${adminOnly}`);
    adminOnlyCreated = false;
    tests.push(
      "a login that is not the database owner, with ADMIN OPTION alone on a runtime group, is a runtime login and is checked like one"
    );

    // a login that is not the database owner, with ADMIN OPTION alone on a runtime group and on an owner role: the owner edge is the finding
    await client.query(`CREATE ROLE ${adminBoth} NOLOGIN NOSUPERUSER`);
    adminBothCreated = true;
    // control: the ADMIN edge on an owner role alone, without the runtime group, makes no runtime login
    await client.query(
      `GRANT "${otherOwner}" TO ${adminBoth} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`
    );
    assertClean(await findViolations(client));
    await client.query(`REVOKE "${otherOwner}" FROM ${adminBoth}`);
    await client.query(
      `GRANT ${PROBE_ROLE} TO ${adminBoth} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`
    );
    // control: without an edge to a *_owner role, nothing is reported (the runtime group edge alone is not a finding)
    assertClean(await findViolations(client));
    await client.query(
      `GRANT "${otherOwner}" TO ${adminBoth} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`
    );
    assert.deepEqual((await findViolations(client)).ownerMembership, [
      `${adminBoth}->${otherOwner}`,
    ]);
    await client.query(`REVOKE "${otherOwner}" FROM ${adminBoth}`);
    assertClean(await findViolations(client));
    await client.query(`DROP ROLE ${adminBoth}`);
    adminBothCreated = false;
    tests.push(
      "a login that is not the database owner, with only ADMIN OPTION on a runtime group and only ADMIN OPTION on a *_owner role, is reported in ownerMembership; without the *_owner edge nothing is reported"
    );

    // the attributes of the polaris_*_owner roles: the migrated ones are clean, a throwaway one with forbidden attributes is reported
    const isSuperuser = self.rows[0]?.rolsuper === true;
    const findings = async () =>
      (await findOwnerAttributeViolations(client)).findings;
    // the attributes, in the order the check reports them
    const reported = (role: string, attributes: readonly string[]) =>
      ATTRIBUTE_ORDER.filter((attribute) => attributes.includes(attribute)).map(
        (attribute) => `${role}: ${attribute}`
      );
    const migrated = await assertOwnerRolesClean(client);
    tests.push(
      `${migrated.owners} polaris_*_owner roles and ${migrated.reachable} roles a runtime role reaches are NOLOGIN, NOSUPERUSER, NOCREATEROLE, NOCREATEDB, NOREPLICATION and NOBYPASSRLS, and no owner is a member of any role (at least ${MIN_OWNER_ROLES} and ${MIN_REACHABLE_ROLES} were read)`
    );
    await client.query(
      `CREATE ROLE ${ownerAttributes} LOGIN NOSUPERUSER CREATEDB CREATEROLE`
    );
    ownerAttributesCreated = true;
    assert.deepEqual(
      await findings(),
      reported(ownerAttributes, ["LOGIN", "CREATEROLE", "CREATEDB"])
    );
    if (isSuperuser) {
      await client.query(
        `ALTER ROLE ${ownerAttributes} SUPERUSER REPLICATION BYPASSRLS`
      );
      assert.deepEqual(
        await findings(),
        reported(ownerAttributes, ATTRIBUTE_ORDER)
      );
    }
    await client.query(`DROP ROLE ${ownerAttributes}`);
    ownerAttributesCreated = false;
    assert.deepEqual(await findings(), []);
    tests.push(
      "a polaris_*_owner role with LOGIN, CREATEROLE or CREATEDB (and SUPERUSER, REPLICATION or BYPASSRLS, as a superuser) is reported, naming the role and the attribute; the migrated owner roles are clean"
    );

    // a role a runtime role reaches (by SET, by INHERIT or by ADMIN OPTION, from a group or from a login) is held to the same six attributes
    await client.query(`CREATE ROLE ${reachAttr} NOLOGIN NOSUPERUSER`);
    reachAttrCreated = true;
    const grantReach = (to: string, options: string) =>
      client.query(`GRANT ${reachAttr} TO ${to} WITH ${options}`);
    // control: the role is clean, and with the attributes but unreachable (no edge, or an edge with ADMIN, INHERIT and SET all false) it is not looked at
    await grantReach(PROBE_ROLE, "INHERIT FALSE, SET TRUE");
    assert.deepEqual(await findings(), []);
    await client.query(`REVOKE ${reachAttr} FROM ${PROBE_ROLE}`);
    await client.query(`ALTER ROLE ${reachAttr} LOGIN CREATEDB CREATEROLE`);
    assert.deepEqual(await findings(), []);
    await grantReach(PROBE_ROLE, "ADMIN FALSE, INHERIT FALSE, SET FALSE");
    assert.deepEqual(await findings(), []);
    await client.query(`REVOKE ${reachAttr} FROM ${PROBE_ROLE}`);
    // the probes: reached from a group by SET alone, by INHERIT alone or by ADMIN OPTION alone (which grants both to itself), from a login of the app, or
    // from a login that inherits a group with ADMIN OPTION on it
    await client.query(
      `GRANT ${PROBE_ROLE} TO ${runner} WITH INHERIT TRUE, SET FALSE`
    );
    await grantReach(PROBE_ROLE, "ADMIN TRUE, INHERIT FALSE, SET FALSE");
    assert.deepEqual(
      await findings(),
      reported(reachAttr, ["LOGIN", "CREATEROLE", "CREATEDB"]),
      `${reachAttr} reached by a login that inherits ${PROBE_ROLE}, which has ADMIN OPTION on it`
    );
    await client.query(`REVOKE ${reachAttr} FROM ${PROBE_ROLE}`);
    await client.query(`REVOKE ${PROBE_ROLE} FROM ${runner}`);
    for (const [to, options] of [
      [PROBE_ROLE, "INHERIT FALSE, SET TRUE"],
      [PROBE_ROLE, "INHERIT TRUE, SET FALSE"],
      [PROBE_ROLE, "ADMIN TRUE, INHERIT FALSE, SET FALSE"],
      [runner, "INHERIT FALSE, SET TRUE"],
      [runner, "ADMIN TRUE, INHERIT FALSE, SET FALSE"],
    ] as const) {
      await grantReach(to, options);
      assert.deepEqual(
        await findings(),
        reported(reachAttr, ["LOGIN", "CREATEROLE", "CREATEDB"]),
        `${reachAttr} reached by ${to} with ${options}`
      );
      await client.query(`REVOKE ${reachAttr} FROM ${to}`);
    }
    // each attribute alone; REPLICATION, BYPASSRLS and SUPERUSER only a superuser can give (the CI container's user is one)
    await grantReach(PROBE_ROLE, "INHERIT FALSE, SET TRUE");
    const alone = [
      ["LOGIN", "NOLOGIN"],
      ["CREATEDB", "NOCREATEDB"],
      ["CREATEROLE", "NOCREATEROLE"],
      ...(isSuperuser
        ? ([
            ["REPLICATION", "NOREPLICATION"],
            ["BYPASSRLS", "NOBYPASSRLS"],
            ["SUPERUSER", "NOSUPERUSER"],
          ] as const)
        : []),
    ] as const;
    await client.query(
      `ALTER ROLE ${reachAttr} NOLOGIN NOCREATEDB NOCREATEROLE`
    );
    for (const [attribute, off] of alone) {
      await client.query(`ALTER ROLE ${reachAttr} ${attribute}`);
      assert.deepEqual(
        await findings(),
        [`${reachAttr}: ${attribute}`],
        `${reachAttr} with only ${attribute}`
      );
      await client.query(`ALTER ROLE ${reachAttr} ${off}`);
    }
    assert.deepEqual(await findings(), []);
    // a login of the app must log in, so its LOGIN is not asked of it; its other attributes are
    await client.query(`ALTER ROLE ${runner} LOGIN`);
    assert.deepEqual(await findings(), []);
    await client.query(`ALTER ROLE ${runner} CREATEDB`);
    assert.deepEqual(await findings(), [`${runner}: CREATEDB`]);
    await client.query(`ALTER ROLE ${runner} NOLOGIN NOCREATEDB`);
    await client.query(`DROP ROLE ${reachAttr}`);
    reachAttrCreated = false;
    assert.deepEqual(await findings(), []);
    tests.push(
      `a role a runtime group or login reaches by SET, by INHERIT or by ADMIN OPTION alone (directly or through a group the login inherits) is reported for LOGIN, CREATEROLE, CREATEDB${isSuperuser ? ", REPLICATION, BYPASSRLS and SUPERUSER" : ""}, a login of the app is not reported for its own LOGIN but is for its other attributes, and a role with them that is not reachable is not looked at${isSuperuser ? "" : " (REPLICATION, BYPASSRLS and SUPERUSER are proved only where the gate user is a superuser: the CI container; a role that is not a superuser cannot give them)"}`
    );

    // a polaris_*_owner role is a member of no role: an edge out of an owner role with INHERIT, SET or ADMIN OPTION is a finding, whatever the
    // target (a plain role, another owner role, the database owner, neon_superuser, a predefined role, a role with attributes)
    await client.query(`CREATE ROLE ${ownerMember} NOLOGIN NOSUPERUSER`);
    ownerMemberCreated = true;
    await client.query(
      `CREATE ROLE ${privRole} NOLOGIN NOSUPERUSER CREATEROLE`
    );
    privRoleCreated = true;
    await client.query(`CREATE ROLE ${viaRole} NOLOGIN NOSUPERUSER`);
    viaRoleCreated = true;
    const memberOf = async (target: string, options: string) => {
      await client.query(`GRANT "${target}" TO ${ownerMember} WITH ${options}`);
      const reached = await findings();
      await client.query(`REVOKE "${target}" FROM ${ownerMember}`);
      return reached;
    };
    // controls: an owner role with no edge, or with an edge that has none of ADMIN, INHERIT and SET
    assert.deepEqual(await findings(), []);
    for (const target of [viaRole, otherOwner, privRole]) {
      assert.deepEqual(
        await memberOf(target, "ADMIN FALSE, INHERIT FALSE, SET FALSE"),
        [],
        `${ownerMember} -> ${target} with no option`
      );
    }
    // the probes: the same edge to a plain role and to another owner role (owner -> owner widens what the definer functions can do with no runtime
    // role in the way), and to a role with CREATEROLE
    for (const target of [viaRole, otherOwner, privRole]) {
      for (const options of [
        "INHERIT TRUE, SET FALSE",
        "INHERIT FALSE, SET TRUE",
        "ADMIN TRUE, INHERIT FALSE, SET FALSE",
      ]) {
        assert.deepEqual(
          await memberOf(target, options),
          [`${ownerMember}->${target}`],
          `${ownerMember} -> ${target} with ${options}`
        );
      }
    }
    // the edge that leaves the owner role is the one reported, not what the plain role it reaches is a member of
    await client.query(
      `GRANT ${privRole} TO ${viaRole} WITH INHERIT TRUE, SET FALSE`
    );
    assert.deepEqual(await memberOf(viaRole, "INHERIT TRUE, SET FALSE"), [
      `${ownerMember}->${viaRole}`,
    ]);
    await client.query(`REVOKE ${privRole} FROM ${viaRole}`);
    // the database owner, and neon_superuser (created here when absent, as on Neon it exists)
    const ownerTargets = [originalOwner];
    const hadNeonSuperuser =
      (
        await client.query(
          "SELECT 1 FROM pg_roles WHERE rolname = 'neon_superuser'"
        )
      ).rowCount === 1;
    if (!hadNeonSuperuser) {
      await client.query("CREATE ROLE neon_superuser NOLOGIN NOSUPERUSER");
      neonSuperuserCreated = true;
    }
    ownerTargets.push("neon_superuser");
    // the predefined roles, and a role with SUPERUSER or BYPASSRLS, need a superuser to be granted or created
    if (isSuperuser) {
      ownerTargets.push(
        "pg_read_all_data",
        "pg_write_all_data",
        "pg_execute_server_program"
      );
      await client.query(`ALTER ROLE ${privRole} NOCREATEROLE BYPASSRLS`);
      ownerTargets.push(privRole);
    }
    for (const target of ownerTargets) {
      assert.deepEqual(
        await memberOf(target, "INHERIT TRUE, SET FALSE"),
        [`${ownerMember}->${target}`],
        `${ownerMember} is a member of ${target} and is not reported`
      );
    }
    if (isSuperuser) {
      await client.query(`ALTER ROLE ${privRole} NOBYPASSRLS SUPERUSER`);
      assert.deepEqual(await memberOf(privRole, "INHERIT TRUE, SET FALSE"), [
        `${ownerMember}->${privRole}`,
      ]);
    }
    if (neonSuperuserCreated) {
      await client.query("DROP ROLE neon_superuser");
      neonSuperuserCreated = false;
    }
    await client.query(`DROP ROLE ${viaRole}`);
    viaRoleCreated = false;
    await client.query(`DROP ROLE ${privRole}`);
    privRoleCreated = false;
    await client.query(`DROP ROLE ${ownerMember}`);
    ownerMemberCreated = false;
    assert.deepEqual(await findings(), []);
    tests.push(
      `a polaris_*_owner role that is a member (INHERIT, SET or ADMIN OPTION) of any role is reported, naming the edge: a plain role, another owner role (owner -> owner), a role with CREATEROLE, the database owner, neon_superuser${isSuperuser ? ", pg_read_all_data, pg_write_all_data, pg_execute_server_program or a role with BYPASSRLS or SUPERUSER" : ""}; an owner role with no edge, or an edge with none of the three, is not${isSuperuser ? "" : " (the predefined roles and the SUPERUSER and BYPASSRLS roles are proved only where the gate user is a superuser: the CI container; migrations-without-superuser proves the CREATEROLE case as the owner)"}`
    );

    // ADMIN OPTION counts as reach: a runtime login with ADMIN OPTION alone (no INHERIT, no SET) on a role that is privileged is reported,
    // because it could grant itself both, and so is one that has it on a role that reaches a privileged one (to any depth)
    await client.query(`CREATE ROLE ${adminTarget} NOLOGIN NOSUPERUSER`);
    adminTargetCreated = true;
    const adminOnlyOn = async (target: string) => {
      await client.query(
        `GRANT "${target}" TO ${runner} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`
      );
      const reached = (await findViolations(client)).ownerMembership;
      await client.query(`REVOKE "${target}" FROM ${runner}`);
      return reached;
    };
    // controls: no edge, an edge with none of ADMIN, INHERIT and SET, and a plain role that is administered
    assertClean(await findViolations(client));
    await client.query(
      `GRANT "${otherOwner}" TO ${runner} WITH ADMIN FALSE, INHERIT FALSE, SET FALSE`
    );
    assertClean(await findViolations(client));
    await client.query(`REVOKE "${otherOwner}" FROM ${runner}`);
    assert.deepEqual(await adminOnlyOn(adminTarget), []);
    // a *_owner role
    assert.deepEqual(await adminOnlyOn(otherOwner), [
      `${runner}->${otherOwner}`,
    ]);
    // a plain role that is itself a member of an owner role, with INHERIT or with ADMIN OPTION alone: what it reaches is reached (a second hop).
    // Controls: the plain role with the edge but nobody administering it, and an edge to it with none of the three
    await client.query(
      `GRANT "${otherOwner}" TO ${adminTarget} WITH INHERIT TRUE, SET FALSE`
    );
    assertClean(await findViolations(client));
    await client.query(
      `GRANT ${adminTarget} TO ${runner} WITH ADMIN FALSE, INHERIT FALSE, SET FALSE`
    );
    assertClean(await findViolations(client));
    await client.query(`REVOKE ${adminTarget} FROM ${runner}`);
    assert.deepEqual(await adminOnlyOn(adminTarget), [
      `${runner}->${otherOwner}`,
    ]);
    await client.query(`REVOKE "${otherOwner}" FROM ${adminTarget}`);
    await client.query(
      `GRANT "${otherOwner}" TO ${adminTarget} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`
    );
    assert.deepEqual(await adminOnlyOn(adminTarget), [
      `${runner}->${otherOwner}`,
    ]);
    await client.query(`REVOKE "${otherOwner}" FROM ${adminTarget}`);
    // a role with CREATEROLE (BYPASSRLS too, as a superuser, which can give it)
    await client.query(`ALTER ROLE ${adminTarget} CREATEROLE`);
    assert.deepEqual(await adminOnlyOn(adminTarget), [
      `${runner}->${adminTarget}`,
    ]);
    // a predefined role (granting it needs a superuser)
    if (isSuperuser) {
      await client.query(`ALTER ROLE ${adminTarget} NOCREATEROLE BYPASSRLS`);
      assert.deepEqual(await adminOnlyOn(adminTarget), [
        `${runner}->${adminTarget}`,
      ]);
      assert.deepEqual(await adminOnlyOn("pg_signal_backend"), [
        `${runner}->pg_signal_backend`,
      ]);
    }
    // through a group the login inherits, whose ADMIN OPTION it uses (the group is a throwaway one)
    await client.query(`CREATE ROLE ${chainGroup} NOLOGIN NOSUPERUSER`);
    chainGroupCreated = true;
    await client.query(
      `GRANT "${otherOwner}" TO ${chainGroup} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`
    );
    await client.query(
      `GRANT ${chainGroup} TO ${runner} WITH INHERIT TRUE, SET FALSE`
    );
    const throughGroup = (await findViolations(client)).ownerMembership;
    assert.deepEqual(throughGroup, [
      `${chainGroup}->${otherOwner}`,
      `${runner}->${otherOwner}`,
    ]);
    await client.query(`DROP ROLE ${chainGroup}`);
    chainGroupCreated = false;
    await client.query(`DROP ROLE ${adminTarget}`);
    adminTargetCreated = false;
    assertClean(await findViolations(client));
    tests.push(
      `a runtime login with ADMIN OPTION alone on a *_owner role, on a role with CREATEROLE${isSuperuser ? " or BYPASSRLS, or on pg_signal_backend" : ""}, on a role that is itself a member of an owner role (INHERIT or ADMIN OPTION, a second hop), or that inherits a group that has it, is reported in ownerMembership; with no edge, an edge with none of ADMIN, INHERIT and SET, or an administered plain role, nothing is${isSuperuser ? "" : " (the predefined roles and BYPASSRLS are proved only where the gate user is a superuser: the CI container)"}`
    );

    // the floors: an owner role renamed away, or a role no longer reachable from a runtime role, makes the check fail instead of pass on fewer roles
    const polarisOwner = (
      await client.query<{ rolname: string }>(
        "SELECT rolname FROM pg_roles WHERE rolname LIKE 'polaris\\_%\\_owner' ORDER BY 1 LIMIT 1"
      )
    ).rows[0]?.rolname;
    assert.ok(polarisOwner);
    for (const [statement, floor] of [
      [`ALTER ROLE ${polarisOwner} RENAME TO ${renamedProbe}`, OWNER_FLOOR],
      [
        "REVOKE polaris_closed_export_reader FROM polaris_privacy_runtime",
        REACHABLE_FLOOR,
      ],
      [
        `ALTER ROLE polaris_closed_export_reader RENAME TO ${renamedProbe}`,
        READER_NAME,
      ],
    ] as const) {
      await client.query("BEGIN");
      try {
        await client.query(statement);
        await assert.rejects(assertOwnerRolesClean(client), floor);
      } finally {
        await client.query("ROLLBACK");
      }
    }
    await assertOwnerRolesClean(client);
    tests.push(
      "a polaris_*_owner role renamed away, or polaris_closed_export_reader renamed or no longer reachable from polaris_privacy_runtime, makes the count fall under its floor and the check fail"
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
    if (adminBothCreated) {
      await cleanup("admin-both login", `DROP ROLE IF EXISTS ${adminBoth}`);
    }
    if (ownerAttributesCreated) {
      await cleanup(
        "owner attributes role",
        `DROP ROLE IF EXISTS ${ownerAttributes}`
      );
    }
    if (dbOwnerMemberCreated) {
      await cleanup(
        "database owner member",
        `DROP ROLE IF EXISTS ${dbOwnerMember}`
      );
    }
    if (ownerMemberCreated) {
      await cleanup("owner member", `DROP ROLE IF EXISTS ${ownerMember}`);
    }
    if (viaRoleCreated) {
      await cleanup("via role", `DROP ROLE IF EXISTS ${viaRole}`);
    }
    if (privRoleCreated) {
      await cleanup("privileged role", `DROP ROLE IF EXISTS ${privRole}`);
    }
    if (reachAttrCreated) {
      await cleanup("reachable role", `DROP ROLE IF EXISTS ${reachAttr}`);
    }
    if (adminTargetCreated) {
      await cleanup("admin target", `DROP ROLE IF EXISTS ${adminTarget}`);
    }
    if (adminOnlyCreated) {
      await cleanup("admin-only login", `DROP ROLE IF EXISTS ${adminOnly}`);
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
