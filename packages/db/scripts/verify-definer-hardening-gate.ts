// biome-ignore-all lint/performance/noAwaitInLoops: a gate runs its probes strictly one at a time, for a clear failure
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import {
  drawGraph,
  modelBecomes,
  type RoleEdge,
  seededRandom,
} from "./becomes-model";
import {
  assertClean,
  findBecomes,
  findViolations,
  MIN_DEFINER_FUNCTIONS,
  RUNTIME_GROUP_PATTERN,
} from "./definer-hardening-checks";
import { withGateRole } from "./gate-roles";
import { assertSuperuserCasesProved } from "./gate-runs";
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
 *      reach (the same read-only check as `staging:verify-database after-migrate`);
 *   6. every SECURITY DEFINER function belongs to a `polaris_*_owner` role (`foreignOwner`): one left with the database owner
 *      runs with BYPASSRLS on Neon;
 *   7. a policy that reads `app.owner_scope.*` is TO one `polaris_*_owner` role and reads no runtime setting, and a policy of
 *      an owner role reads no runtime setting (`ownerScope`, with no exception since 0097);
 *   8. every table of public a `polaris_*` role holds a privilege on has row security enabled and forced, with no exception
 *      since 0098 (`tableWithoutRowSecurity`), and the owner of every table with forced row security is a superuser or has
 *      BYPASSRLS (`forcedTableOwnerWithoutBypass`);
 *   9. on a table with forced row security, every role with a privilege (of the ACL, inherited too) has a permissive policy
 *      for the command (`rowSecurityWithoutPolicy`);
 *  10. every policy on `app.owner_scope.<name>` has a function of its role that writes that setting (`scopeWithoutWriter`).
 * The gate then proves it can fail: it creates a throwaway function without `pg_temp` and without a REVOKE, grants
 * TEMPORARY and CREATE to a runtime role, makes a throwaway runtime login the database owner or a member of an owner role
 * (also with ADMIN OPTION alone on a runtime group, on an owner role, on a predefined role or on a role with attributes), creates a throwaway `polaris_*_owner` role with LOGIN, CREATEDB and CREATEROLE (and REPLICATION and BYPASSRLS, as a superuser),
 * and each check must report exactly that; everything is undone. A definer function kept by the gate user or by a throwaway
 * role is reported by `foreignOwner`, and the same function moved to an owner role is clean (the control); policies on a
 * throwaway table that break the scope of the owners are reported by `ownerScope`. Last, a fuzz with a fixed seed: random
 * graphs of 4 to 7 throwaway roles (ADMIN, INHERIT and SET drawn per edge, sometimes a superuser and the database owner's
 * ADMIN-only edge), each in a transaction that is rolled back, where `becomes` must equal the closure of `becomes-model.ts`.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const PROBE_ROLE = "polaris_catalog_runtime";
// the owner role a probe function is moved to, as the control of foreignOwner and of the owner scope
const CONTROL_OWNER = "polaris_sync_owner";
// the line of end_device_sessions that writes its scope (0097), taken out by the probe of scopeWithoutWriter
const DEVICE_SESSION_SCOPE_LINE =
  "PERFORM pg_catalog.set_config('app.owner_scope.device_session_user_id', v_user, true);";
const RUNTIME_LOGIN_PATTERN = /^polaris_gate_runner_[0-9a-f]+$/;
// the fuzz of `becomes`: the same graphs on every run, at least 200 of them
const FUZZ_SEED = 20_261_022;
const FUZZ_CASES = 240;
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
  const standInOwner = `gate_definer_dbowner_${randomUUID().slice(0, 8).replaceAll("-", "")}`;
  let standInOwnerCreated = false;
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
  const creator = `gate_definer_creator_${suffix()}`;
  const fuzzTag = suffix();
  // runs the body in a transaction that is always rolled back: what it creates (roles, grants, functions, policies) is undone
  const inRolledBackTransaction = async (body: () => Promise<void>) => {
    await client.query("BEGIN");
    try {
      await body();
    } finally {
      await client.query("ROLLBACK");
    }
  };

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
    // pinned and without EXECUTE for PUBLIC, it still belongs to the gate user (the database owner here): that alone is a finding
    const gateUser = (
      await client.query<{ name: string }>("SELECT current_user AS name")
    ).rows[0]?.name;
    assert.ok(gateUser);
    const kept = await findViolations(client);
    assert.deepEqual(kept.foreignOwner, [`public.${probe}() (${gateUser})`]);
    assertClean({ ...kept, foreignOwner: [] });
    // the control: the same function moved to an owner role, the way the migrations move one, is clean
    await inRolledBackTransaction(async () => {
      await client.query(`GRANT CREATE ON SCHEMA public TO ${CONTROL_OWNER}`);
      await client.query(
        `GRANT ${CONTROL_OWNER} TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE`
      );
      await client.query(
        `ALTER FUNCTION public.${probe}() OWNER TO ${CONTROL_OWNER}`
      );
      assertClean(await findViolations(client));
    });
    await client.query(`DROP FUNCTION public.${probe}()`);
    probeCreated = false;
    assertClean(await findViolations(client));
    tests.push(
      "a SECURITY DEFINER function with no search_path (or one that does not end in pg_temp) and with EXECUTE for PUBLIC is reported by the gate, and passes once fixed"
    );
    // a throwaway role that creates a definer function and keeps it is named in foreignOwner; moved to an owner role, it is clean
    await inRolledBackTransaction(async () => {
      await client.query(
        `CREATE ROLE ${creator} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`
      );
      await client.query(`GRANT CREATE ON SCHEMA public TO ${creator}`);
      await withGateRole(client, creator, async () => {
        await client.query(
          `CREATE FUNCTION public.${probe}_kept() RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS 'SELECT 1'`
        );
        await client.query(
          `REVOKE EXECUTE ON FUNCTION public.${probe}_kept() FROM PUBLIC`
        );
      });
      const created = await findViolations(client);
      assert.deepEqual(created.foreignOwner, [
        `public.${probe}_kept() (${creator})`,
      ]);
      assertClean({ ...created, foreignOwner: [] });
      await client.query(`GRANT CREATE ON SCHEMA public TO ${CONTROL_OWNER}`);
      // ALTER … OWNER is the owner's (the creator's), who must be able to SET ROLE to the new owner
      await client.query(
        `GRANT ${CONTROL_OWNER} TO ${creator} WITH SET TRUE, INHERIT FALSE, ADMIN FALSE`
      );
      await withGateRole(client, creator, () =>
        client.query(
          `ALTER FUNCTION public.${probe}_kept() OWNER TO ${CONTROL_OWNER}`
        )
      );
      assertClean(await findViolations(client));
    });
    assertClean(await findViolations(client));
    tests.push(
      `a SECURITY DEFINER function that stays with the gate user (the database owner) or with a throwaway role that created it is reported in foreignOwner as signature (owner), and nothing else is; moved to ${CONTROL_OWNER} it is clean`
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
    assert.deepEqual(otherSchema.foreignOwner, [`${probe}.f() (${gateUser})`]);
    await client.query(`DROP SCHEMA ${probe} CASCADE`);
    schemaCreated = false;
    assertClean(await findViolations(client));

    // the scope of the owners: a policy that reads app.owner_scope.* is TO one owner role and reads no runtime setting, and an owner's
    // policy reads no runtime setting, with no exception (0097 moved the last two, of polaris_device_session_owner, to its scope); policies on a
    // throwaway table, rolled back
    await inRolledBackTransaction(async () => {
      const table = `${probe}_scope`;
      await client.query(`CREATE TABLE public.${table} (id integer)`);
      const scopeFindings = async (
        roles: string,
        expression: string,
        before: string[] = [],
        onTable = table
      ) => {
        await client.query("SAVEPOINT scope_probe");
        for (const statement of before) {
          await client.query(statement);
        }
        await client.query(
          `CREATE POLICY probe ON public.${onTable} AS PERMISSIVE FOR SELECT ${roles} USING (${expression})`
        );
        const found = (await findViolations(client)).ownerScope;
        await client.query("ROLLBACK TO SAVEPOINT scope_probe");
        return found;
      };
      const label = (roles: string) => `public.${table}.probe ({${roles}})`;
      const scoped = "current_setting('app.owner_scope.probe_id', true) = 'x'";
      const userSetting = "current_setting('app.user_id', true) = 'x'";
      // controls: an owner's policy on its own scope and a runtime's on the runtime setting
      assert.deepEqual(await scopeFindings(`TO ${CONTROL_OWNER}`, scoped), []);
      assert.deepEqual(
        await scopeFindings("TO polaris_pr11_runtime", userSetting),
        []
      );
      // (the four real policies of polaris_device_session_owner, on its scope since 0097, are a control too: the database is clean
      // before and after every probe, with them in place)
      // the probes
      const notOneOwner =
        "reads app.owner_scope.probe_id and is not TO one polaris_*_owner role";
      assert.deepEqual(await scopeFindings("TO polaris_pr11_runtime", scoped), [
        `${label("polaris_pr11_runtime")}: ${notOneOwner}`,
      ]);
      assert.deepEqual(await scopeFindings("", scoped), [
        `${label("public")}: ${notOneOwner}`,
      ]);
      assert.deepEqual(
        await scopeFindings(
          `TO ${CONTROL_OWNER}, polaris_onboarding_owner`,
          scoped
        ),
        [
          `${label(`polaris_onboarding_owner,${CONTROL_OWNER}`)}: ${notOneOwner}`,
          `${label(`polaris_onboarding_owner,${CONTROL_OWNER}`)}: reads app.owner_scope.probe_id, which a policy of another role reads too`,
        ]
      );
      // a scope belongs to one owner: two policies, each TO one owner, that read the same setting are both reported
      assert.deepEqual(
        await scopeFindings(`TO ${CONTROL_OWNER}`, scoped, [
          `CREATE POLICY probe_other ON public.${table} AS PERMISSIVE FOR SELECT TO polaris_onboarding_owner USING (${scoped})`,
        ]),
        [
          `${label(CONTROL_OWNER)}: reads app.owner_scope.probe_id, which a policy of another role reads too`,
          `public.${table}.probe_other ({polaris_onboarding_owner}): reads app.owner_scope.probe_id, which a policy of another role reads too`,
        ]
      );
      // polaris_device_session_owner has no exception any more: a policy of it that reads app.user_id, on a table of its own, on
      // devices, on device_sessions or on session, is reported, and so is one of its real policies put back on app.user_id
      assert.deepEqual(
        await scopeFindings("TO polaris_device_session_owner", userSetting),
        [
          `${label("polaris_device_session_owner")}: a policy of an owner role reads the runtime setting app.user_id`,
        ]
      );
      assert.deepEqual(
        await scopeFindings(
          "TO polaris_device_session_owner",
          "user_id = current_setting('app.user_id', true)",
          [],
          "devices"
        ),
        [
          "public.devices.probe ({polaris_device_session_owner}): a policy of an owner role reads the runtime setting app.user_id",
        ]
      );
      assert.deepEqual(
        await scopeFindings(
          "TO polaris_device_session_owner",
          "user_id = current_setting('app.user_id', true)",
          [],
          "device_sessions"
        ),
        [
          "public.device_sessions.probe ({polaris_device_session_owner}): a policy of an owner role reads the runtime setting app.user_id",
        ]
      );
      assert.deepEqual(
        await scopeFindings(
          "TO polaris_device_session_owner",
          "user_id = current_setting('app.user_id', true)",
          [],
          "session"
        ),
        [
          "public.session.probe ({polaris_device_session_owner}): a policy of an owner role reads the runtime setting app.user_id",
        ]
      );
      for (const [onTable, policy] of [
        ["devices", "devices_session_owner_select"],
        ["device_sessions", "device_sessions_session_owner_select"],
        ["session", "session_device_session_owner_delete"],
      ] as const) {
        await client.query("SAVEPOINT scope_probe");
        await client.query(
          `ALTER POLICY ${policy} ON public.${onTable} USING (user_id = NULLIF(current_setting('app.user_id', true), ''))`
        );
        assert.deepEqual((await findViolations(client)).ownerScope, [
          `public.${onTable}.${policy} ({polaris_device_session_owner}): a policy of an owner role reads the runtime setting app.user_id`,
        ]);
        await client.query("ROLLBACK TO SAVEPOINT scope_probe");
      }
      // the owner and a runtime in the same policy: it holds for the owner too
      assert.deepEqual(
        await scopeFindings(
          "TO polaris_device_session_owner, polaris_pr11_runtime",
          userSetting
        ),
        [
          `${label("polaris_device_session_owner,polaris_pr11_runtime")}: a policy of an owner role reads the runtime setting app.user_id`,
        ]
      );
      // every runtime setting lives under app.: a policy of any role that reads another custom prefix is reported, a setting of
      // PostgreSQL (no dot) is not, and the name is not case sensitive
      const outsideApp = (roles: string) =>
        `${label(roles)}: reads the custom setting foo.bar, outside app.`;
      assert.deepEqual(
        await scopeFindings(
          "TO polaris_pr11_runtime",
          "current_setting('foo.bar', true) = 'x'"
        ),
        [outsideApp("polaris_pr11_runtime")]
      );
      assert.deepEqual(
        await scopeFindings("", "current_setting('Foo.Bar', true) = 'x'"),
        [outsideApp("public")]
      );
      assert.deepEqual(
        await scopeFindings(
          `TO ${CONTROL_OWNER}`,
          "current_setting('foo.bar', true) = 'x'"
        ),
        [outsideApp(CONTROL_OWNER)]
      );
      assert.deepEqual(
        await scopeFindings(
          "TO polaris_pr11_runtime",
          "current_setting('transaction_read_only') = 'off'"
        ),
        []
      );
      assert.deepEqual(
        await scopeFindings(
          `TO ${CONTROL_OWNER}`,
          "current_setting('APP.User_Id', true) = 'x'"
        ),
        [
          `${label(CONTROL_OWNER)}: a policy of an owner role reads the runtime setting app.user_id`,
        ]
      );
      // nor app.organization_id
      assert.deepEqual(
        await scopeFindings(
          "TO polaris_device_session_owner",
          "current_setting('app.organization_id', true) = 'x'"
        ),
        [
          `${label("polaris_device_session_owner")}: a policy of an owner role reads the runtime setting app.organization_id`,
        ]
      );
      // a policy TO PUBLIC holds for the owners too: on a table an owner role uses, it may not read a runtime setting (on one no
      // owner uses, such as the table of the RLS proof of concept, it may)
      assert.deepEqual(await scopeFindings("", userSetting), []);
      assert.deepEqual(
        await scopeFindings("", userSetting, [
          `GRANT SELECT ON public.${table} TO ${CONTROL_OWNER}`,
        ]),
        [
          `${label("public")}: a policy TO PUBLIC, on a table an owner role uses, reads the runtime setting app.user_id`,
        ]
      );
      assert.deepEqual(
        await scopeFindings(
          `TO ${CONTROL_OWNER}`,
          `${scoped} AND ${userSetting}`
        ),
        [
          `${label(CONTROL_OWNER)}: reads app.owner_scope.probe_id and the runtime setting app.user_id`,
        ]
      );
      assert.deepEqual(
        await scopeFindings(
          `TO ${CONTROL_OWNER}`,
          "current_setting('app.organization_id', true) = 'x'"
        ),
        [
          `${label(CONTROL_OWNER)}: a policy of an owner role reads the runtime setting app.organization_id`,
        ]
      );
    });
    assertClean(await findViolations(client));
    tests.push(
      "a policy that reads app.owner_scope.* TO a runtime, TO no role (PUBLIC) or TO two owner roles, or together with app.user_id, two policies of two owners on the same scope, an owner's policy that reads app.organization_id (polaris_device_session_owner's too), any policy of polaris_device_session_owner that reads app.user_id (new table, devices, device_sessions or session, one of its four real policies put back on app.user_id, or together with a runtime in the same TO: no exception since 0097), a policy of any role that reads a custom setting outside app. and a policy TO PUBLIC that reads app.user_id on a table an owner uses are reported in ownerScope; an owner's policy on its own scope, a runtime's on app.user_id, the four real policies of polaris_device_session_owner (on its scope), a PostgreSQL setting without a dot and a policy TO PUBLIC on a table no owner uses are not"
    );

    // row security on every table a polaris_* role uses (tableWithoutRowSecurity), a policy for every grant under FORCE
    // (rowSecurityWithoutPolicy), with role inheritance, and a writer for every owner scope (scopeWithoutWriter); rolled back
    await inRolledBackTransaction(async () => {
      const table = `${probe}_rls`;
      const group = `polaris_gate_rlsgroup_${suffix()}`;
      const member = `polaris_gate_rlsmember_${suffix()}`;
      const detached = `polaris_gate_rlsnoinherit_${suffix()}`;
      await client.query(`CREATE TABLE public.${table} (id integer)`);
      await client.query(
        `CREATE ROLE ${group} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`
      );
      await client.query(
        `CREATE ROLE ${member} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`
      );
      await client.query(
        `CREATE ROLE ${detached} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`
      );
      await client.query(
        `GRANT ${group} TO ${member} WITH INHERIT TRUE, SET FALSE`
      );
      // SET without INHERIT: the role acts as the group only after SET ROLE, and then the group's policies apply
      await client.query(
        `GRANT ${group} TO ${detached} WITH INHERIT FALSE, SET TRUE`
      );
      const rls = async () => {
        const found = await findViolations(client);
        return {
          noPolicy: found.rowSecurityWithoutPolicy,
          noRls: found.tableWithoutRowSecurity,
        };
      };
      // control: a table no polaris_* role uses needs no row security
      assertClean(await findViolations(client));
      await client.query(
        `GRANT SELECT (id), DELETE ON public.${table} TO ${group}`
      );
      assert.deepEqual(await rls(), {
        noPolicy: [],
        noRls: [`public.${table}`],
      });
      await client.query(
        `ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`
      );
      assert.deepEqual((await rls()).noRls, [`public.${table}`]);
      await client.query(
        `ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`
      );
      // forced, with no policy: the group and the role that inherits it, for each command; not the role that only SETs to it
      assert.deepEqual(await rls(), {
        noPolicy: [
          `public.${table} ${group} DELETE`,
          `public.${table} ${group} SELECT`,
          `public.${table} ${member} DELETE`,
          `public.${table} ${member} SELECT`,
        ],
        noRls: [],
      });
      // a policy TO the member covers the member only; a restrictive one covers nobody
      await client.query(
        `CREATE POLICY probe_member ON public.${table} AS PERMISSIVE FOR SELECT TO ${member} USING (true)`
      );
      await client.query(
        `CREATE POLICY probe_restrictive ON public.${table} AS RESTRICTIVE FOR DELETE TO ${group} USING (true)`
      );
      assert.deepEqual((await rls()).noPolicy, [
        `public.${table} ${group} DELETE`,
        `public.${table} ${group} SELECT`,
        `public.${table} ${member} DELETE`,
      ]);
      // a SELECT policy TO the group covers both for SELECT, not for DELETE; FOR ALL covers DELETE too
      await client.query(
        `CREATE POLICY probe_group ON public.${table} AS PERMISSIVE FOR SELECT TO ${group} USING (true)`
      );
      assert.deepEqual((await rls()).noPolicy, [
        `public.${table} ${group} DELETE`,
        `public.${table} ${member} DELETE`,
      ]);
      await client.query(
        `CREATE POLICY probe_all ON public.${table} AS PERMISSIVE FOR ALL TO ${group} USING (true)`
      );
      assert.deepEqual(await rls(), { noPolicy: [], noRls: [] });
      // a privilege of PUBLIC needs a policy TO PUBLIC
      await client.query(`GRANT INSERT ON public.${table} TO PUBLIC`);
      assert.deepEqual((await rls()).noPolicy, [
        `public.${table} PUBLIC INSERT`,
      ]);
      await client.query(
        `CREATE POLICY probe_public ON public.${table} AS PERMISSIVE FOR INSERT WITH CHECK (true)`
      );
      assert.deepEqual(await rls(), { noPolicy: [], noRls: [] });
      await client.query(`REVOKE INSERT ON public.${table} FROM PUBLIC`);
      // the real table: session without FORCE, or without the policy of a role that holds a grant, is reported
      await client.query("SAVEPOINT rls_probe");
      await client.query(
        "ALTER TABLE public.session NO FORCE ROW LEVEL SECURITY"
      );
      assert.deepEqual(await rls(), {
        noPolicy: [],
        noRls: ["public.session"],
      });
      await client.query("ROLLBACK TO SAVEPOINT rls_probe");
      await client.query(
        "DROP POLICY session_unverified_user_owner_select ON public.session"
      );
      await client.query(
        "DROP POLICY session_device_session_owner_delete ON public.session"
      );
      assert.deepEqual((await rls()).noPolicy, [
        "public.session polaris_device_session_owner DELETE",
        "public.session polaris_unverified_user_owner SELECT",
      ]);
      await client.query("ROLLBACK TO SAVEPOINT rls_probe");
      // no exception since 0098: Better Auth's tables and the auth audit without FORCE are reported like any other
      await client.query(
        "ALTER TABLE public.verification NO FORCE ROW LEVEL SECURITY"
      );
      await client.query(
        "ALTER TABLE public.auth_security_audit_event DISABLE ROW LEVEL SECURITY"
      );
      assert.deepEqual((await rls()).noRls, [
        "public.auth_security_audit_event",
        "public.verification",
      ]);
      await client.query("ROLLBACK TO SAVEPOINT rls_probe");
      // a new grant on one of them (a column of account to a group, PUBLIC on verification) has no policy, and Better Auth's
      // runtime without its policy on "user" is reported for each command (the logins of the runtimes, which vary with the
      // run, are left out of the comparison)
      await client.query(
        `GRANT SELECT (password) ON public.account TO ${group}`
      );
      await client.query("GRANT SELECT ON public.verification TO PUBLIC");
      await client.query('DROP POLICY user_auth_runtime_all ON public."user"');
      const known = new Set([group, member, "polaris_auth_runtime", "PUBLIC"]);
      assert.deepEqual(
        (await rls()).noPolicy.filter((finding) =>
          known.has(finding.split(" ")[1] ?? "")
        ),
        [
          `public.account ${group} SELECT`,
          `public.account ${member} SELECT`,
          "public.user polaris_auth_runtime DELETE",
          "public.user polaris_auth_runtime INSERT",
          "public.user polaris_auth_runtime SELECT",
          "public.user polaris_auth_runtime UPDATE",
          "public.verification PUBLIC SELECT",
        ]
      );
      await client.query("ROLLBACK TO SAVEPOINT rls_probe");
      // forcedTableOwnerWithoutBypass: a table with forced row security owned by a role without BYPASSRLS is reported (a data
      // migration of that owner would see zero rows); the same owner with BYPASSRLS is the control
      const bypass = async () =>
        (await findViolations(client)).forcedTableOwnerWithoutBypass;
      assert.deepEqual(await bypass(), []);
      // without SUPERUSER, ALTER … OWNER TO needs SET on the new owner and the new owner needs CREATE on the schema
      // (both undone with the savepoint)
      await client.query(
        `GRANT ${detached} TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE`
      );
      await client.query(`GRANT CREATE ON SCHEMA public TO ${detached}`);
      await client.query(`ALTER TABLE public.${table} OWNER TO ${detached}`);
      assert.deepEqual(await bypass(), [`public.${table} (${detached})`]);
      await client.query(`ALTER ROLE ${detached} BYPASSRLS`);
      assert.deepEqual(await bypass(), []);
      await client.query(`ALTER ROLE ${detached} NOBYPASSRLS`);
      // the table's owner is now the detached role
      await withGateRole(client, detached, () =>
        client.query(`ALTER TABLE public.${table} NO FORCE ROW LEVEL SECURITY`)
      );
      assert.deepEqual(await bypass(), []);
      await client.query("ROLLBACK TO SAVEPOINT rls_probe");
      assert.deepEqual(await rls(), { noPolicy: [], noRls: [] });

      // scopeWithoutWriter: a policy on a scope no function of its role writes is reported; one function of the role that
      // writes it is the control; a function of another owner that writes it is not
      const scopeTable = `${probe}_writer`;
      await client.query(`CREATE TABLE public.${scopeTable} (id integer)`);
      await client.query(
        `CREATE POLICY probe ON public.${scopeTable} AS PERMISSIVE FOR SELECT TO ${CONTROL_OWNER} USING (current_setting('app.owner_scope.probe_writer_id', true) = 'x')`
      );
      const unwritten = `public.${scopeTable}.probe (${CONTROL_OWNER}): app.owner_scope.probe_writer_id`;
      assert.deepEqual((await findViolations(client)).scopeWithoutWriter, [
        unwritten,
      ]);
      await client.query(
        `GRANT CREATE ON SCHEMA public TO ${CONTROL_OWNER}, polaris_onboarding_owner`
      );
      const writer = (name: string) =>
        `CREATE FUNCTION public.${probe}_${name}() RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $body$ BEGIN PERFORM pg_catalog.set_config( 'APP.owner_scope.probe_writer_id', 'x', true); END $body$`;
      await withGateRole(client, "polaris_onboarding_owner", () =>
        client.query(writer("other_owner"))
      );
      assert.deepEqual((await findViolations(client)).scopeWithoutWriter, [
        unwritten,
      ]);
      // a writer of the same owner that is only a comment, or that sets the scope for the session (false), does not count
      await withGateRole(client, CONTROL_OWNER, async () => {
        await client.query(
          `CREATE FUNCTION public.${probe}_commented() RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $body$ BEGIN\n  -- PERFORM pg_catalog.set_config('app.owner_scope.probe_writer_id', 'x', true);\n  NULL;\nEND $body$`
        );
        await client.query(
          `CREATE FUNCTION public.${probe}_session_wide() RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $body$ BEGIN PERFORM pg_catalog.set_config('app.owner_scope.probe_writer_id', 'x', false); END $body$`
        );
      });
      assert.deepEqual((await findViolations(client)).scopeWithoutWriter, [
        unwritten,
      ]);
      await withGateRole(client, CONTROL_OWNER, () =>
        client.query(writer("own_owner"))
      );
      assert.deepEqual((await findViolations(client)).scopeWithoutWriter, []);
      // the real owner: end_device_sessions without its set_config leaves the five policies of its owner without a writer
      await client.query(
        "GRANT CREATE ON SCHEMA public TO polaris_device_session_owner"
      );
      const body = (
        await client.query<{ definition: string }>(
          "SELECT pg_get_functiondef('public.end_device_sessions(uuid, text, boolean, boolean, text)'::regprocedure) AS definition"
        )
      ).rows[0]?.definition;
      assert.ok(body);
      const withoutScope = body.replace(DEVICE_SESSION_SCOPE_LINE, "");
      assert.notEqual(withoutScope, body);
      await withGateRole(client, "polaris_device_session_owner", () =>
        client.query(withoutScope)
      );
      assert.deepEqual((await findViolations(client)).scopeWithoutWriter, [
        "public.auth_security_audit_event.auth_security_audit_event_device_session_owner_insert (polaris_device_session_owner): app.owner_scope.device_session_user_id",
        "public.device_sessions.device_sessions_session_owner_select (polaris_device_session_owner): app.owner_scope.device_session_user_id",
        "public.devices.devices_session_owner_select (polaris_device_session_owner): app.owner_scope.device_session_user_id",
        "public.session.session_device_session_owner_delete (polaris_device_session_owner): app.owner_scope.device_session_user_id",
        "public.session.session_device_session_owner_select (polaris_device_session_owner): app.owner_scope.device_session_user_id",
      ]);
    });
    assertClean(await findViolations(client));
    tests.push(
      "a table of public a polaris_* role uses without row security enabled and forced (session, verification with NO FORCE and the auth audit with row security off too: no exception since 0098), a grant under FORCE with no permissive policy for the command (to the group and to the role that inherits it, not to one that only SETs to it; a restrictive policy or one of another command does not cover; PUBLIC needs TO PUBLIC; session without the policy of polaris_unverified_user_owner or of the DELETE of polaris_device_session_owner, a column of account granted to a group, SELECT of verification to PUBLIC, the user table without the policy of the auth runtime), a table with forced row security whose owner has no BYPASSRLS (not with it, nor without FORCE) and a policy on app.owner_scope.* whose role has no function that writes it (only in a comment, only for the session with false, only in a function of another owner, or end_device_sessions without its set_config, which leaves the five policies of its owner, the one of the audit too, without a writer) are reported; the policy TO the group or FOR ALL, the function of the same owner that writes the scope, and the database as migrated are clean"
    );

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
    const plantMembership = async (
      target: string,
      inherit: string,
      set: string,
      exact: boolean
    ) => {
      await client.query(
        `GRANT "${target}" TO ${runner} WITH INHERIT ${inherit}, SET ${set}`
      );
      const reached = (await findViolations(client)).ownerMembership;
      // a member of a superuser owner reaches every other owner through it, so only the target itself is asserted there
      if (exact) {
        assert.deepEqual(reached, [`${runner}->${target}`]);
      } else {
        assert.ok(reached.includes(`${runner}->${target}`));
      }
      await client.query(`REVOKE "${target}" FROM ${runner}`);
    };
    await plantMembership(otherOwner, "TRUE", "FALSE", true);
    await plantMembership(otherOwner, "FALSE", "TRUE", true);
    // a role cannot grant itself without SUPERUSER, so an owner that is not one plants the membership of the database
    // owner on a stand-in made the database owner for the time of the check: the clause on datdba finds it (its name
    // ends in no `_owner` and it has no attribute)
    const [superusers] = (
      await client.query<{ gate_user: boolean; original_owner: boolean }>(
        `SELECT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS gate_user,
                (SELECT rolsuper FROM pg_roles WHERE rolname = $1) AS original_owner`,
        [originalOwner]
      )
    ).rows;
    const gateUserIsSuperuser = superusers?.gate_user === true;
    assertSuperuserCasesProved(gateUserIsSuperuser, "definer-hardening");
    // the creator of the polaris_* roles: without SUPERUSER it holds an ADMIN-only edge on each (PostgreSQL 16+)
    const originalOwnerIsSuperuser = superusers?.original_owner === true;
    if (gateUserIsSuperuser) {
      await plantMembership(originalOwner, "TRUE", "FALSE", false);
      await plantMembership(originalOwner, "FALSE", "TRUE", false);
    } else {
      await client.query(
        `CREATE ROLE ${standInOwner} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`
      );
      standInOwnerCreated = true;
      // inherited, so the owner can hand the database back
      await client.query(
        `GRANT ${standInOwner} TO CURRENT_USER WITH INHERIT TRUE, SET TRUE`
      );
      await client.query(
        `ALTER DATABASE "${expectedDatabase}" OWNER TO ${standInOwner}`
      );
      ownerChanged = true;
      await plantMembership(standInOwner, "TRUE", "FALSE", false);
      await plantMembership(standInOwner, "FALSE", "TRUE", false);
      await client.query(
        `ALTER DATABASE "${expectedDatabase}" OWNER TO "${originalOwner}"`
      );
      ownerChanged = false;
      await client.query(`DROP ROLE ${standInOwner}`);
      standInOwnerCreated = false;
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
    // on Neon the role belongs to the platform and its owner has no ADMIN OPTION on it, so nobody here can plant the
    // membership; the check runs wherever the owner can (a superuser, or a Postgres where the gate created the role)
    const canGrantNeonSuperuser = (
      await client.query<{ admin: boolean }>(
        "SELECT pg_has_role('neon_superuser', 'USAGE WITH ADMIN OPTION') AS admin"
      )
    ).rows[0]?.admin;
    assert.ok(
      canGrantNeonSuperuser || !gateUserIsSuperuser,
      "a superuser gate user plants and checks the membership of neon_superuser"
    );
    if (canGrantNeonSuperuser) {
      await client.query(`GRANT neon_superuser TO ${runner}`);
      assert.deepEqual((await findViolations(client)).ownerMembership, [
        `${runner}->neon_superuser`,
      ]);
      await client.query(`REVOKE neon_superuser FROM ${runner}`);
    } else {
      console.log(
        "gate-note: definer-hardening: neon_superuser exists and the owner has no ADMIN OPTION on it; its planted membership was not checked"
      );
    }
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
    // an original owner that is not a superuser keeps its ADMIN-only edges on the runtime groups (PostgreSQL 16+ gives
    // them to the creator); no longer the database owner, nothing exempts them, and its attributes are reported too
    assert.deepEqual(
      (await findViolations(client)).privilegedRuntime,
      [
        `${runner} (database owner)`,
        ...(originalOwnerIsSuperuser
          ? []
          : [`${originalOwner} (CREATEROLE, REPLICATION or BYPASSRLS)`]),
      ].sort()
    );
    // an owner role that is a member of the database owner, with no attribute on that role: only the database-owner clause finds it
    await client.query(`CREATE ROLE ${dbOwnerMember} NOLOGIN NOSUPERUSER`);
    dbOwnerMemberCreated = true;
    // the control is empty, except (original owner not a superuser) the attributes of the original owner and of the roles it is a
    // member of, which its unexempted ADMIN-only edges on the runtime groups make reachable while it owns nothing
    const baseline = (await findOwnerAttributeViolations(client)).findings;
    if (originalOwnerIsSuperuser) {
      assert.deepEqual(baseline, []);
    } else {
      const explained = new Set([
        originalOwner,
        ...(
          await client.query<{ rolname: string }>(
            `SELECT g.rolname FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
              WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = $1) AND (m.inherit_option OR m.set_option)`,
            [originalOwner]
          )
        ).rows.map((row) => row.rolname),
      ]);
      assert.deepEqual(
        baseline.filter(
          (finding) => !explained.has(finding.split(": ")[0] ?? "")
        ),
        [],
        "only the original owner's own attributes, and those of its groups"
      );
    }
    await client.query(
      `GRANT ${runner} TO ${dbOwnerMember} WITH INHERIT TRUE, SET FALSE`
    );
    assert.deepEqual((await findOwnerAttributeViolations(client)).findings, [
      ...baseline,
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
    // without SUPERUSER nobody grants the database owner (a role does not administer itself) nor, on Neon, the platform's
    // neon_superuser; the check names any role an edge reaches, so the other targets prove it there
    const ungrantable: string[] = [];
    for (const target of [...ownerTargets]) {
      const grantable = (
        await client.query<{ admin: boolean }>(
          "SELECT pg_has_role($1, 'USAGE WITH ADMIN OPTION') AS admin",
          [target]
        )
      ).rows[0]?.admin;
      if (!grantable) {
        ungrantable.push(target);
        ownerTargets.splice(ownerTargets.indexOf(target), 1);
      }
    }
    // a superuser grants every role, and without one only the database owner and neon_superuser may be left out: a
    // target that silently drops anywhere else would shrink the check
    assert.deepEqual(
      ungrantable.filter(
        (target) =>
          isSuperuser ||
          (target !== originalOwner && target !== "neon_superuser")
      ),
      [],
      "the owner roles' edges are planted to every target the gate user can grant"
    );
    if (ungrantable.length > 0) {
      console.log(
        `gate-note: definer-hardening: the owner cannot grant ${ungrantable.join(", ")}; an owner role's edge to it was not planted`
      );
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
    // the grantor named: a superuser's REVOKE removes only its own grant, and the creator of the roles granted this one
    const readerGrantor = (
      await client.query<{ grantor: string }>(
        `SELECT m.grantor::regrole::text AS grantor FROM pg_auth_members m
          WHERE m.roleid = 'polaris_closed_export_reader'::regrole AND m.member = 'polaris_privacy_runtime'::regrole`
      )
    ).rows[0]?.grantor;
    assert.ok(readerGrantor);
    for (const [statement, floor] of [
      [`ALTER ROLE ${polarisOwner} RENAME TO ${renamedProbe}`, OWNER_FLOOR],
      [
        `REVOKE polaris_closed_export_reader FROM polaris_privacy_runtime GRANTED BY ${readerGrantor}`,
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

    // the fuzz of becomes: random graphs of throwaway roles, read back from the catalog (with any edge PostgreSQL adds itself),
    // where the CTE must answer what the closure of becomes-model.ts answers; each graph in a transaction that is rolled back
    const random = seededRandom(FUZZ_SEED);
    let rowsCompared = 0;
    let adminCases = 0;
    let superuserCases = 0;
    let ownerEdgeCases = 0;
    let memberOfOwnerCases = 0;
    for (let index = 0; index < FUZZ_CASES; index += 1) {
      const drawn = drawGraph(random, `${fuzzTag}${index}`, {
        allowSuperuser: isSuperuser,
        ...(isSuperuser ? { databaseOwner: originalOwner } : {}),
      });
      await inRolledBackTransaction(async () => {
        await client.query(
          [
            ...drawn.names.map(
              (name) =>
                `CREATE ROLE ${name} NOLOGIN ${name === drawn.superuser ? "SUPERUSER" : "NOSUPERUSER"}`
            ),
            ...drawn.edges.map(
              (edge) =>
                `GRANT "${edge.role}" TO "${edge.member}" WITH ADMIN ${edge.admin}, INHERIT ${edge.inherit}, SET ${edge.set}`
            ),
          ].join(";\n")
        );
        // the whole graph of the cluster, not only the drawn roles: a drawn role that reaches the database owner reaches what the
        // owner is a member of. The database owner is also an implicit member of pg_database_owner (no row in pg_auth_members).
        const catalog = await client.query<RoleEdge>(
          `SELECT m.rolname AS member, r.rolname AS role, a.admin_option AS admin, a.inherit_option AS inherit, a.set_option AS set
             FROM pg_auth_members a
             JOIN pg_roles m ON m.oid = a.member
             JOIN pg_roles r ON r.oid = a.roleid`
        );
        const allRoles = await client.query<{
          rolname: string;
          rolsuper: boolean;
        }>("SELECT rolname, rolsuper FROM pg_roles");
        const expected = modelBecomes(
          {
            databaseOwner: originalOwner as string,
            edges: [
              ...catalog.rows,
              {
                admin: false,
                inherit: true,
                member: originalOwner as string,
                role: "pg_database_owner",
                set: true,
              },
            ],
            roles: allRoles.rows.map((row) => row.rolname),
            superusers: new Set(
              allRoles.rows
                .filter((row) => row.rolsuper)
                .map((row) => row.rolname)
            ),
          },
          new RegExp(RUNTIME_GROUP_PATTERN),
          RUNTIME_LOGIN_PATTERN
        ).filter((row) =>
          drawn.names.includes(row.slice(0, row.indexOf("->")))
        );
        const actual = (await findBecomes(client))
          .filter((row) => drawn.names.includes(row.runtime))
          .map((row) => `${row.runtime}->${row.role}`)
          .sort();
        assert.deepEqual(
          actual,
          expected,
          `becomes and the closure differ on case ${index} of seed ${FUZZ_SEED}: ${JSON.stringify(drawn)}`
        );
        rowsCompared += actual.length;
      });
      adminCases += drawn.edges.some((edge) => edge.admin) ? 1 : 0;
      superuserCases += drawn.superuser ? 1 : 0;
      ownerEdgeCases += drawn.edges.some(
        (edge) => edge.member === originalOwner
      )
        ? 1
        : 0;
      memberOfOwnerCases += drawn.edges.some(
        (edge) => edge.role === originalOwner
      )
        ? 1
        : 0;
    }
    assert.ok(FUZZ_CASES >= 200 && adminCases > 0 && rowsCompared > 0);
    console.log(
      `gate-note: becomes fuzz seed ${FUZZ_SEED}: ${FUZZ_CASES} graphs, ${rowsCompared} rows compared, ${adminCases} with ADMIN OPTION, ${superuserCases} with a superuser, ${ownerEdgeCases} with the database owner's ADMIN-only edge, ${memberOfOwnerCases} with a role that is a member of the database owner`
    );
    assertClean(await findViolations(client));
    tests.push(
      `becomes equals the closure of becomes-model.ts on ${FUZZ_CASES} random graphs of 4 to 7 roles (seed ${FUZZ_SEED}, ${rowsCompared} rows${isSuperuser ? "" : "; without a superuser gate user, no superuser and no database owner's edge are drawn"})`
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
    if (standInOwnerCreated) {
      await cleanup("stand-in owner", `DROP ROLE IF EXISTS ${standInOwner}`);
    }
    if (reachCreated) {
      // DROP OWNED needs the privileges of the role, which an owner that is not a superuser has only by inheriting it
      await cleanup(
        "reach role membership",
        `GRANT ${reach} TO CURRENT_USER WITH INHERIT TRUE, SET FALSE, ADMIN FALSE`
      );
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
