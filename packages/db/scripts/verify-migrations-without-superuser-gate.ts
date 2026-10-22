// biome-ignore-all lint/performance/noAwaitInLoops: the setup, the replay and the teardown touch the cluster strictly one step at a time
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import {
  assertClean,
  findViolations,
  RUNTIME_GROUP_PATTERN,
} from "./definer-hardening-checks";
import { assertAllowedGateUrl } from "./gate-hosts";
import {
  gateBranchPattern,
  journalMigrationCount,
  redactedFailure,
  requiredEnvironment,
} from "./sales-gate-support";

/**
 * Every migration, replayed from scratch by an owner who is NOT a superuser, the way `db:migrate` runs on Neon.
 *
 * What it imitates (https://neon.com/docs/manage/roles): the owner of a Neon project, `neondb_owner`, is not a
 * PostgreSQL superuser. It is a member of `neon_superuser`, a built-in role that carries CREATEDB, CREATEROLE,
 * BYPASSRLS and REPLICATION and cannot log in, and it owns its database and the `public` schema. So here the
 * migrator is a login role with CREATEROLE, CREATEDB, REPLICATION and BYPASSRLS and without SUPERUSER, a member of
 * a `neon_superuser` with the same four attributes, the owner of a fresh database and of its `public` schema. It
 * holds the attributes itself, not only through the membership: PostgreSQL lets a role take an attribute away
 * from another only when the role has it (the staging probe agrees: NOCREATEDB, NOREPLICATION and NOBYPASSRLS
 * pass in an `ALTER ROLE` there). The CI service container makes `neondb_owner` a superuser (POSTGRES_USER), which
 * hides every command only a superuser can run: staging stopped at 0075 on `ALTER ROLE … NOSUPERUSER` (42501,
 * `permission denied to alter role`).
 *
 * Roles belong to the cluster, not to the database, and the gate database was already migrated by a superuser, so
 * a replay in a second database would find the `polaris_*` roles in place, skip their `CREATE ROLE` and fail on the
 * `ALTER ROLE` of a role it does not administer, which is not what Neon does on a first run. So the gate parks the
 * existing `polaris_*` roles under another name (`ALTER ROLE … RENAME`; the objects follow by OID), replays in a
 * scratch database, drops the scratch database and the roles the replay made, and gives the names back, so the
 * gates after it find the cluster as it was. It needs a cluster of its own for the time it runs (the CI job's service
 * container; locally, no other task on the same Postgres). A run that dies without its `finally` (SIGKILL, the
 * runner's timeout) is repaired by the next one: it drops the scratch databases and the owner it left and
 * gives back the parked names (they carry a fixed prefix). Local Postgres only: it needs a real superuser.
 *
 * The replay is the real command (`bun run db:migrate` of this package, drizzle-kit), so a refusal is the one the
 * staging deploy would hit; the error of the failing migration is printed first.
 *
 * After the replay the gate runs the read-only definer-hardening checks, the ones `staging:verify-database after-migrate`
 * runs on Neon. PostgreSQL 16+ makes a non-superuser with CREATEROLE a member WITH ADMIN OPTION, INHERIT FALSE, SET FALSE of
 * every role it creates, so the owner is an ADMIN-only member of every `polaris_*` role here too (the gate asserts the
 * edges exist, so the proof cannot pass by their absence); such an edge is not a runtime login, and the checks must pass.
 * The control: the same owner with INHERIT or SET on a `*_runtime` group is a runtime login that is the database owner,
 * and the checks must report it.
 *
 * The guard that replaced NOSUPERUSER in the `ALTER ROLE` of a migration (a `DO` that raises when the role is a
 * superuser) is proven by the negative path: for every `ALTER ROLE` of the migrations, the gate makes the role a
 * superuser in the scratch database and runs the statement again, which must fail on the guard.
 */
const PARKED_PREFIX = "zz_parked_";
const OWNER = "gate_migrator_nosuper";
const NEON_SUPERUSER = "neon_superuser";
const SCRATCH_PREFIX = "polaris_nosuper_";
const RUNNER_PREFIX = "polaris_gate_runner_";
const lineBreak = /\r?\n/;
const statementBreakpoint = /-->\s*statement-breakpoint/;
const alterRole = /\bALTER ROLE (\w+)/g;
const urlPattern = /postgres(?:ql)?:\/\/\S+/gi;
const identifier = /^\w+$/;
const superuserInAlter = /ALTER ROLE \w+[^;']*\bNOSUPERUSER\b/;
const guardMessage = /must not be a superuser/;
const errorWord = /error/i;

const drizzleDirectory = fileURLToPath(new URL("../drizzle", import.meta.url));
const packageDirectory = fileURLToPath(new URL("..", import.meta.url));

function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

async function rolesWhere(
  admin: Client,
  where: string,
  value: string
): Promise<string[]> {
  const { rows } = await admin.query<{ rolname: string }>(
    `SELECT rolname FROM pg_catalog.pg_roles WHERE ${where} ORDER BY rolname`,
    [value]
  );
  return rows.map((row) => row.rolname);
}

const roleExists = async (admin: Client, name: string) =>
  (await rolesWhere(admin, "rolname = $1", name)).length > 0;

/** Every `polaris_*` role except the login of the gate runner, as `name -> oid`. */
async function polarisRoles(admin: Client): Promise<Map<string, string>> {
  const { rows } = await admin.query<{ oid: string; rolname: string }>(
    `SELECT oid::text AS oid, rolname FROM pg_catalog.pg_roles
      WHERE rolname LIKE 'polaris\\_%' AND rolname NOT LIKE $1`,
    [`${RUNNER_PREFIX.replaceAll("_", "\\_")}%`]
  );
  return new Map(rows.map((row) => [row.rolname, row.oid]));
}

/** What a killed run leaves behind: its scratch databases, its owner and its parked names. */
async function repairLeftovers(admin: Client): Promise<void> {
  const databases = await admin.query<{ datname: string }>(
    "SELECT datname FROM pg_catalog.pg_database WHERE datname LIKE $1",
    [`${SCRATCH_PREFIX.replaceAll("_", "\\_")}%`]
  );
  for (const { datname } of databases.rows) {
    await admin.query(`DROP DATABASE ${quote(datname)} WITH (FORCE)`);
  }
  if (databases.rows.length > 0 || (await roleExists(admin, OWNER))) {
    await admin.query(`DROP ROLE IF EXISTS ${OWNER}`);
  }
  const parked = await rolesWhere(
    admin,
    "rolname LIKE $1",
    `${PARKED_PREFIX.replaceAll("_", "\\_")}%`
  );
  for (const name of parked) {
    const original = name.slice(PARKED_PREFIX.length);
    // a role made by the scratch replay holds the name: it is not the real one
    if (await roleExists(admin, original)) {
      await admin.query(`DROP ROLE ${quote(original)}`);
    }
    await admin.query(`ALTER ROLE ${quote(name)} RENAME TO ${quote(original)}`);
  }
}

/** The `DO` blocks of the migrations that run an `ALTER ROLE`, with the role they alter. */
function alterRoleBlocks(): Array<{
  block: string;
  file: string;
  role: string;
}> {
  const found: Array<{ block: string; file: string; role: string }> = [];
  for (const file of readdirSync(drizzleDirectory).sort()) {
    if (!file.endsWith(".sql")) {
      continue;
    }
    const text = readFileSync(`${drizzleDirectory}/${file}`, "utf8");
    for (const block of text.split(statementBreakpoint)) {
      for (const match of block.matchAll(alterRole)) {
        found.push({ block, file, role: match[1] as string });
      }
    }
  }
  return found;
}

/** Connects with a failure handler: an idle connection that drops must not end the process before the teardown. */
async function connect(url: string): Promise<Client> {
  const client = new Client({ connectionString: url });
  client.on("error", (error) => {
    console.error(`connection error (${redactedFailure(error)})`);
    process.exitCode = 1;
  });
  await client.connect();
  return client;
}

function withDatabase(url: URL, database: string): string {
  const copy = new URL(url.toString());
  copy.pathname = `/${database}`;
  return copy.toString();
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one linear script of setup, replay, proofs and a teardown that must always run
async function run() {
  const branch = requiredEnvironment("POLARIS_SALES_GATE_BRANCH");
  assert.match(branch, gateBranchPattern);
  const adminUrl = assertAllowedGateUrl(
    requiredEnvironment("POLARIS_SALES_GATE_DATABASE_URL"),
    true
  );
  assert.ok(
    adminUrl.hostname === "localhost" || adminUrl.hostname === "127.0.0.1",
    "this gate runs only against the local Postgres of the job (it needs a real superuser)"
  );

  const admin = await connect(adminUrl.toString());
  const scratch = `${SCRATCH_PREFIX}${randomBytes(6).toString("hex")}`;
  assert.match(scratch, identifier);
  const password = randomBytes(24).toString("hex");
  let databaseCreated = false;
  let ownerCreated = false;
  let neonCreated = false;
  let realRoles = new Map<string, string>();
  let parkingDone = false;
  const renamed: string[] = [];
  let summary: Record<string, unknown> | undefined;
  try {
    const { rows } = await admin.query<{
      rolsuper: boolean;
      server_version_num: string;
    }>(
      `SELECT rolsuper, current_setting('server_version_num') AS server_version_num
         FROM pg_catalog.pg_roles WHERE rolname = current_user`
    );
    assert.equal(rows[0]?.rolsuper, true, "the gate admin must be a superuser");
    assert.ok(Number(rows[0]?.server_version_num) >= 180_000);

    await repairLeftovers(admin);
    realRoles = await polarisRoles(admin);
    for (const name of realRoles.keys()) {
      await admin.query(
        `ALTER ROLE ${quote(name)} RENAME TO ${quote(PARKED_PREFIX + name)}`
      );
      renamed.push(name);
    }
    assert.equal((await polarisRoles(admin)).size, 0);
    parkingDone = true;

    if (await roleExists(admin, NEON_SUPERUSER)) {
      const existing = await admin.query<{ ok: boolean }>(
        `SELECT rolcreatedb AND rolcreaterole AND rolbypassrls AND rolreplication AND NOT rolsuper AS ok
           FROM pg_catalog.pg_roles WHERE rolname = $1`,
        [NEON_SUPERUSER]
      );
      assert.equal(
        existing.rows[0]?.ok,
        true,
        "a neon_superuser exists in the cluster without CREATEDB, CREATEROLE, BYPASSRLS and REPLICATION (or it is a superuser)"
      );
    } else {
      await admin.query(
        `CREATE ROLE ${NEON_SUPERUSER} NOLOGIN NOSUPERUSER CREATEDB CREATEROLE BYPASSRLS REPLICATION`
      );
      neonCreated = true;
    }
    await admin.query(
      `CREATE ROLE ${OWNER} WITH LOGIN INHERIT CREATEROLE CREATEDB REPLICATION BYPASSRLS NOSUPERUSER PASSWORD '${password}'`
    );
    ownerCreated = true;
    await admin.query(`GRANT ${NEON_SUPERUSER} TO ${OWNER}`);
    await admin.query(`CREATE DATABASE ${scratch} OWNER ${OWNER}`);
    databaseCreated = true;

    const scratchAdminUrl = withDatabase(adminUrl, scratch);
    const ownerUrl = new URL(scratchAdminUrl);
    ownerUrl.username = OWNER;
    ownerUrl.password = password;
    const scratchAdmin = await connect(scratchAdminUrl);
    try {
      await scratchAdmin.query(`ALTER SCHEMA public OWNER TO ${OWNER}`);
    } finally {
      await scratchAdmin.end();
    }
    const asOwner = await connect(ownerUrl.toString());
    try {
      const self = await asOwner.query<{ rolsuper: boolean }>(
        "SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user"
      );
      assert.equal(
        self.rows[0]?.rolsuper,
        false,
        "the migrator is no superuser"
      );
      // the runtime role that lives outside the migrations (the CI creates it before the replay)
      await asOwner.query(
        "CREATE ROLE polaris_pr11_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS"
      );
    } finally {
      await asOwner.end();
    }

    const replay = spawnSync(process.execPath, ["run", "db:migrate"], {
      cwd: packageDirectory,
      encoding: "utf8",
      env: {
        DATABASE_URL: ownerUrl.toString(),
        HOME: process.env.HOME ?? "",
        PATH: process.env.PATH ?? "",
      },
      timeout: 15 * 60_000,
    });
    if (replay.error || replay.signal || replay.status !== 0) {
      const output = `${replay.stdout ?? ""}\n${replay.stderr ?? ""}`
        .replace(urlPattern, "[redacted]")
        .replaceAll(password, "[redacted]");
      const lines = output.trim().split(lineBreak);
      const errorLine = lines.findIndex((line) => errorWord.test(line));
      const tail = lines
        .slice(Math.max(errorLine, 0), Math.max(errorLine, 0) + 25)
        .join("\n");
      throw new Error(
        `db:migrate as a non-superuser owner failed (exit ${replay.status}, signal ${replay.signal}, ${replay.error?.message ?? "no spawn error"}). A command in a migration that only a superuser can run:\n${tail}`
      );
    }

    const verify = await connect(ownerUrl.toString());
    try {
      const applied = await verify.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations"
      );
      assert.equal(
        Number(applied.rows[0]?.count),
        journalMigrationCount(),
        "every migration of the journal ran"
      );
      const adminEdges = await verify.query<{
        groups: string;
        only_admin: string;
      }>(
        `SELECT count(*)::text AS groups,
                count(*) FILTER (WHERE m.admin_option AND NOT m.inherit_option AND NOT m.set_option)::text AS only_admin
           FROM pg_catalog.pg_auth_members m
           JOIN pg_catalog.pg_roles g ON g.oid = m.roleid
           JOIN pg_catalog.pg_roles u ON u.oid = m.member
          WHERE u.rolname = $1 AND g.rolname ~ $2`,
        [OWNER, RUNTIME_GROUP_PATTERN]
      );
      const [edges] = adminEdges.rows;
      assert.ok(
        Number(edges?.groups) > 0 && edges?.groups === edges?.only_admin,
        "the owner is an ADMIN-only member (no INHERIT, no SET) of every runtime group it created"
      );
      assertClean(await findViolations(verify));
      // the control: INHERIT or SET on a runtime group makes the owner a runtime login, which is the database owner
      const [group] = await rolesWhere(
        verify,
        "rolname ~ $1",
        RUNTIME_GROUP_PATTERN
      );
      assert.ok(group, "a runtime group the owner administers");
      for (const option of [
        "INHERIT TRUE, SET FALSE",
        "INHERIT FALSE, SET TRUE",
      ]) {
        await verify.query("BEGIN");
        try {
          await verify.query(
            `GRANT ${quote(group)} TO ${OWNER} WITH ${option}`
          );
          assert.ok(
            (await findViolations(verify)).privilegedRuntime.includes(
              `${OWNER} (database owner)`
            ),
            `an owner with ${option} on ${group} is not reported`
          );
        } finally {
          await verify.query("ROLLBACK").catch(() => undefined);
        }
      }
      assertClean(await findViolations(verify));
      const risky = await verify.query<{ rolname: string }>(
        `SELECT rolname FROM pg_catalog.pg_roles
          WHERE rolname LIKE 'polaris\\_%' AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls)
          ORDER BY rolname`
      );
      assert.deepEqual(
        risky.rows.map((row) => row.rolname),
        [],
        "no polaris role the migrations made is a superuser or carries a creation, replication or bypass attribute"
      );
    } finally {
      await verify.end();
    }

    // the negative path of the guard that replaced NOSUPERUSER: a role that is a superuser makes the statement fail
    const blocks = alterRoleBlocks();
    assert.ok(
      blocks.length >= 9,
      "the migrations with an ALTER ROLE were read"
    );
    const prober = await connect(scratchAdminUrl);
    try {
      for (const { block, file, role } of blocks) {
        assert.match(role, identifier);
        assert.doesNotMatch(
          block,
          superuserInAlter,
          `${file}: an ALTER ROLE with NOSUPERUSER is refused to the owner on Neon`
        );
        await prober.query("BEGIN");
        try {
          await prober.query(`ALTER ROLE ${quote(role)} SUPERUSER`);
          await assert.rejects(
            prober.query(block),
            guardMessage,
            `${file}: the statement runs on a superuser ${role} without the guard failing`
          );
        } finally {
          await prober.query("ROLLBACK");
        }
      }
    } finally {
      await prober.end();
    }

    summary = {
      branch,
      migrations: journalMigrationCount(),
      status: "passed",
      tests: [
        "every migration replays from scratch as a login owner with CREATEROLE and no SUPERUSER, member of a neon_superuser with CREATEDB, CREATEROLE, BYPASSRLS and REPLICATION, owner of the database and of public",
        "no polaris role the migrations made carries SUPERUSER, CREATEROLE, CREATEDB, REPLICATION or BYPASSRLS",
        "the read-only definer-hardening checks of the staging after-migrate pass with the owner an ADMIN-only member of every runtime group, and report the same owner with INHERIT or SET on one",
        "every ALTER ROLE of the migrations is guarded: with the role made a superuser the statement fails",
      ],
    };
  } finally {
    // a failure here must not hide the one of the replay, and the parked names must come back whatever happens
    const cleanup = async (sql: string) => {
      await admin.query(sql).catch((error: unknown) => {
        console.error(
          `cleanup step failed: ${sql} (${redactedFailure(error)})`
        );
        process.exitCode = 1;
      });
    };
    if (databaseCreated) {
      await cleanup(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
    }
    if (parkingDone) {
      // only the roles the replay made: the real ones carry the parked names now, by their OIDs
      const real = new Set(realRoles.values());
      for (const [name, oid] of await polarisRoles(admin).catch(
        () => new Map<string, string>()
      )) {
        if (!real.has(oid)) {
          await cleanup(`DROP ROLE IF EXISTS ${quote(name)}`);
        }
      }
    }
    if (ownerCreated) {
      await cleanup(`DROP ROLE IF EXISTS ${OWNER}`);
    }
    if (neonCreated) {
      await cleanup(`DROP ROLE IF EXISTS ${NEON_SUPERUSER}`);
    }
    for (const name of renamed) {
      await cleanup(
        `ALTER ROLE ${quote(PARKED_PREFIX + name)} RENAME TO ${quote(name)}`
      );
    }
    await admin.end().catch(() => undefined);
  }
  assert.ok(!process.exitCode, "the teardown of the scratch database failed");
  console.log(JSON.stringify(summary, null, 2));
}

run().catch((error: unknown) => {
  console.error(
    `Migrations without superuser PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
