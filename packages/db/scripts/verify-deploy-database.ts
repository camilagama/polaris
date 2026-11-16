import assert from "node:assert/strict";
import { Client } from "pg";
import { BACKUP_READER, readBackupReader } from "./backup-reader";
import {
  assertClean,
  findForcedTableOwnerWithoutBypass,
  findViolations,
  MIN_DEFINER_FUNCTIONS,
  RUNTIME_GROUP_PATTERN,
} from "./definer-hardening-checks";
import {
  declaredEnvironment,
  ENVIRONMENT_MARKER_SQL,
  type EnvironmentReadings,
  markerComment,
} from "./environment-marker";
import { assertOwnerRolesClean } from "./owner-role-attributes";
import {
  type DeployEnvironment,
  deployDatabaseTarget,
} from "./deploy-database-target";
import { poolerPattern, sqlState } from "./sales-gate-support";

/**
 * The deploy database check (ADR 0097), read-only: it changes nothing. It runs for staging (the default) or, with
 * `--env production`, for production, with the owner's direct URL of that environment (`STAGING_MIGRATOR_DATABASE_URL`
 * or `PRODUCTION_MIGRATOR_DATABASE_URL`, see `deploy-database-target.ts`), never through the pooler, and refuses any
 * database whose marker (the database comment `polaris.environment=<environment>`, written once by the owner: Neon
 * gives no superuser, see `environment-marker.ts`) is not the one of that environment,
 * so a wrong URL never migrates or reads another environment.
 *
 * - `before-migrate`: the marker, and the migrator is the owner of the database and of schema public
 *   (release checklist, item 3: a REVOKE by someone else is only a WARNING, without effect); and every table with forced
 *   row security belongs to a superuser or to a role with BYPASSRLS (`forcedTableOwnerWithoutBypass`): an owner without
 *   it would see zero rows in a data migration, so the deploy stops before migrating (and so does a migrator without it).
 * - `after-migrate`: the marker; the read-only part of the definer-hardening gate (ADR 0093), which includes that
 *   every SECURITY DEFINER function belongs to a `polaris_*_owner` role (`foreignOwner`: one left with the owner of the
 *   database runs with BYPASSRLS) and that the policies on `app.owner_scope.*` are each TO one owner role and read no
 *   setting of the runtime (`ownerScope`); that every table of public a `polaris_*` role uses has row security
 *   enabled and forced, with no exception since 0098 (`tableWithoutRowSecurity`), that the owner of every table with forced
 *   row security bypasses it (`forcedTableOwnerWithoutBypass`), that every grant under forced
 *   row security has a policy for its command (`rowSecurityWithoutPolicy`) and that every `app.owner_scope.*` read by a
 *   policy is written by a function of its owner (`scopeWithoutWriter`); PUBLIC has no TEMPORARY; every `polaris_*_owner` role and every role a runtime role reaches (the `*_runtime` groups and what they
 *   can SET to, inherit or administer with ADMIN OPTION, such as `polaris_closed_export_reader`) is NOLOGIN, NOSUPERUSER, NOCREATEROLE, NOCREATEDB,
 *   NOREPLICATION and NOBYPASSRLS, with a floor on how many were looked at, and no `*_owner` role is a member (INHERIT, SET or
 *   ADMIN OPTION) of any role (`owner-role-attributes.ts`); and every login other than the owner is a member of a
 *   `polaris_*_runtime` group (item 15), except the backup login `polaris_backup_reader`, which must have exactly the
 *   attributes of `backup-reader.ts` when it exists.
 *
 * The output lists names only: no URL, password or data.
 */
// roles Neon creates and manages itself: not logins of the app
const PLATFORM_ROLE = /^(cloud_admin|neon_superuser|neon_service|pg_.*)$/;

// The marker is the exact database comment (or the old stored form, for a superuser's database), never
// current_setting() alone: a connection option could fake that one.
async function checkMarker(client: Client, environment: DeployEnvironment) {
  const { rows } = await client.query<EnvironmentReadings>(
    ENVIRONMENT_MARKER_SQL
  );
  assert.equal(
    rows[0] ? declaredEnvironment(rows[0]) : null,
    environment,
    `the database marker ${markerComment(environment)} is missing or different: refusing to touch this database`
  );
}

async function checkOwner(client: Client) {
  const owner = await client.query<{
    database_owner: string;
    migrator: string;
    public_owner: string;
  }>(
    `SELECT pg_get_userbyid(d.datdba) AS database_owner,
            current_user AS migrator,
            pg_get_userbyid(n.nspowner) AS public_owner
       FROM pg_database d, pg_namespace n
      WHERE d.datname = current_database() AND n.nspname = 'public'`
  );
  const [row] = owner.rows;
  assert.ok(row);
  assert.equal(
    row.migrator,
    row.database_owner,
    "the migrator is not the database owner"
  );
  assert.ok(
    row.public_owner === "pg_database_owner" ||
      row.public_owner === row.migrator,
    "schema public belongs to another role than the migrator"
  );
  // with forced row security, a data migration sees rows only as a superuser or with BYPASSRLS (the role's own attribute)
  const bypass = await client.query<{ bypass: boolean }>(
    "SELECT rolsuper OR rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user"
  );
  assert.equal(
    bypass.rows[0]?.bypass,
    true,
    "the migrator is neither a superuser nor BYPASSRLS"
  );
  assert.deepEqual(
    await findForcedTableOwnerWithoutBypass(client),
    [],
    "tables with forced row security whose owner is neither a superuser nor BYPASSRLS (schema.table (owner))"
  );
  return [
    `the migrator ${row.migrator} owns the database and schema public (${row.public_owner})`,
    "the migrator and the owner of every table with forced row security are superusers or have BYPASSRLS",
  ];
}

async function checkHardening(client: Client) {
  // an empty or unmigrated database would have nothing to report: refuse it instead of passing
  const counts = await client.query<{ definers: number; groups: number }>(
    `SELECT (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE p.prosecdef AND n.nspname = 'public') AS definers,
            (SELECT count(*)::int FROM pg_roles WHERE rolname ~ $1) AS groups`,
    [RUNTIME_GROUP_PATTERN]
  );
  assert.ok(
    (counts.rows[0]?.definers ?? 0) >= MIN_DEFINER_FUNCTIONS,
    "fewer SECURITY DEFINER functions than the migrations create"
  );
  assert.ok((counts.rows[0]?.groups ?? 0) > 0, "no polaris_*_runtime group");
  assertClean(await findViolations(client));
  const temporary = await client.query<{ can_temp: boolean }>(
    "SELECT has_database_privilege('public', current_database(), 'TEMPORARY') AS can_temp"
  );
  assert.equal(temporary.rows[0]?.can_temp, false, "PUBLIC has TEMPORARY");
  const roles = await assertOwnerRolesClean(client);
  // every login the app uses belongs to a runtime group: the gate sees only those as runtime roles
  const logins = await client.query<{ groups: string[]; login: string }>(
    `SELECT r.rolname AS login,
            coalesce(array_agg(g.rolname::text ORDER BY g.rolname) FILTER (WHERE g.rolname ~ $1), '{}'::text[]) AS groups
       FROM pg_roles r
       LEFT JOIN pg_auth_members m ON m.member = r.oid
       LEFT JOIN pg_roles g ON g.oid = m.roleid
      WHERE r.rolcanlogin AND r.rolname <> current_user
      GROUP BY r.rolname
      ORDER BY 1`,
    [RUNTIME_GROUP_PATTERN]
  );
  const appLogins = logins.rows.filter(
    (row) => !(PLATFORM_ROLE.test(row.login) || row.login === BACKUP_READER)
  );
  const orphans = appLogins
    .filter((row) => row.groups.length === 0)
    .map((row) => row.login);
  assert.deepEqual(
    orphans,
    [],
    "logins that are not members of a polaris_*_runtime group"
  );
  const backupReader = await readBackupReader(client);
  assert.deepEqual(
    backupReader ?? [],
    [],
    `the backup login ${BACKUP_READER} is not exactly the documented one`
  );
  return [
    "definer-hardening (read-only): no finding (search_path, TEMPORARY, CREATE, runtime reach, PUBLIC EXECUTE, foreignOwner, ownerScope, tableWithoutRowSecurity, forcedTableOwnerWithoutBypass, rowSecurityWithoutPolicy, scopeWithoutWriter)",
    "PUBLIC has no TEMPORARY on the database",
    `${roles.owners} polaris_*_owner roles and ${roles.reachable} roles a runtime role reaches: NOLOGIN, NOSUPERUSER, NOCREATEROLE, NOCREATEDB, NOREPLICATION, NOBYPASSRLS`,
    `the ${roles.owners} polaris_*_owner roles are members of no role`,
    ...appLogins.map((row) => `login ${row.login}: ${row.groups.join(", ")}`),
    backupReader
      ? `login ${BACKUP_READER}: pg_read_all_data, BYPASSRLS, read-only, owns nothing`
      : `no backup login ${BACKUP_READER}`,
  ];
}

async function run() {
  const { environment, phase, url } = deployDatabaseTarget(
    process.argv.slice(2),
    process.env
  );
  // checked first: the parser's error may quote its input, and the input is the owner's URL
  if (!URL.canParse(url)) {
    throw new Error("the owner's URL is not a valid URL");
  }
  const parsed = new URL(url);
  assert.doesNotMatch(
    parsed.hostname,
    poolerPattern,
    "use the direct URL, not the pooler"
  );
  assert.ok(
    !parsed.searchParams.has("options"),
    "the URL must not carry connection options"
  );
  // read-only from the start of the session: a stray write fails instead of changing the environment
  const client = new Client({
    connectionString: url,
    options: "-c default_transaction_read_only=on",
  });
  await client.connect();
  try {
    await checkMarker(client, environment);
    const results = [`marker ${markerComment(environment)}`];
    results.push(
      ...(phase === "before-migrate"
        ? await checkOwner(client)
        : await checkHardening(client))
    );
    console.log(JSON.stringify({ environment, phase, results }, null, 2));
  } finally {
    await client.end();
  }
}

// name, SQLSTATE and message only: no stack, and never the URL
run().catch((error: unknown) => {
  const code = sqlState(error);
  const message =
    error instanceof Error
      ? `${error.name}${code ? `, ${code}` : ""}: ${error.message.replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted]")}`
      : "unknown failure";
  console.error(`Deploy database check failed (${message})`);
  process.exitCode = 1;
});
