import assert from "node:assert/strict";
import { Client } from "pg";
import {
  assertClean,
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
import { poolerPattern, sqlState } from "./sales-gate-support";

/**
 * The staging database check (ADR 0097), read-only: it changes nothing. It runs with the owner's direct URL
 * (`STAGING_MIGRATOR_DATABASE_URL`), never through the pooler, and refuses any database whose marker
 * (the database comment `polaris.environment=staging`, written once by the owner: Neon gives no superuser, see
 * `environment-marker.ts`) is not `staging`,
 * so a wrong URL never migrates or reads another environment.
 *
 * - `before-migrate`: the marker, and the migrator is the owner of the database and of schema public
 *   (release checklist, item 3: a REVOKE by someone else is only a WARNING, without effect).
 * - `after-migrate`: the marker; the read-only part of the definer-hardening gate (ADR 0093); PUBLIC has no
 *   TEMPORARY; and every login other than the owner is a member of a `polaris_*_runtime` group (item 15).
 *
 * The output lists names only: no URL, password or data.
 */
const STAGING = "staging";
// roles Neon creates and manages itself: not logins of the app
const PLATFORM_ROLE = /^(cloud_admin|neon_superuser|neon_service|pg_.*)$/;

type Phase = "after-migrate" | "before-migrate";

// The marker is the exact database comment (or the old stored form, for a superuser's database), never
// current_setting() alone: a connection option could fake that one.
async function checkMarker(client: Client) {
  const { rows } = await client.query<EnvironmentReadings>(
    ENVIRONMENT_MARKER_SQL
  );
  assert.equal(
    rows[0] ? declaredEnvironment(rows[0]) : null,
    STAGING,
    `the database marker ${markerComment(STAGING)} is missing or different: refusing to touch this database`
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
  return [
    `the migrator ${row.migrator} owns the database and schema public (${row.public_owner})`,
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
  const appLogins = logins.rows.filter((row) => !PLATFORM_ROLE.test(row.login));
  const orphans = appLogins
    .filter((row) => row.groups.length === 0)
    .map((row) => row.login);
  assert.deepEqual(
    orphans,
    [],
    "logins that are not members of a polaris_*_runtime group"
  );
  return [
    "definer-hardening (read-only): no finding",
    "PUBLIC has no TEMPORARY on the database",
    ...appLogins.map((row) => `login ${row.login}: ${row.groups.join(", ")}`),
  ];
}

async function run() {
  const phase = process.argv[2] as Phase | undefined;
  assert.ok(
    phase === "before-migrate" || phase === "after-migrate",
    "usage: verify-staging-database.ts before-migrate|after-migrate"
  );
  const url = process.env.STAGING_MIGRATOR_DATABASE_URL;
  assert.ok(url, "STAGING_MIGRATOR_DATABASE_URL is not set");
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
  // read-only from the start of the session: a stray write fails instead of changing staging
  const client = new Client({
    connectionString: url,
    options: "-c default_transaction_read_only=on",
  });
  await client.connect();
  try {
    await checkMarker(client);
    const results = [`marker ${markerComment(STAGING)}`];
    results.push(
      ...(phase === "before-migrate"
        ? await checkOwner(client)
        : await checkHardening(client))
    );
    console.log(JSON.stringify({ phase, results }, null, 2));
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
  console.error(`Staging database check failed (${message})`);
  process.exitCode = 1;
});
